import { readFile } from 'node:fs/promises'
import type { Readable, Writable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { Client, utils as ssh2Utils } from 'ssh2'
import type {
  ClientChannel,
  ConnectConfig,
  ExecOptions,
  KeyboardInteractiveCallback,
  Prompt,
  SFTPWrapper,
  X11Options
} from 'ssh2'
import type {
  AppErrorPayload,
  DirListing,
  FileEntry,
  HostKeyRecord,
  PathStyle,
  SessionDescriptor,
  SessionKind,
  SessionStatus,
  SshConnectRequest,
  ToastLevel
} from '@shared/types'
import { AppError, toErrorPayload } from '../errors'
import { SftpBackend } from '../files/sftp-backend'
import type { FileBackend, WriteOptions } from '../files/types'
import { hostKeyInfo } from '../security/hostkeys'
import type { ConfigStore, StoredSecret } from '../store/types'
import { DataBatcher } from '../util/batcher'
import { mapSftpError, mapSshClientError } from '../util/ssh-errors'
import { joinPath } from '../util/paths'
import { X11Forwarder } from '../x11/forwarder'
import type { X11Service, X11Session } from '../x11/service'
import type { Session, SessionEventSink } from './types'

const TERM = 'xterm-256color'
const KEEPALIVE_INTERVAL_MS = 15_000
const KEEPALIVE_COUNT_MAX = 3
const SOCKET_CONNECT_TIMEOUT_MS = 30_000
const DETECT_TIMEOUT_MS = 3_000
const SFTP_OPEN_TIMEOUT_MS = 6_000
const INTEGRATION_PROBE_MS = 350
const CLOSE_GRACE_MS = 500

const POSIX_STYLE: PathStyle = 'posix'

const SHELL_KINDS = new Set(['bash', 'zsh', 'fish'])
const WINDOWS_OS_HINT = /(windows|cygwin|mingw|msys|wsl)/i

/* -------------------------------------------------------------------------- */
/* Shell integration scripts (written to the remote host via SFTP)            */
/* -------------------------------------------------------------------------- */

const BASH_INIT = `# TermShelf remote shell integration (bash)
if [ -f "$HOME/.bashrc" ]; then
  . "$HOME/.bashrc"
fi
__termshelf_osc7() {
  printf '\\033]7;file://%s%s\\007' "\${HOSTNAME:-$(hostname 2>/dev/null)}" "$PWD"
}
case ";\${PROMPT_COMMAND:-};" in
  *";__termshelf_osc7;"*) ;;
  *) PROMPT_COMMAND="__termshelf_osc7\${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;;
esac
__termshelf_osc7
`

function zshEnvInit(): string {
  return `# TermShelf remote shell integration (zsh)
if [ -f "$HOME/.zshenv" ]; then
  . "$HOME/.zshenv"
fi
`
}

const ZSH_PROFILE = `# TermShelf remote shell integration (zsh profile)
if [ -f "$HOME/.zprofile" ]; then
  . "$HOME/.zprofile"
fi
`

const ZSH_RC = `# TermShelf remote shell integration (zsh rc)
if [ -f "$HOME/.zshrc" ]; then
  . "$HOME/.zshrc"
fi
__termshelf_osc7() {
  printf '\\033]7;file://%s%s\\007' "\${HOST:-$(hostname 2>/dev/null)}" "$PWD"
}
if autoload -Uz add-zsh-hook 2>/dev/null; then
  add-zsh-hook precmd __termshelf_osc7
else
  precmd_functions=(\${precmd_functions[@]} __termshelf_osc7)
fi
__termshelf_osc7
`

const ZSH_LOGIN = `# TermShelf remote shell integration (zsh login)
if [ -f "$HOME/.zlogin" ]; then
  . "$HOME/.zlogin"
fi
`

const FISH_INIT = `# TermShelf remote shell integration (fish)
function __termshelf_osc7 --on-event fish_prompt
    printf '\\033]7;file://%s%s\\007' (hostname) $PWD
end
__termshelf_osc7
`

/* -------------------------------------------------------------------------- */
/* FileBackend used when a session has SSH but no SFTP subsystem              */
/* -------------------------------------------------------------------------- */

/**
 * Placeholder filesystem backend for SSH sessions where the SFTP subsystem
 * could not be opened. The terminal keeps working; every filesystem call fails
 * with {@link AppError} code `SSH_SFTP_UNAVAILABLE`.
 */
export class NullSftpBackend implements FileBackend {
  readonly pathStyle: PathStyle = POSIX_STYLE
  readonly isLocal = false
  private readonly reason: string

  constructor(reason = 'SFTP is not available for this SSH session') {
    this.reason = reason
  }

  private failure(operation: string): AppError {
    return new AppError('SSH_SFTP_UNAVAILABLE', `${this.reason} (${operation})`, { operation })
  }

  async home(): Promise<string> {
    throw this.failure('home')
  }

  async list(_path: string): Promise<DirListing> {
    throw this.failure('list')
  }

  async stat(_path: string): Promise<FileEntry> {
    throw this.failure('stat')
  }

  async realpath(_path: string): Promise<string> {
    throw this.failure('realpath')
  }

  async mkdir(_parentPath: string, _name: string): Promise<string> {
    throw this.failure('mkdir')
  }

  async rename(_path: string, _newName: string): Promise<string> {
    throw this.failure('rename')
  }

  async remove(_paths: string[], _recursive: boolean): Promise<void> {
    throw this.failure('remove')
  }

  createReadStream(_path: string): Readable {
    throw this.failure('read')
  }

  createWriteStream(_path: string, _options?: WriteOptions): Writable {
    throw this.failure('write')
  }

  async setTimes(_path: string, _mtimeMs: number): Promise<void> {
    throw this.failure('setTimes')
  }
}

/* -------------------------------------------------------------------------- */
/* Small SFTP helpers used for shell-integration bootstrap files              */
/* -------------------------------------------------------------------------- */

function sftpCallSftp(
  target: string,
  operation: Parameters<typeof mapSftpError>[2],
  invoke: (done: (error: Error | null | undefined) => void) => void
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    try {
      invoke((error) => {
        if (error) reject(mapSftpError(error, target, operation))
        else resolve()
      })
    } catch (error) {
      reject(mapSftpError(error, target, operation))
    }
  })
}

