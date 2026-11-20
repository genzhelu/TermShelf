import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import type { X11Backend, X11Info } from '@shared/types'
import { AppError } from '../errors'
import type { WslService } from '../wsl/service'

const INFO_TTL_MS = 30_000
const DISPLAY_PROBE_TIMEOUT_MS = 2_000
const AUTH_COMMAND_TIMEOUT_MS = 4_000
const BRIDGE_READY_TIMEOUT_MS = 6_000
const BRIDGE_STOP_GRACE_MS = 300

const XAUTH_PROTOCOL = 'MIT-MAGIC-COOKIE-1'

export type X11Target =
  { kind: 'unix'; path: string } | { kind: 'tcp'; host: string; port: number; preface?: Buffer }

export interface X11Session {
  backend: X11Backend
  /** Cookie requested from the remote X client by sshd. */
  cookie: Buffer
  /** Cookie accepted by the local X server, substituted by the relay when set. */
  localCookie: Buffer | null
  target: X11Target
  cleanup: () => Promise<void>
}

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

export interface X11ServiceOptions {
  platform?: NodeJS.Platform
  wsl: WslService
  getWslDistro?: () => string | null
  runCommand?: (file: string, args: string[], timeoutMs: number) => Promise<CommandResult>
  pathExists?: (target: string) => boolean
  infoTtlMs?: number
  now?: () => number
}

interface WslgProbe {
  display: string
  socket: string | null
  python: boolean
}

interface WslgBridge {
  child: ChildProcess
  port: number
  target: X11Target
  socket: string
  display: string
  distro: string
  token: string
}

interface XauthEntry {
  display: string
  protocol: string
  hex: string
}

const WSL_X11_PROBE = [
  'printf "DISPLAY=%s\\n" "$DISPLAY"',
  'for s in /mnt/wslg/.X11-unix/X* /tmp/.X11-unix/X*; do [ -S "$s" ] && printf "SOCKET=%s\\n" "$s"; done',
  'command -v python3 >/dev/null 2>&1 && echo HELPER=python3 || true'
].join('\n')

const PYTHON_BRIDGE = String.raw`
import os, socket, sys, threading
port = int(sys.argv[1])
path = sys.argv[2]
token = sys.stdin.buffer.readline().strip()
if not token:
    os._exit(2)
srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(('127.0.0.1', port))
srv.listen(32)

def pump(src, dst):
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except OSError:
        pass
    finally:
        for sock in (src, dst):
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

def watch_stdin():
    try:
        sys.stdin.buffer.read()
    except Exception:
        pass
    os._exit(0)

threading.Thread(target=watch_stdin, daemon=True).start()
while True:
    client, _ = srv.accept()
    buf = b''
    try:
        while len(buf) < len(token):
            chunk = client.recv(65536)
            if not chunk:
                break
            buf += chunk
        if not buf.startswith(token):
            client.close()
            continue
        remainder = buf[len(token):]
        upstream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        upstream.connect(path)
        if remainder:
            upstream.sendall(remainder)
    except OSError:
        try:
            client.close()
        except OSError:
            pass
        continue
    threading.Thread(target=pump, args=(client, upstream), daemon=True).start()
    threading.Thread(target=pump, args=(upstream, client), daemon=True).start()
`

function runCommandDefault(
  file: string,
  args: string[],
  timeoutMs: number
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const exitCode = error ? (error as NodeJS.ErrnoException).code : undefined
        const code = error ? (typeof exitCode === 'number' ? exitCode : 1) : 0
        resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' })
      }
    )
  })
}

/** Parses `:0`, `localhost:10.0` and similar local display names. */
export function parseDisplayNumber(display: string): number | null {
  const match = /(?:^|:)(\d+)(?:\.\d+)?$/.exec(display.trim())
  if (!match?.[1]) return null
  const number = Number(match[1])
  return Number.isInteger(number) && number >= 0 ? number : null
}

/** Parses `xauth list` output into restorable entries. */
export function parseXauthEntries(output: string): XauthEntry[] {
  const entries: XauthEntry[] = []
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\S+)\s+(\S+)\s+([0-9a-fA-F]+)\s*$/.exec(line)
    if (match?.[1] && match[2] && match[3]) {
      entries.push({ display: match[1], protocol: match[2], hex: match[3] })
    }
  }
  return entries
}