function remoteMkdir(sftp: SFTPWrapper, target: string): Promise<void> {
  return sftpCallSftp(target, 'mkdir', (done) => sftp.mkdir(target, done))
}

function remoteUnlink(sftp: SFTPWrapper, target: string): Promise<void> {
  return sftpCallSftp(target, 'unlink', (done) => sftp.unlink(target, done))
}

function remoteRmdir(sftp: SFTPWrapper, target: string): Promise<void> {
  return sftpCallSftp(target, 'rmdir', (done) => sftp.rmdir(target, done))
}

function remoteWriteFile(sftp: SFTPWrapper, target: string, content: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    sftp.writeFile(target, content, { mode: 0o600 }, (error) => {
      if (error) reject(mapSftpError(error, target, 'open'))
      else resolve()
    })
  })
}

function remoteTestReadable(sftp: SFTPWrapper, target: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    sftp.stat(target, (error) => {
      if (error) reject(mapSftpError(error, target, 'stat'))
      else resolve()
    })
  })
}

/* -------------------------------------------------------------------------- */
/* Shell path helpers                                                         */
/* -------------------------------------------------------------------------- */

/** POSIX single-quote escaping for bash/zsh command strings. */
function posixQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** fish single-quote escaping (only `'` and `\\` are special inside single quotes). */
function fishQuote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

function remoteBasename(value: string): string {
  const trimmed = value.replace(/\/+$/, '')
  const index = trimmed.lastIndexOf('/')
  return index === -1 ? trimmed : trimmed.slice(index + 1)
}

function remoteShellKind(shellPath: string): string {
  const name = remoteBasename(shellPath).toLowerCase()
  return SHELL_KINDS.has(name) ? name : 'other'
}

function isUsableRemoteShellPath(shellPath: string): boolean {
  if (!shellPath || !shellPath.startsWith('/') || shellPath.includes('\0')) return false
  if (/[\r\n]/.test(shellPath)) return false
  return true
}

interface RemoteShellInfo {
  shellPath: string
  osName: string
  kind: 'bash' | 'zsh' | 'fish' | 'other'
  integrable: boolean
}

interface IntegrationPlan {
  kind: 'bash' | 'zsh' | 'fish'
  command: string
}

interface Credentials {
  password?: string
  passphrase?: string
  privateKey?: Buffer
  agent?: string
}

interface HostKeyFailure {
  kind: 'unknown' | 'mismatch'
  info: ReturnType<typeof hostKeyInfo>
  expected?: HostKeyRecord
}

export interface SshSessionOptions {
  id: string
  request: SshConnectRequest
  store: ConfigStore
  emit: SessionEventSink
  x11: X11Service
}

/**
 * SSH-backed terminal session.
 *
 * Responsibilities: connect with ssh2 (host-key verification against the known
 * hosts store, password/private-key/agent auth), open the SFTP subsystem for the
 * file sidebar, spawn an interactive remote shell (with a best-effort OSC 7
 * shell-integration wrapper), and reconnect/dispose cleanly.
 */
export class SshSession implements Session {
  readonly id: string
  readonly kind: SessionKind = 'ssh'

  private readonly request: SshConnectRequest
  private readonly store: ConfigStore
  private readonly emitSink: SessionEventSink
  private readonly x11: X11Service
  private readonly title: string
  private x11Session: X11Session | null = null
  private x11Forwarder: X11Forwarder | null = null
  private x11Label: string | null = null
  private x11Notified = false
  private lastExecError: string | null = null

  private client: Client | null = null
  private channel: ClientChannel | null = null
  private sftp: SFTPWrapper | null = null
  private sftpBackend: FileBackend = new NullSftpBackend('Not connected')
  private batcher: DataBatcher | null = null
  private stdoutDecoder: StringDecoder | null = null
  private stderrDecoder: StringDecoder | null = null

  private status: SessionStatus = 'connecting'
  private homePath: string | null = null
  private cols: number
  private rows: number
  private disposed = false
  private probing = false
  private lastClientError: AppError | null = null

  private hostKeyFailure: HostKeyFailure | null = null
  private pendingAuthError: AppError | null = null
  private resolvedPassword: string | undefined
  private resolvedPassphrase: string | undefined

  private remoteTempFiles: string[] = []
  private remoteTempDirs: string[] = []

  get backend(): FileBackend {
    return this.sftpBackend
  }

  constructor(options: SshSessionOptions) {
    this.id = options.id
    this.request = options.request
    this.store = options.store
    this.emitSink = options.emit
    this.x11 = options.x11
    this.cols = Math.max(2, Math.trunc(options.request.cols) || 80)
    this.rows = Math.max(2, Math.trunc(options.request.rows) || 24)
    const profileName = options.request.profile.name?.trim()
    this.title = profileName && profileName.length > 0 ? profileName : this.defaultTitle()
  }

  private defaultTitle(): string {
    const profile = this.request.profile
    return `${profile.username}@${profile.host}`
  }

  descriptor(): SessionDescriptor {
    return {
      id: this.id,
      kind: this.kind,
      environment: 'ssh',
      title: this.title,
      status: this.status,
      pathStyle: POSIX_STYLE,
      homePath: this.homePath
    }
  }

  async start(): Promise<SessionDescriptor> {
    this.disposed = false
    this.status = 'connecting'
    this.emitState()
    try {
      await this.connectAndStart()
      this.status = 'connected'
      this.emitState()
      return this.descriptor()
    } catch (error) {
      const appError = this.asAppError(error)
      this.status = 'error'
      this.emitState(appError.toPayload())
      await this.teardownConnection()
      throw appError
    }
  }

  async reconnect(): Promise<SessionDescriptor> {
    if (this.disposed) {
      throw new AppError('SSH_DISCONNECTED', 'This session has been closed')
    }
    this.status = 'connecting'
    this.emitState()
    await this.teardownConnection()
    try {
      await this.connectAndStart()
      this.status = 'connected'
      this.emitState()
      return this.descriptor()
    } catch (error) {
      const appError = this.asAppError(error)
      this.status = 'error'
      this.emitState(appError.toPayload())
      await this.teardownConnection()
      throw appError
    }
  }

  write(data: string): void {
    if (this.disposed || this.status !== 'connected' || !this.channel) return
    try {
      this.channel.write(data)
    } catch {
      // The channel may have closed between the status check and the write.
    }
  }

  resize(cols: number, rows: number): void {
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 2 || rows < 2) return
    this.cols = Math.trunc(cols)
    this.rows = Math.trunc(rows)
    const channel = this.channel
    if (!channel) return
    try {
      channel.setWindow(this.rows, this.cols, 0, 0)
    } catch {
      // resize races with channel teardown are harmless
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.releaseDecoders()
    await this.teardownConnection()
    this.status = 'ended'
  }

  /* ------------------------------------------------------------------------ */
  /* Connection setup                                                         */
  /* ------------------------------------------------------------------------ */

  private async connectAndStart(): Promise<void> {
    this.hostKeyFailure = null
    this.pendingAuthError = null
    this.lastClientError = null
    this.resolvedPassword = undefined
    this.resolvedPassphrase = undefined

    const profileId = await this.persistProfile()
    const credentials = await this.resolveCredentials(profileId)
    await this.openConnection(credentials)
    this.assertActive()
    await this.attachBackend()
    this.assertActive()
    await this.prepareX11Forwarding()
    this.assertActive()
    await this.startShell()
    this.assertActive()
  }

  /** Saves the profile (without ever writing plaintext secrets) before connecting. */
  private async persistProfile(): Promise<string | undefined> {
    const profile = this.request.profile
    if (!profile.saveProfile) return profile.id
    const secrets: StoredSecret = {}
    if (this.request.password) secrets.password = this.request.password
    if (this.request.passphrase) secrets.passphrase = this.request.passphrase
    try {
      const summary = this.store.saveProfile(profile, secrets)
      return summary.id
    } catch (error) {
      this.emitToast(
        'warn',
        `Could not save the SSH profile: ${(error as Error)?.message ?? 'unknown error'}`
      )
      return profile.id
    }
  }

  private async resolveCredentials(profileId: string | undefined): Promise<Credentials> {
    const profile = this.request.profile
    const requestPassword =
      typeof this.request.password === 'string' && this.request.password
        ? this.request.password
        : undefined
    const requestPassphrase =
      typeof this.request.passphrase === 'string' && this.request.passphrase
        ? this.request.passphrase
        : undefined
    const storedPassword = profileId ? this.store.getSecret(profileId, 'password') : undefined
    const storedPassphrase = profileId ? this.store.getSecret(profileId, 'passphrase') : undefined

    this.resolvedPassword = requestPassword ?? storedPassword
    this.resolvedPassphrase = requestPassphrase ?? storedPassphrase

    const target = `${profile.username}@${profile.host}:${profile.port}`
    if (profile.authMethod === 'password') {
      if (!this.resolvedPassword) {
        throw new AppError('SSH_AUTH_REQUIRED', `A password is required to connect to ${target}`, {
          host: profile.host,
          port: profile.port,
          username: profile.username
        })
      }
      return { password: this.resolvedPassword }
    }

    if (profile.authMethod === 'privateKey') {
      const keyPath = profile.privateKeyPath?.trim()
      if (!keyPath) {
        throw new AppError('SSH_AUTH_REQUIRED', `A private key file is required for ${target}`, {
          host: profile.host,
          port: profile.port,
          username: profile.username
        })
      }
      let privateKey: Buffer
      try {
        privateKey = await readFile(keyPath)
      } catch (error) {
        throw new AppError(
          'SSH_AUTH_FAILED',
          `Could not read private key file ${keyPath}: ${(error as Error)?.message ?? 'unknown error'}`,
          { keyPath }
        )
      }
      this.validatePrivateKey(privateKey, this.resolvedPassphrase, keyPath)
      return {
        privateKey,
        ...(this.resolvedPassphrase ? { passphrase: this.resolvedPassphrase } : {})
      }
    }

    // Agent authentication: use the standard OpenSSH agent socket/pipe when available.
    const agent = this.resolveAgentSocket()
    if (!agent) {
      throw new AppError(
        'SSH_AUTH_REQUIRED',
        'No SSH agent is available. Start ssh-agent (SSH_AUTH_SOCK) or choose another authentication method.',
        { host: profile.host, port: profile.port }
      )
    }
    return { agent }
  }