/** Parses the short shell probe used inside WSL. */
export function parseWslgProbe(output: string): WslgProbe {
  const result: WslgProbe = { display: ':0', socket: null, python: false }
  const sockets: string[] = []
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.startsWith('DISPLAY=')) result.display = line.slice('DISPLAY='.length) || ':0'
    else if (line.startsWith('SOCKET=')) sockets.push(line.slice('SOCKET='.length))
    else if (line === 'HELPER=python3') result.python = true
  }
  const number = parseDisplayNumber(result.display) ?? 0
  // Match the socket to the reported DISPLAY; prefer the WSLg mount.
  result.socket =
    sockets.find((value) => value.endsWith(`/X${number}`) && value.includes('/mnt/wslg/')) ??
    sockets.find((value) => value.endsWith(`/X${number}`)) ??
    sockets.find((value) => value.includes('/mnt/wslg/')) ??
    sockets[0] ??
    null
  return result
}

/** Builds an X11 connection setup request for a MIT-MAGIC-COOKIE-1 cookie. */
export function buildX11SetupPacket(cookie: Buffer): Buffer {
  const name = Buffer.from(XAUTH_PROTOCOL)
  const header = Buffer.alloc(12)
  header.write('l', 0, 'ascii')
  header.writeUInt16LE(11, 2)
  header.writeUInt16LE(0, 4)
  header.writeUInt16LE(name.length, 6)
  header.writeUInt16LE(cookie.length, 8)
  const namePad = Buffer.alloc((4 - (name.length % 4)) % 4)
  const cookiePad = Buffer.alloc((4 - (cookie.length % 4)) % 4)
  return Buffer.concat([header, name, namePad, cookie, cookiePad])
}

function connectTarget(target: X11Target, timeoutMs: number): Promise<net.Socket> {
  return new Promise<net.Socket>((resolve, reject) => {
    const socket =
      target.kind === 'unix'
        ? net.connect({ path: target.path })
        : net.connect({ host: target.host, port: target.port })
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(new Error('Timed out connecting to the local X11 display'))
    }, timeoutMs)
    timer.unref?.()
    socket.once('connect', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(socket)
    })
    socket.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
  })
}

/** Verifies that the local X server accepts the supplied MIT cookie. */
export async function probeX11Target(target: X11Target, cookie: Buffer): Promise<boolean> {
  let socket: net.Socket
  try {
    socket = await connectTarget(target, DISPLAY_PROBE_TIMEOUT_MS)
  } catch {
    return false
  }
  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (value: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(value)
    }
    const timer = setTimeout(() => finish(false), DISPLAY_PROBE_TIMEOUT_MS)
    timer.unref?.()
    socket.once('data', (data: Buffer) => finish(data[0] === 1))
    socket.once('error', () => finish(false))
    socket.once('close', () => finish(false))
    try {
      if (target.kind === 'tcp' && target.preface) socket.write(target.preface)
      socket.write(buildX11SetupPacket(cookie))
    } catch {
      finish(false)
    }
  })
}

function findFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error) => {
        if (error) reject(error)
        else if (port > 0) resolve(port)
        else reject(new Error('Could not allocate a local port'))
      })
    })
  })
}

function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  return new Promise<boolean>((resolve) => {
    const attempt = (): void => {
      if (Date.now() > deadline) {
        resolve(false)
        return
      }
      const socket = net.connect({ host: '127.0.0.1', port })
      let settled = false
      const finish = (ok: boolean): void => {
        if (settled) return
        settled = true
        socket.destroy()
        if (ok) resolve(true)
        else setTimeout(attempt, 100).unref?.()
      }
      socket.setTimeout(300, () => finish(false))
      socket.once('connect', () => finish(true))
      socket.once('error', () => finish(false))
    }
    attempt()
  })
}