  /**
   * Parses the private key in the main process before handing it to ssh2 so a bad
   * key/passphrase produces a typed auth error instead of a generic connect error.
   */
  private validatePrivateKey(
    privateKey: Buffer,
    passphrase: string | undefined,
    keyPath: string
  ): void {
    let parsed: unknown
    try {
      parsed = ssh2Utils.parseKey(privateKey, passphrase)
    } catch (error) {
      parsed = error
    }
    if (!(parsed instanceof Error)) return
    const message = parsed.message || 'invalid private key'
    if (!passphrase && /passphrase/i.test(message)) {
      throw new AppError(
        'SSH_AUTH_REQUIRED',
        `The private key ${keyPath} is encrypted; a passphrase is required. ${message}`,
        { keyPath }
      )
    }
    throw new AppError('SSH_AUTH_FAILED', `Could not load the private key ${keyPath}: ${message}`, {
      keyPath
    })
  }

  private resolveAgentSocket(): string | undefined {
    if (process.platform === 'win32') return '\\\\.\\pipe\\openssh-ssh-agent'
    const socket = process.env.SSH_AUTH_SOCK?.trim()
    return socket || undefined
  }

  private buildConnectConfig(credentials: Credentials): ConnectConfig {
    const profile = this.request.profile
    const config: ConnectConfig = {
      host: profile.host,
      port: profile.port,
      username: profile.username,
      readyTimeout: SOCKET_CONNECT_TIMEOUT_MS,
      keepaliveInterval: KEEPALIVE_INTERVAL_MS,
      keepaliveCountMax: KEEPALIVE_COUNT_MAX,
      hostVerifier: (key: Buffer) => this.verifyHostKey(key),
      tryKeyboard: Boolean(this.resolvedPassword)
    }
    if (credentials.password) config.password = credentials.password
    if (credentials.privateKey) config.privateKey = credentials.privateKey
    if (credentials.passphrase) config.passphrase = credentials.passphrase
    if (credentials.agent) config.agent = credentials.agent
    return config
  }

  /**
   * Synchronous ssh2 host-key verifier: accepts only fingerprints already trusted
   * for this host:port. Unknown or changed keys abort the handshake and are turned
   * into typed errors by {@link mapClientError}.
   */
  private verifyHostKey(rawKey: Buffer): boolean {
    const profile = this.request.profile
    const info = hostKeyInfo(rawKey, profile.host, profile.port)
    const known = this.store.getKnownHost(profile.host, profile.port)
    if (!known) {
      this.hostKeyFailure = { kind: 'unknown', info }
      return false
    }
    if (known.fingerprint !== info.fingerprint) {
      this.hostKeyFailure = { kind: 'mismatch', info, expected: known }
      return false
    }
    this.hostKeyFailure = null
    return true
  }

  private mapClientError(error: unknown): AppError {
    const hostKeyFailure = this.hostKeyFailure
    if (hostKeyFailure) {
      this.hostKeyFailure = null
      const { info } = hostKeyFailure
      if (hostKeyFailure.kind === 'unknown') {
        return new AppError(
          'SSH_HOST_KEY_UNKNOWN',
          `The host key for ${info.host}:${info.port} is not trusted yet (${info.algorithm} ${info.fingerprint}). Verify its fingerprint before connecting.`,
          { hostKey: info }
        )
      }
      const expected = hostKeyFailure.expected
      return new AppError(
        'SSH_HOST_KEY_MISMATCH',
        `The host key for ${info.host}:${info.port} has changed. Expected ${expected?.fingerprint ?? 'a previously trusted key'} (${expected?.algorithm ?? 'unknown'}) but received ${info.algorithm} ${info.fingerprint}.`,
        { hostKey: info, ...(expected ? { expected } : {}) }
      )
    }
    const authError = this.pendingAuthError
    if (authError) {
      this.pendingAuthError = null
      return authError
    }
    const profile = this.request.profile
    return mapSshClientError(
      error,
      profile.host,
      profile.port,
      `${profile.username}@${profile.host}`
    )
  }

  private openConnection(credentials: Credentials): Promise<void> {
    const client = new Client()
    this.client = client
    const config = this.buildConnectConfig(credentials)

    return new Promise<void>((resolve, reject) => {
      let settled = false
      let connectTimer: NodeJS.Timeout | null = null

      const finish = (error?: AppError): void => {
        if (settled) {
          if (error) this.lastClientError = error
          return
        }
        settled = true
        if (connectTimer) clearTimeout(connectTimer)
        connectTimer = null
        client.removeListener('ready', onReady)
        client.removeListener('error', onConnectError)
        client.removeListener('close', onConnectClose)
        client.removeListener('keyboard-interactive', onKeyboardInteractive)
        if (error) reject(error)
        else resolve()
      }

      const onReady = (): void => {
        finish()
        // Re-bind lifecycle listeners for the established connection.
        client.on('error', (error: Error) => {
          this.lastClientError = mapSshClientError(
            error,
            config.host ?? '',
            config.port ?? 22,
            `${config.username ?? ''}@${config.host ?? ''}`
          )
        })
        client.once('close', () => this.handleClientClose())
        client.once('end', () => this.handleClientClose())
      }
      const onConnectError = (error: Error): void => finish(this.mapClientError(error))
      const onConnectClose = (): void =>
        finish(
          new AppError(
            'SSH_CONNECT_FAILED',
            `The connection to ${config.host}:${config.port} closed before authentication completed`
          )
        )
      const onKeyboardInteractive = (
        _name: string,
        _instructions: string,
        _lang: string,
        prompts: Prompt[],
        keyboardFinish: KeyboardInteractiveCallback
      ): void => {
        this.handleKeyboardInteractive(prompts, keyboardFinish)
      }

      connectTimer = setTimeout(() => {
        this.hostKeyFailure = null
        try {
          client.destroy()
        } catch {
          // ignore
        }
        finish(
          new AppError(
            'SSH_CONNECT_FAILED',
            `Timed out connecting to ${config.host}:${config.port} (${config.username})`
          )
        )
      }, SOCKET_CONNECT_TIMEOUT_MS)
      connectTimer.unref?.()

      client.once('ready', onReady)
      client.on('error', onConnectError)
      client.once('close', onConnectClose)
      client.on('keyboard-interactive', onKeyboardInteractive)

      try {
        client.connect(config)
      } catch (error) {
        finish(
          new AppError(
            'SSH_CONNECT_FAILED',
            `Could not connect to ${config.host}:${config.port}: ${(error as Error)?.message ?? 'unknown error'}`
          )
        )
      }
    })
  }

  /**
   * Keyboard-interactive policy from the task: answer exactly one non-echo prompt
   * with the password; anything else is rejected with a typed error instead of
   * hanging or leaking the password into an echoing prompt.
   */
  private handleKeyboardInteractive(prompts: Prompt[], finish: KeyboardInteractiveCallback): void {
    const password = this.resolvedPassword
    if (!password) {
      this.pendingAuthError = new AppError(
        'SSH_KEYBOARD_INTERACTIVE_UNSUPPORTED',
        'The server requested keyboard-interactive authentication but no password is available to answer it.'
      )
      finish([])
      return
    }
    if (prompts.length === 1 && prompts[0] && !prompts[0].echo) {
      finish([password])
      return
    }
    this.pendingAuthError = new AppError(
      'SSH_KEYBOARD_INTERACTIVE_UNSUPPORTED',
      'The server requested keyboard-interactive authentication with multiple or echoing prompts, which TermShelf cannot answer automatically.',
      { promptCount: prompts.length }
    )
    finish([])
  }

  private handleClientClose(): void {
    if (this.disposed) return
    void this.closeX11Forwarding()
    this.releaseDecoders()
    this.channel = null
    if (this.status === 'connected' || this.status === 'ended') {
      this.status = 'disconnected'
      this.emitState(this.lastClientError?.toPayload())
    }
  }

  private emitState(error?: AppErrorPayload): void {
    this.emitSink({
      type: 'session:state',
      sessionId: this.id,
      status: this.status,
      title: this.title,
      ...(error ? { error } : {})
    })
  }

  private emitToast(level: ToastLevel, message: string): void {
    this.emitSink({ type: 'toast', level, message })
  }

  private asAppError(error: unknown): AppError {
    if (error instanceof AppError) return error
    const payload = toErrorPayload(error, 'SSH_CONNECT_FAILED')
    return new AppError(payload.code, payload.message, payload.details)
  }

  /* ------------------------------------------------------------------------ */
  /* SFTP backend                                                             */
  /* ------------------------------------------------------------------------ */

  private async attachBackend(): Promise<void> {
    const client = this.client
    if (!client) throw new AppError('SSH_CONNECT_FAILED', 'Not connected')
    try {
      const sftp = await this.openSftp(client)
      this.sftp = sftp
      const backend = new SftpBackend(sftp)
      this.sftpBackend = backend
      try {
        this.homePath = await backend.home()
      } catch {
        this.homePath = null
      }
    } catch (error) {
      this.sftp = null
      this.sftpBackend = new NullSftpBackend('SFTP is not available on this server')
      this.homePath = null
      const profile = this.request.profile
      this.emitToast(
        'warn',
        `SFTP is unavailable on ${profile.host}. The file sidebar and transfers are disabled, but the terminal still works. (${(error as Error)?.message ?? 'unknown error'})`
      )
    }
  }