function localPathExists(target: string): boolean {
  try {
    return fs.statSync(target).isSocket() || fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

/**
 * Manages the local X11 display used for remote GUI forwarding.
 *
 * Windows uses a small authenticated Python TCP→Unix relay in WSLg,
 * macOS uses XQuartz, and Linux uses the current DISPLAY. The service owns at
 * most one WSLg relay and is disposed with the application.
 */
export class X11Service {
  private readonly platform: NodeJS.Platform
  private readonly wsl: WslService
  private readonly getWslDistro: () => string | null
  private readonly runCommand: (
    file: string,
    args: string[],
    timeoutMs: number
  ) => Promise<CommandResult>
  private readonly pathExists: (target: string) => boolean
  private readonly infoTtlMs: number
  private readonly now: () => number
  private infoCache: { at: number; value: X11Info } | null = null
  private bridge: WslgBridge | null = null
  private bridgePromise: Promise<WslgBridge> | null = null
  private activeSessions = 0
  private stopTimer: NodeJS.Timeout | null = null
  private disposed = false

  constructor(options: X11ServiceOptions) {
    this.platform = options.platform ?? process.platform
    this.wsl = options.wsl
    this.getWslDistro = options.getWslDistro ?? (() => null)
    this.runCommand = options.runCommand ?? runCommandDefault
    this.pathExists = options.pathExists ?? localPathExists
    this.infoTtlMs = options.infoTtlMs ?? INFO_TTL_MS
    this.now = options.now ?? Date.now
  }

  async info(force = false): Promise<X11Info> {
    if (!force && this.infoCache && this.now() - this.infoCache.at < this.infoTtlMs) {
      return this.infoCache.value
    }
    let value: X11Info
    try {
      value = await this.detectInfo()
    } catch (error) {
      value = {
        available: false,
        backend: 'none',
        label: 'No local GUI display',
        detail: error instanceof Error ? error.message : 'Could not detect a local X11 display'
      }
    }
    this.infoCache = { at: this.now(), value }
    return value
  }

  private async detectInfo(): Promise<X11Info> {
    if (this.platform === 'win32') {
      const wslInfo = await this.wsl.info()
      if (!wslInfo.available) {
        return {
          available: false,
          backend: 'none',
          label: 'No local GUI display',
          detail: wslInfo.error ?? 'WSLg is not available'
        }
      }
      const context = await this.wsl.resolveContext(this.getWslDistro())
      const probe = await this.wsl.runInDistro(context.distro, ['sh', '-c', WSL_X11_PROBE])
      const parsed = parseWslgProbe(probe.stdout)
      if (!parsed.socket) {
        return {
          available: false,
          backend: 'none',
          label: 'No WSLg display',
          detail: 'WSLg is not exposing an X11 socket in this distribution'
        }
      }
      if (!parsed.python) {
        return {
          available: false,
          backend: 'none',
          label: 'WSLg found, bridge unavailable',
          detail: 'Install python3 inside WSL to enable the authenticated local GUI bridge'
        }
      }
      return {
        available: true,
        backend: 'wslg',
        label: `WSLg (${context.distro})`,
        detail: `${parsed.display} · authenticated python3 bridge`
      }
    }

    if (this.platform === 'darwin') {
      const installed =
        fs.existsSync('/Applications/Utilities/XQuartz.app') || fs.existsSync('/opt/X11/bin/xauth')
      if (!installed) {
        return {
          available: false,
          backend: 'none',
          label: 'XQuartz not installed',
          detail: 'Install XQuartz from https://www.xquartz.org to display remote Linux GUIs'
        }
      }
      return {
        available: true,
        backend: 'xquartz',
        label: 'XQuartz',
        detail: 'XQuartz is launched automatically when Remote GUI is enabled'
      }
    }

    if (this.platform === 'linux') {
      const display = process.env.DISPLAY?.trim()
      const number = display ? parseDisplayNumber(display) : null
      if (!display || number === null) {
        return {
          available: false,
          backend: 'none',
          label: 'No local GUI display',
          detail: 'DISPLAY is not set. Start TermShelf inside a graphical session.'
        }
      }
      const unixTarget = `/tmp/.X11-unix/X${number}`
      return {
        available: true,
        backend: 'x11',
        label: `Local X11 (${display})`,
        detail: this.pathExists(unixTarget) ? unixTarget : '127.0.0.1 TCP display'
      }
    }

    return {
      available: false,
      backend: 'none',
      label: 'No local GUI display',
      detail: 'X11 forwarding is only supported on Windows (WSLg), macOS (XQuartz) and Linux'
    }
  }

  async prepareSession(): Promise<X11Session> {
    if (this.disposed) throw new AppError('X11_UNAVAILABLE', 'X11 service is shutting down')
    let info = await this.info()
    if (!info.available) info = await this.info(true)
    if (!info.available) {
      throw new AppError('X11_UNAVAILABLE', info.detail ?? info.label)
    }

    let target: X11Target
    let display: string
    let authKind: 'wsl' | 'local'
    let distro: string | null = null

    if (this.platform === 'win32') {
      this.cancelBridgeStop()
      const bridge = await this.ensureWslgBridge()
      target = bridge.target
      display = bridge.display
      distro = bridge.distro
      authKind = 'wsl'
    } else {
      if (this.platform === 'darwin') await this.ensureXQuartz()
      display = process.env.DISPLAY?.trim() || ':0'
      target = this.localTarget(display)
      authKind = 'local'
    }

    const cookie = randomBytes(16)
    // WSLg and some local X servers have access control disabled. In that
    // case the random SSH cookie is accepted directly and no auth rewriting
    // is needed. This is the normal Windows/WSLg path.
    if (await probeX11Target(target, cookie)) {
      return this.makeSession(info.backend, cookie, null, target)
    }

    // Otherwise read the local server's real cookie and validate that the
    // server accepts it. The SSH client only ever sees the random cookie; the
    // forwarder substitutes the local credential before relaying.
    const localCookies = await this.readLocalCookies(authKind, display, distro)
    for (const localCookie of localCookies) {
      if (await probeX11Target(target, localCookie)) {
        return this.makeSession(info.backend, cookie, localCookie, target)
      }
    }
    this.scheduleBridgeStopIfIdle()
    throw new AppError(
      'X11_UNAVAILABLE',
      'The local X server rejected the X11 credentials; check DISPLAY/XAUTHORITY'
    )
  }

  private makeSession(
    backend: X11Backend,
    cookie: Buffer,
    localCookie: Buffer | null,
    target: X11Target
  ): X11Session {
    this.cancelBridgeStop()
    this.activeSessions += 1
    let cleaned = false
    return {
      backend,
      cookie,
      localCookie,
      target,
      cleanup: async () => {
        if (cleaned) return
        cleaned = true
        this.releaseSession()
      }
    }
  }

  private releaseSession(): void {
    this.activeSessions = Math.max(0, this.activeSessions - 1)
    this.scheduleBridgeStopIfIdle()
  }

  private scheduleBridgeStopIfIdle(): void {
    if (this.activeSessions > 0 || !this.bridge || this.stopTimer) return
    this.stopTimer = setTimeout(() => {
      this.stopTimer = null
      if (this.activeSessions === 0) void this.stopBridge()
    }, 750)
    this.stopTimer.unref?.()
  }

  private cancelBridgeStop(): void {
    if (!this.stopTimer) return
    clearTimeout(this.stopTimer)
    this.stopTimer = null
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.cancelBridgeStop()
    if (this.bridgePromise) await this.bridgePromise.catch(() => undefined)
    await this.stopBridge()
  }

  private async ensureWslgBridge(): Promise<WslgBridge> {
    if (this.bridge) {
      this.cancelBridgeStop()
      return this.bridge
    }
    if (this.bridgePromise) return this.bridgePromise
    this.bridgePromise = this.startWslgBridge().finally(() => {
      this.bridgePromise = null
    })
    return this.bridgePromise
  }

  private async startWslgBridge(): Promise<WslgBridge> {
    const context = await this.wsl.resolveContext(this.getWslDistro())
    const result = await this.wsl.runInDistro(context.distro, ['sh', '-c', WSL_X11_PROBE])
    const probe = parseWslgProbe(result.stdout)
    if (!probe.socket) throw new AppError('X11_UNAVAILABLE', 'WSLg is not exposing an X11 socket')
    if (!probe.python) {
      throw new AppError(
        'X11_UNAVAILABLE',
        'Install python3 inside WSL to bridge WSLg to TermShelf securely'
      )
    }
    const executable = this.wsl.executablePath
    if (!executable) throw new AppError('X11_UNAVAILABLE', 'wsl.exe was not found')

    let lastError: Error | null = null
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let port: number
      try {
        port = await findFreePort()
      } catch (error) {
        lastError = error as Error
        continue
      }
      const token = randomBytes(24).toString('hex')
      const args = [
        '-d',
        context.distro,
        '-e',
        'python3',
        '-u',
        '-c',
        PYTHON_BRIDGE,
        String(port),
        probe.socket
      ]
      const child = spawn(executable, args, {
        windowsHide: true,
        stdio: ['pipe', 'ignore', 'pipe']
      })
      let stderr = ''
      let spawnError: Error | null = null
      child.once('error', (error) => {
        spawnError = error
        lastError = error
      })
      child.stderr.on('data', (data: Buffer) => {
        if (stderr.length < 8192) stderr += data.toString('utf8')
      })
      child.stdin?.on('error', () => undefined)
      try {
        // The token travels over stdin, never through a process command line
        // that other local processes could enumerate.
        child.stdin?.write(`${token}\n`)
      } catch {
        child.kill()
        lastError = new Error('Could not initialize the WSLg bridge token')
        continue
      }
      const started = await waitForPort(port, BRIDGE_READY_TIMEOUT_MS)
      if (started && child.exitCode === null && !this.disposed && !spawnError) {
        const bridge: WslgBridge = {
          child,
          port,
          target: {
            kind: 'tcp',
            host: '127.0.0.1',
            port,
            preface: Buffer.from(token)
          },
          socket: probe.socket,
          display: probe.display,
          distro: context.distro,
          token
        }
        child.once('exit', () => {
          if (this.bridge === bridge) this.bridge = null
        })
        child.once('error', () => {
          if (this.bridge === bridge) this.bridge = null
        })
        this.bridge = bridge
        return bridge
      }
      child.stdin?.end()
      child.kill()
      lastError = new Error(
        stderr.trim() || `The WSLg bridge did not become ready on 127.0.0.1:${port}`
      )
    }
    throw new AppError(
      'X11_UNAVAILABLE',
      lastError?.message ?? 'Could not start the WSLg TCP bridge'
    )
  }

  private async stopBridge(): Promise<void> {
    this.cancelBridgeStop()
    const bridge = this.bridge
    this.bridge = null
    if (!bridge) return
    try {
      bridge.child.stdin?.end()
    } catch {
      // ignore
    }
    await new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        resolve()
      }
      const timer = setTimeout(() => {
        try {
          bridge.child.kill()
        } catch {
          // already gone
        }
        finish()
      }, BRIDGE_STOP_GRACE_MS)
      timer.unref?.()
      bridge.child.once('exit', () => {
        clearTimeout(timer)
        finish()
      })
    })
  }

  private localSocketPath(display: string): string | null {
    const trimmed = display.trim()
    if (trimmed.startsWith('/')) {
      // XQuartz launchd displays look like /private/tmp/.../org.xquartz:0;
      // the socket itself does not include the screen suffix.
      return trimmed.replace(/:\d+(?:\.\d+)?$/, '')
    }
    const number = parseDisplayNumber(trimmed)
    return number === null ? null : `/tmp/.X11-unix/X${number}`
  }

  private localTarget(display: string): X11Target {
    const socketPath = this.localSocketPath(display)
    if (socketPath && this.pathExists(socketPath)) return { kind: 'unix', path: socketPath }
    const number = parseDisplayNumber(display) ?? 0
    return { kind: 'tcp', host: '127.0.0.1', port: 6000 + number }
  }

  private async ensureXQuartz(): Promise<void> {
    if (this.platform !== 'darwin') return
    const display = process.env.DISPLAY?.trim() || ':0'
    const socketPath = this.localSocketPath(display)
    if (socketPath && this.pathExists(socketPath)) return
    await this.runCommand('open', ['-a', 'XQuartz'], 5_000)
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      if (socketPath && this.pathExists(socketPath)) return
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
  }

  private async readLocalCookies(
    kind: 'wsl' | 'local',
    display: string,
    distro: string | null
  ): Promise<Buffer[]> {
    let output = ''
    if (kind === 'wsl' && distro) {
      const result = await this.wsl.runInDistro(distro, [
        'sh',
        '-c',
        `xauth list ${shellQuote(display || ':0')} 2>/dev/null || true`
      ])
      if (result.code === 0) output = result.stdout
    } else {
      const executable =
        this.platform === 'darwin' && fs.existsSync('/opt/X11/bin/xauth')
          ? '/opt/X11/bin/xauth'
          : 'xauth'
      const primary = display || ':0'
      const names = [primary]
      if (primary.startsWith('/')) {
        // XQuartz launchd displays are often keyed by :<screen> in xauth even
        // though DISPLAY carries the launchd socket path.
        const number = parseDisplayNumber(primary)
        if (number !== null) names.push(`:${number}`)
      }
      for (const name of names) {
        const result = await this.runCommand(executable, ['list', name], AUTH_COMMAND_TIMEOUT_MS)
        if (result.code === 0 && result.stdout.trim().length > 0) {
          output = result.stdout
          break
        }
      }
    }
    const seen = new Set<string>()
    const cookies: Buffer[] = []
    for (const entry of parseXauthEntries(output)) {
      if (entry.protocol !== XAUTH_PROTOCOL) continue
      if (seen.has(entry.hex)) continue
      try {
        const cookie = Buffer.from(entry.hex, 'hex')
        if (cookie.length === 0) continue
        seen.add(entry.hex)
        cookies.push(cookie)
      } catch {
        // ignore malformed entries
      }
    }
    return cookies
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