  private openSftp(client: Client): Promise<SFTPWrapper> {
    return new Promise<SFTPWrapper>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new AppError('SSH_SFTP_UNAVAILABLE', 'Timed out opening the SFTP subsystem'))
      }, SFTP_OPEN_TIMEOUT_MS)
      timer.unref?.()
      try {
        client.sftp((error, sftp) => {
          if (settled) {
            try {
              sftp?.end()
            } catch {
              // ignore late handles
            }
            return
          }
          settled = true
          clearTimeout(timer)
          if (error || !sftp) {
            reject(
              new AppError(
                'SSH_SFTP_UNAVAILABLE',
                `Could not open the SFTP subsystem: ${(error as Error)?.message ?? 'unknown error'}`
              )
            )
            return
          }
          resolve(sftp)
        })
      } catch (error) {
        settled = true
        clearTimeout(timer)
        reject(
          new AppError(
            'SSH_SFTP_UNAVAILABLE',
            `Could not open the SFTP subsystem: ${(error as Error)?.message ?? 'unknown error'}`
          )
        )
      }
    })
  }

  /* ------------------------------------------------------------------------ */
  /* Remote shell                                                             */
  /* ------------------------------------------------------------------------ */

  /** Prepares a local X11 display and attaches the ssh2 X11 channel handler. */
  private async prepareX11Forwarding(): Promise<void> {
    if (this.request.profile.x11 !== true) return
    const client = this.client
    if (!client) return
    try {
      const session = await this.x11.prepareSession()
      // A dispose/reconnect may have completed while the local bridge or
      // XQuartz was starting. Never install a display on a stale client.
      if (this.disposed || this.client !== client) {
        await session.cleanup()
        return
      }
      this.x11Session = session
      this.x11Notified = false
      const labels: Record<string, string> = {
        wslg: 'WSLg',
        xquartz: 'XQuartz',
        x11: 'local X11'
      }
      this.x11Label = labels[session.backend] ?? 'X11'
      this.x11Forwarder = new X11Forwarder({
        target: session.target,
        expectedCookie: session.cookie,
        localCookie: session.localCookie,
        warn: (message) => this.emitToast('warn', message)
      })
      client.on('x11', (_details, accept, reject) => {
        if (!this.x11Forwarder || !this.x11Forwarder.canAccept()) {
          reject()
          return
        }
        this.x11Forwarder.attach(accept())
      })
    } catch (error) {
      this.emitToast(
        'warn',
        `Remote GUI unavailable: ${error instanceof Error ? error.message : 'unknown error'}`
      )
    }
  }

  private announceX11(): void {
    if (!this.x11Session || this.x11Notified || !this.x11Label) return
    this.x11Notified = true
    this.emitToast('info', `Remote GUI forwarding enabled (${this.x11Label})`)
  }

  private x11ShellOptions(): X11Options | undefined {
    if (!this.x11Session) return undefined
    return { cookie: this.x11Session.cookie, single: false, screen: 0 }
  }

  private async disableX11(message?: string, warn = true): Promise<void> {
    const hadSession = this.x11Session !== null
    this.x11Forwarder?.close()
    this.x11Forwarder = null
    this.x11Label = null
    this.x11Notified = false
    const session = this.x11Session
    this.x11Session = null
    if (session) {
      try {
        await session.cleanup()
      } catch {
        // best effort
      }
    }
    if (hadSession && warn && message) this.emitToast('warn', message)
  }

  private async closeX11Forwarding(): Promise<void> {
    await this.disableX11(undefined, false)
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new AppError('SSH_DISCONNECTED', 'Session closed during startup')
    }
  }

  private async startShell(): Promise<void> {
    const client = this.client
    if (!client) throw new AppError('SSH_CONNECT_FAILED', 'Not connected')

    const shellInfo = this.sftp ? await this.detectRemoteShell(client) : null
    let x11 = this.x11ShellOptions()
    let channel: ClientChannel | null = null
    if (shellInfo?.integrable) {
      channel = await this.tryIntegratedShell(client, shellInfo, x11)
      if (!channel && x11) {
        // Retry with shell integration preserved, rather than dropping to a
        // plain shell just because the remote rejected the X11 request.
        await this.disableX11(this.guiFailureMessage(this.lastExecError))
        x11 = undefined
        channel = await this.tryIntegratedShell(client, shellInfo)
      }
    }
    if (!channel) {
      try {
        channel = await this.openPlainShell(client, x11)
        this.attachChannel(channel)
      } catch (error) {
        if (!x11) throw error
        await this.disableX11(this.guiFailureMessage(error))
        channel = await this.openPlainShell(client)
        this.attachChannel(channel)
      }
    }
    this.announceX11()
  }

  /** Detects `$SHELL`/kernel name with a short exec channel; never throws. */
  private async detectRemoteShell(client: Client): Promise<RemoteShellInfo | null> {
    try {
      const output = await this.execCapture(client, `printf '%s\\n' "$SHELL"; uname -s`)
      if (!output) return null
      const lines = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
      const shellPath = lines[0] ?? ''
      const osName = lines[1] ?? ''
      if (!isUsableRemoteShellPath(shellPath)) return null
      const kind = remoteShellKind(shellPath)
      if (kind === 'other') return null
      // Remote Windows (OpenSSH for Windows, Cygwin/MSYS) is not supported by the
      // POSIX shell integration; use a plain shell channel instead.
      if (WINDOWS_OS_HINT.test(osName) || WINDOWS_OS_HINT.test(shellPath)) return null
      return { shellPath, osName, kind: kind as RemoteShellInfo['kind'], integrable: true }
    } catch {
      return null
    }
  }

  private execCapture(client: Client, command: string): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      let settled = false
      let output = ''
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        resolve(null)
      }, DETECT_TIMEOUT_MS)
      timer.unref?.()

      const finish = (result: string | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      }

      try {
        client.exec(command, (error, channel) => {
          if (error || !channel) {
            finish(null)
            return
          }
          channel.on('data', (chunk: Buffer) => {
            if (output.length < 8192) output += chunk.toString('utf8')
          })
          channel.stderr.on('data', () => {
            // Detection output only needs stdout.
          })
          channel.once('close', () => finish(output))
          channel.once('error', () => finish(null))
        })
      } catch {
        finish(null)
      }
    })
  }

  private guiFailureMessage(error: unknown): string {
    const text = error instanceof Error ? error.message : String(error ?? '')
    if (/x11|forwarding request|could not request/i.test(text)) {
      return 'Remote host rejected X11 forwarding; terminal opened without a GUI.'
    }
    return 'Remote GUI could not be established; terminal opened without a GUI.'
  }

  private async tryIntegratedShell(
    client: Client,
    info: RemoteShellInfo,
    x11?: X11Options
  ): Promise<ClientChannel | null> {
    this.lastExecError = null
    const plan = await this.prepareIntegration(info)
    if (!plan) return null

    const channel = await this.openExecShell(client, plan.command, x11)
    if (!channel) {
      await this.cleanupIntegrationFiles()
      return null
    }

    // Attach immediately so no prompt/OSC7 bytes are lost while probing. If the
    // wrapper exits immediately (wrong rcfile path, non-POSIX shell, ...) we fall
    // back to a plain shell channel; the session itself never fails for this.
    this.attachChannel(channel)
    this.probing = true
    const died = await new Promise<boolean>((resolve) => {
      if ((channel as unknown as { destroyed?: boolean }).destroyed) {
        resolve(true)
        return
      }
      let settled = false
      const finish = (value: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        channel.removeListener('close', onClose)
        resolve(value)
      }
      const onClose = (): void => finish(true)
      const timer = setTimeout(() => finish(false), INTEGRATION_PROBE_MS)
      timer.unref?.()
      channel.once('close', onClose)
    })
    this.probing = false

    if (died) {
      this.channel = null
      this.releaseDecoders()
      try {
        channel.destroy()
      } catch {
        // already closed
      }
      await this.cleanupIntegrationFiles()
      return null
    }
    return channel
  }

  private openExecShell(
    client: Client,
    command: string,
    x11?: X11Options
  ): Promise<ClientChannel | null> {
    return new Promise<ClientChannel | null>((resolve) => {
      const options: ExecOptions = {
        pty: { term: TERM, cols: this.cols, rows: this.rows },
        ...(x11 ? { x11 } : {})
      }
      try {
        client.exec(command, options, (error, channel) => {
          this.lastExecError = error?.message ?? null
          resolve(error || !channel ? null : channel)
        })
      } catch (error) {
        this.lastExecError = error instanceof Error ? error.message : 'X11 request failed'
        resolve(null)
      }
    })
  }

  private openPlainShell(client: Client, x11?: X11Options): Promise<ClientChannel> {
    return new Promise<ClientChannel>((resolve, reject) => {
      const window = { term: TERM, cols: this.cols, rows: this.rows }
      const onChannel = (error?: Error, channel?: ClientChannel): void => {
        if (error || !channel) {
          reject(
            new AppError(
              'SHELL_SPAWN_FAILED',
              `Could not open a remote shell: ${error?.message ?? 'unknown error'}`
            )
          )
          return
        }
        resolve(channel)
      }
      try {
        if (x11) client.shell(window, { x11 }, onChannel)
        else client.shell(window, onChannel)
      } catch (error) {
        reject(
          new AppError(
            'SHELL_SPAWN_FAILED',
            `Could not open a remote shell: ${(error as Error)?.message ?? 'unknown error'}`
          )
        )
      }
    })
  }

  /** Writes shell-init files remotely and returns the wrapper command, or null. */
  private async prepareIntegration(info: RemoteShellInfo): Promise<IntegrationPlan | null> {
    const sftp = this.sftp
    if (!sftp) return null
    try {
      const directory = await this.ensureIntegrationDirectory()
      if (!directory) return null
      const suffix = this.safeFileToken()

      if (info.kind === 'bash') {
        const initPath = joinPath(POSIX_STYLE, directory, `bash-${suffix}.bash`)
        await remoteWriteFile(sftp, initPath, BASH_INIT)
        this.remoteTempFiles.push(initPath)
        const inner = `exec ${posixQuote(info.shellPath)} --rcfile ${posixQuote(initPath)} -i`
        const wrapper = `${posixQuote(info.shellPath)} -l -c ${posixQuote(inner)}`
        if (!(await this.verifyIntegrationPath(initPath))) {
          await this.cleanupIntegrationFiles()
          return null
        }
        return { kind: 'bash', command: wrapper }
      }

      if (info.kind === 'zsh') {
        const zdotdir = joinPath(POSIX_STYLE, directory, `zsh-${suffix}`)
        await this.ensureRemoteDirectory(zdotdir)
        this.remoteTempDirs.push(zdotdir)
        const files: Array<[string, string]> = [
          ['.zshenv', zshEnvInit()],
          ['.zprofile', ZSH_PROFILE],
          ['.zshrc', ZSH_RC],
          ['.zlogin', ZSH_LOGIN]
        ]
        for (const [name, content] of files) {
          const filePath = joinPath(POSIX_STYLE, zdotdir, name)
          await remoteWriteFile(sftp, filePath, content)
          this.remoteTempFiles.push(filePath)
        }
        const wrapper = `exec env ZDOTDIR=${posixQuote(zdotdir)} ${posixQuote(info.shellPath)} -l`
        const rcPath = joinPath(POSIX_STYLE, zdotdir, '.zshrc')
        if (!(await this.verifyIntegrationPath(rcPath))) {
          await this.cleanupIntegrationFiles()
          return null
        }
        return { kind: 'zsh', command: wrapper }
      }

      const initPath = joinPath(POSIX_STYLE, directory, `fish-${suffix}.fish`)
      await remoteWriteFile(sftp, initPath, FISH_INIT)
      this.remoteTempFiles.push(initPath)
      const inner = `source ${fishQuote(initPath)}`
      const wrapper = `exec ${fishQuote(info.shellPath)} -l -C ${fishQuote(inner)}`
      if (!(await this.verifyIntegrationPath(initPath))) {
        await this.cleanupIntegrationFiles()
        return null
      }
      return { kind: 'fish', command: wrapper }
    } catch {
      await this.cleanupIntegrationFiles()
      return null
    }
  }

  /**
   * Confirms the login shell can see the init file at the same absolute path the
   * SFTP session wrote it to (guards against chrooted/different-namespace setups).
   */
  private async verifyIntegrationPath(path: string): Promise<boolean> {
    const client = this.client
    const sftp = this.sftp
    if (!client || !sftp) return false
    try {
      await remoteTestReadable(sftp, path)
    } catch {
      return false
    }
    const output = await this.execCapture(
      client,
      `test -r ${posixQuote(path)} && printf TERMSHELF_INIT_OK`
    )
    return typeof output === 'string' && output.includes('TERMSHELF_INIT_OK')
  }

  private safeFileToken(): string {
    const safe = this.id.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 64)
    return safe || 'session'
  }

  private async ensureIntegrationDirectory(): Promise<string | null> {
    const sftp = this.sftp
    if (!sftp) return null
    const home = this.homePath
    if (home) {
      try {
        const cacheDir = joinPath(POSIX_STYLE, home, '.cache')
        const termshelfDir = joinPath(POSIX_STYLE, cacheDir, 'termshelf')
        await this.ensureRemoteDirectory(cacheDir)
        await this.ensureRemoteDirectory(termshelfDir)
        return termshelfDir
      } catch {
        // Fall through to the /tmp fallback below.
      }
    }
    const fallback = joinPath(POSIX_STYLE, '/tmp', `termshelf-${this.safeFileToken()}`)
    try {
      await this.ensureRemoteDirectory(fallback)
      this.remoteTempDirs.push(fallback)
      return fallback
    } catch {
      return null
    }
  }

  private async ensureRemoteDirectory(target: string): Promise<void> {
    const sftp = this.sftp
    if (!sftp) throw new AppError('SSH_SFTP_UNAVAILABLE', 'SFTP is not connected')
    try {
      await remoteMkdir(sftp, target)
    } catch (error) {
      if (error instanceof AppError && error.code === 'FS_EXISTS') return
      throw error
    }
  }

  private attachChannel(channel: ClientChannel): void {
    this.channel = channel
    this.batcher?.dispose()
    this.batcher = new DataBatcher((data) => {
      this.emitSink({ type: 'session:data', sessionId: this.id, data })
    })
    this.stdoutDecoder = new StringDecoder('utf8')
    this.stderrDecoder = new StringDecoder('utf8')

    channel.on('data', (chunk: Buffer) => {
      this.batcher?.push(this.stdoutDecoder?.write(chunk) ?? '')
    })
    if (channel.stderr) {
      channel.stderr.on('data', (chunk: Buffer) => {
        this.batcher?.push(this.stderrDecoder?.write(chunk) ?? '')
      })
    }
    channel.on('close', () => this.handleChannelClose())
    channel.on('error', (error: Error) => {
      const profile = this.request.profile
      this.lastClientError = mapSshClientError(
        error,
        profile.host,
        profile.port,
        `${profile.username}@${profile.host}`
      )
    })
  }

  private releaseDecoders(): void {
    const stdoutTail = this.stdoutDecoder?.end()
    const stderrTail = this.stderrDecoder?.end()
    if (stdoutTail) this.batcher?.push(stdoutTail)
    if (stderrTail) this.batcher?.push(stderrTail)
    this.stdoutDecoder = null
    this.stderrDecoder = null
    this.batcher?.dispose()
    this.batcher = null
  }

  private handleChannelClose(): void {
    this.releaseDecoders()
    this.channel = null
    if (this.probing || this.disposed) return
    if (this.status === 'connected') {
      this.status = 'ended'
      this.emitState()
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Teardown                                                                 */
  /* ------------------------------------------------------------------------ */

  private async cleanupIntegrationFiles(): Promise<void> {
    const sftp = this.sftp
    const files = this.remoteTempFiles.splice(0)
    const dirs = this.remoteTempDirs.splice(0)
    if (!sftp) return
    for (const file of files) {
      try {
        await remoteUnlink(sftp, file)
      } catch {
        // best effort
      }
    }
    for (const dir of dirs.reverse()) {
      try {
        await remoteRmdir(sftp, dir)
      } catch {
        // best effort
      }
    }
  }

  private async teardownConnection(): Promise<void> {
    this.probing = false
    await this.closeX11Forwarding()
    this.releaseDecoders()
    try {
      await this.cleanupIntegrationFiles()
    } catch {
      // best effort
    }

    const channel = this.channel
    this.channel = null
    if (channel) {
      try {
        channel.close()
      } catch {
        // ignore
      }
      try {
        channel.destroy()
      } catch {
        // ignore
      }
    }

    const client = this.client
    this.client = null
    this.sftp = null
    this.sftpBackend = new NullSftpBackend('Not connected')
    this.homePath = null

    if (client) {
      client.removeAllListeners()
      client.on('error', () => {
        // Never let a late socket error become an unhandled 'error' event.
      })
      await new Promise<void>((resolve) => {
        let settled = false
        const done = (): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve()
        }
        const timer = setTimeout(() => {
          try {
            client.destroy()
          } catch {
            // ignore
          }
          done()
        }, CLOSE_GRACE_MS)
        timer.unref?.()
        try {
          client.once('close', done)
          client.end()
        } catch {
          done()
        }
      })
    }
  }
}

/** Convenience factory; keeps the manager/tests free of `new`. */
export function createSshSession(options: SshSessionOptions): SshSession {
  return new SshSession(options)
}

/** Re-exported so callers can classify connection failures consistently. */
export { mapSshClientError }
