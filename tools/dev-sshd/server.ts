/**
 * Dev/demo SSH server for TermShelf.
 *
 * A small in-process SSH server built on ssh2's `Server` that is good enough for
 * exercising the app's SSH session backend (SFTP file sidebar + pty terminal) and
 * for integration tests. It intentionally keeps no state outside of the filesystem
 * under `options.root`: all SFTP paths are virtual POSIX paths rooted at `/`.
 *
 *   import { startDevSshd } from './tools/dev-sshd/server'
 *   const sshd = await startDevSshd({ root: 'demo-remote', port: 0 })
 *   // sshd.port is the actual bound port (supports port 0 / ephemeral ports)
 *   await sshd.close()
 *
 * SFTP path modes: `virtual` (default) exposes the sandbox root as `/`; `absolute`
 * exposes the real host paths under the root so SFTP matches the pty shell's cwd
 * (needed by the app's remote folder sync / OSC 7 tests).
 *
 * Security: this is a development fixture. It binds to 127.0.0.1 by default,
 * compares the demo password in constant time and sandboxes SFTP to `root`.
 * It is NOT hardened for untrusted networks: do not expose it publicly.
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { spawn as spawnChildProcess } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import * as fs from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import * as path from 'node:path'
import * as pty from '@homebridge/node-pty-prebuilt-multiarch'
import { Server as Ssh2Server, utils as ssh2Utils } from 'ssh2'
import type { AuthContext, ClientInfo, Connection, ServerChannel, Session } from 'ssh2'

const { OPEN_MODE, STATUS_CODE } = ssh2Utils.sftp

/** Maximum number of bytes served for a single SFTP READ request. */
const MAX_READ_CHUNK = 1024 * 1024
/** How long close() waits for client connections to drain before forcing them shut. */
const CLOSE_GRACE_MS = 2000

export type DevSshdLog = (message: string) => void

export interface DevSshdOptions {
  /** Address to bind. Defaults to 127.0.0.1. */
  host?: string
  /** Port to bind. Defaults to 2222 in the CLI; `startDevSshd` defaults to an ephemeral port (0). */
  port?: number
  /** Directory that backs the virtual SFTP root `/`. Created when missing. */
  root: string
  /** Demo username. Defaults to `demo`. */
  username?: string
  /** Demo password. Defaults to `demo`. */
  password?: string
  /** Host private key path. Defaults to `.dev-sshd/host.key` under the current directory. */
  hostKeyPath?: string
  /** Diagnostics sink. When omitted the server is silent (test friendly). */
  log?: DevSshdLog
  /** OpenSSH `authorized_keys` lines (or bare public keys) accepted in addition to the password. */
  authorizedKeys?: Array<string | Buffer>
  /** Shell used for shell/exec sessions. Defaults to $SHELL (POSIX) or $COMSPEC (Windows). */
  shellPath?: string
  /**
   * How SFTP paths map to the sandbox root:
   * - `'virtual'` (default): the sandbox root is exposed to clients as `/`
   *   (e.g. `realpath('.') === '/'`).
   * - `'absolute'`: SFTP paths are real host paths under the root (e.g. the pty
   *   shell's working directory), so the shell and SFTP namespaces agree. This
   *   is what a real SSH host looks like and is what remote folder sync (OSC 7)
   *   needs. Intended for POSIX hosts; paths outside the root are rejected.
   */
  sftpPathMode?: SftpPathMode
}

export type SftpPathMode = 'virtual' | 'absolute'

export interface DevSshdHandle {
  /** Actually bound address (always 127.0.0.1 unless overridden). */
  host: string
  /** Actually bound port. With `port: 0` this is the ephemeral port the OS assigned. */
  port: number
  username: string
  password: string
  /** Absolute host path backing the SFTP namespace root. */
  root: string
  /** Path mapping mode the server was started with. */
  sftpPathMode: SftpPathMode
  /** SHA256 fingerprint of the host key, `SHA256:<base64>`. */
  fingerprint: string
  /** Absolute path of the persisted host private key. */
  hostKeyPath: string
  /** Stops the listener, disconnects clients and tears down every pty/session. Idempotent. */
  close(): Promise<void>
}

interface SftpAttrs {
  mode?: number
  size?: number
  uid?: number
  gid?: number
  atime?: number
  mtime?: number
}

interface SftpName {
  filename: string
  longname: string
  attrs: SftpAttrs
}

/** Server-side SFTP stream: the part of ssh2's private API we rely on. */
interface ServerSftpStream {
  on(event: string, listener: (...args: any[]) => void): unknown
  handle(reqid: number, handle: Buffer): void
  status(reqid: number, code: number, message?: string): void
  data(reqid: number, data: Buffer): void
  name(reqid: number, names: SftpName[] | SftpName): void
  attrs(reqid: number, attrs: SftpAttrs): void
}

interface ResolvedPath {
  /** Normalized client-facing path (POSIX virtual path, or absolute host path in absolute mode). */
  virtual: string
  /** Host filesystem path (canonicalized for existing paths). */
  real: string
}

type HandleEntry =
  | { kind: 'file'; file: FileHandle; real: string; append: boolean }
  | { kind: 'dir'; real: string; names: SftpName[]; nextIndex: number }

interface SessionState {
  term: { cols: number; rows: number; term: string } | null
  env: Record<string, string>
  activePty: pty.IPty | null
  activeChild: ChildProcess | null
}

/** Error carrying an explicit SFTP status code. */
class SftpRequestError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'SftpRequestError'
    this.status = status
  }
}

/* -------------------------------------------------------------------------- */
/* Host key helpers                                                           */
/* -------------------------------------------------------------------------- */

/** Returns the OpenSSH-style SHA256 fingerprint of an SSH private/public key. */
export function hostKeyFingerprint(privateKey: string | Buffer): string {
  const parsed = ssh2Utils.parseKey(privateKey)
  const key = Array.isArray(parsed) ? parsed[0] : parsed
  if (!key || key instanceof Error) {
    throw new Error(`Cannot parse SSH key: ${key instanceof Error ? key.message : 'empty key'}`)
  }
  const blob = key.getPublicSSH()
  if (!blob || blob.length === 0) throw new Error('SSH key has no public part')
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`
}

/**
 * Generates a fresh ed25519 client key pair. Handy for testing public key auth:
 * pass the returned `public` value in `startDevSshd({ authorizedKeys: [publicKey] })`
 * and connect with `privateKey`.
 */
export function generateClientKeyPair(type: 'ed25519' | 'rsa' = 'ed25519'): {
  privateKey: string
  publicKey: string
} {
  const pair =
    type === 'rsa'
      ? ssh2Utils.generateKeyPairSync('rsa', { bits: 2048 })
      : ssh2Utils.generateKeyPairSync('ed25519')
  return { privateKey: pair.private, publicKey: pair.public }
}

async function ensureHostKey(
  hostKeyPath: string,
  log: DevSshdLog
): Promise<{ privateKey: string; created: boolean }> {
  await fs.mkdir(path.dirname(hostKeyPath), { recursive: true, mode: 0o700 })
  try {
    const existing = await fs.readFile(hostKeyPath, 'utf8')
    hostKeyFingerprint(existing) // validates that the file is a usable SSH private key
    return { privateKey: existing, created: false }
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err.code !== 'ENOENT') {
      log(
        `Existing host key at ${hostKeyPath} is unusable (${errMessage(error)}); generating a new one`
      )
    }
  }
  const pair = ssh2Utils.generateKeyPairSync('ed25519')
  await fs.writeFile(hostKeyPath, pair.private, { mode: 0o600 })
  // chmod is best effort: platforms without POSIX modes simply ignore it.
  await fs.chmod(hostKeyPath, 0o600).catch(() => undefined)
  log(`Generated new ed25519 host key at ${hostKeyPath}`)
  return { privateKey: pair.private, created: true }
}

/* -------------------------------------------------------------------------- */
/* Path sandbox                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Normalizes a client-supplied SFTP path into an absolute POSIX virtual path.
 * `..` is clamped at the virtual root (like a real server), and `~` maps to `/`.
 */
export function normalizeVirtualPath(input: string): string {
  let raw = (input ?? '').trim()
  if (raw === '' || raw === '.') return '/'
  if (raw === '~') return '/'
  if (raw.startsWith('~/')) raw = raw.slice(1)
  if (!raw.startsWith('/')) raw = `/${raw}`
  const normalized = path.posix.normalize(raw)
  if (normalized !== '/' && normalized.endsWith('/')) return normalized.slice(0, -1)
  return normalized
}

class Sandbox {
  private readonly rootPrefix: string

  constructor(
    private readonly root: string,
    private readonly rootReal: string,
    readonly mode: SftpPathMode = 'virtual'
  ) {
    this.rootPrefix = rootReal.endsWith(path.sep) ? rootReal : `${rootReal}${path.sep}`
  }

  /** Normalizes a client-supplied SFTP path into the client-facing path for this mode. */
  normalizeClientPath(input: string): string {
    const raw = (input ?? '').trim()
    if (this.mode === 'absolute') {
      if (raw === '' || raw === '.' || raw === '~') return this.rootReal
      const expanded = raw.startsWith('~/') ? `${this.rootReal}${raw.slice(1)}` : raw
      if (path.isAbsolute(expanded)) return path.normalize(expanded)
      return path.resolve(this.rootReal, expanded)
    }
    return normalizeVirtualPath(raw)
  }

  dirnameOf(clientPath: string): string {
    return this.mode === 'absolute' ? path.dirname(clientPath) : path.posix.dirname(clientPath)
  }

  basenameOf(clientPath: string): string {
    return this.mode === 'absolute' ? path.basename(clientPath) : path.posix.basename(clientPath)
  }

  /** Maps a normalized client path to a host path (no symlink resolution). */
  hostPath(clientPath: string): string {
    const normalized = this.normalizeClientPath(clientPath)
    if (this.mode === 'absolute') return normalized
    const segments = normalized.split('/').filter((segment) => segment.length > 0)
    return segments.length === 0 ? this.root : path.join(this.root, ...segments)
  }

  private assertInside(real: string, virtual: string): string {
    if (real === this.rootReal) return real
    if (!real.startsWith(this.rootPrefix)) {
      throw new SftpRequestError(
        STATUS_CODE.PERMISSION_DENIED,
        `Path escapes demo root: ${virtual}`
      )
    }
    return real
  }

  /**
   * Resolves a path that must exist. With `followFinal = false` the last path
   * component is not followed through a symlink (used by LSTAT/REMOVE/RENAME).
   */
  async resolveExisting(clientPath: string, followFinal = true): Promise<ResolvedPath> {
    const virtual = this.normalizeClientPath(clientPath)
    const candidate = this.hostPath(virtual)
    try {
      return { virtual, real: this.assertInside(await fs.realpath(candidate), virtual) }
    } catch (error) {
      if (followFinal || !isMissingError(error)) throw error
      return this.resolveNoFollow(virtual)
    }
  }

  /** Resolves a path without resolving the final component through symlinks. */
  async resolveNoFollow(clientPath: string): Promise<ResolvedPath> {
    const virtual = this.normalizeClientPath(clientPath)
    const parentVirtual = this.dirnameOf(virtual)
    const name = this.basenameOf(virtual)
    const parentCandidate = this.hostPath(parentVirtual)
    const parentReal = this.assertInside(await fs.realpath(parentCandidate), parentVirtual)
    return { virtual, real: name.length === 0 ? parentReal : path.join(parentReal, name) }
  }

  /** Resolves a path whose final component may not exist yet. */
  async resolveForCreate(clientPath: string): Promise<ResolvedPath> {
    return this.resolveNoFollow(clientPath)
  }
}

function isMissingError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function errMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/* -------------------------------------------------------------------------- */
/* SFTP attribute helpers                                                     */
/* -------------------------------------------------------------------------- */

function attrsFromStats(stats: {
  mode: number
  size: number
  uid: number
  gid: number
  atimeMs: number
  mtimeMs: number
}): SftpAttrs {
  return {
    mode: stats.mode,
    size: stats.size,
    uid: stats.uid,
    gid: stats.gid,
    atime: Math.floor(stats.atimeMs / 1000),
    mtime: Math.floor(stats.mtimeMs / 1000)
  }
}

function modeString(mode: number): string {
  const type = mode & fsConstants.S_IFMT
  let prefix = '-'
  if (type === fsConstants.S_IFDIR) prefix = 'd'
  else if (type === fsConstants.S_IFLNK) prefix = 'l'
  else if (type === fsConstants.S_IFCHR) prefix = 'c'
  else if (type === fsConstants.S_IFBLK) prefix = 'b'
  else if (type === fsConstants.S_IFIFO) prefix = 'p'
  else if (type === fsConstants.S_IFSOCK) prefix = 's'
  const masks = [
    [0o400, 'r'],
    [0o200, 'w'],
    [0o100, 'x'],
    [0o040, 'r'],
    [0o020, 'w'],
    [0o010, 'x'],
    [0o004, 'r'],
    [0o002, 'w'],
    [0o001, 'x']
  ] as const
  return prefix + masks.map(([bit, char]) => ((mode & bit) !== 0 ? char : '-')).join('')
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function formatLongName(
  stats: { mode: number; size: number; uid: number; gid: number; mtimeMs: number },
  name: string
): string {
  const date = new Date(stats.mtimeMs)
  const month = MONTHS[date.getMonth()] ?? 'Jan'
  const day = String(date.getDate()).padStart(2, '0')
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return `${modeString(stats.mode)} 1 ${stats.uid} ${stats.gid} ${String(stats.size).padStart(8)} ${month} ${day} ${hh}:${mm} ${name}`
}

const S_IFMT = fsConstants.S_IFMT
const S_IFDIR = fsConstants.S_IFDIR
const S_IFLNK = fsConstants.S_IFLNK
const S_IFREG = fsConstants.S_IFREG

function pathKind(mode: number): 'file' | 'dir' | 'symlink' | 'other' {
  const type = mode & S_IFMT
  if (type === S_IFDIR) return 'dir'
  if (type === S_IFLNK) return 'symlink'
  if (type === S_IFREG) return 'file'
  return 'other'
}

function buildOpenFlags(pflags: number): number {
  let flags = fsConstants.O_RDONLY
  if (pflags & OPEN_MODE.READ && pflags & OPEN_MODE.WRITE) flags = fsConstants.O_RDWR
  else if (pflags & OPEN_MODE.WRITE) flags = fsConstants.O_WRONLY
  if (pflags & OPEN_MODE.CREAT) flags |= fsConstants.O_CREAT
  if (pflags & OPEN_MODE.TRUNC) flags |= fsConstants.O_TRUNC
  if (pflags & OPEN_MODE.APPEND) flags |= fsConstants.O_APPEND
  if (pflags & OPEN_MODE.EXCL) flags |= fsConstants.O_EXCL
  return flags
}

function fileMode(attrs: SftpAttrs, fallback: number): number {
  if (typeof attrs.mode === 'number') {
    const permissions = attrs.mode & 0o7777
    if (permissions !== 0) return permissions
  }
  return fallback
}

function replySftpStatus(
  stream: ServerSftpStream,
  reqid: number,
  code: number,
  message: string
): void {
  try {
    stream.status(reqid, code, message.slice(0, 200))
  } catch {
    // The channel may already be gone; nothing else to do.
  }
}

function replySftpError(stream: ServerSftpStream, reqid: number, error: unknown): void {
  if (error instanceof SftpRequestError) {
    replySftpStatus(stream, reqid, error.status, error.message)
    return
  }
  const err = error as NodeJS.ErrnoException
  let status: number = STATUS_CODE.FAILURE
  if (err.code === 'ENOENT' || err.code === 'ENOTDIR') status = STATUS_CODE.NO_SUCH_FILE
  else if (err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'EROFS')
    status = STATUS_CODE.PERMISSION_DENIED
  replySftpStatus(stream, reqid, status, errMessage(error))
}

/* -------------------------------------------------------------------------- */
/* SFTP subsystem                                                             */
/* -------------------------------------------------------------------------- */

function attachSftp(
  stream: ServerSftpStream,
  sandbox: Sandbox,
  log: DevSshdLog,
  registerCleanup: (cleanup: () => Promise<void>) => void
): void {
  let nextHandleId = 1
  const handles = new Map<number, HandleEntry>()

  const cleanup = async (): Promise<void> => {
    const entries = [...handles.values()]
    handles.clear()
    for (const entry of entries) {
      if (entry.kind === 'file') await entry.file.close().catch(() => undefined)
    }
  }
  registerCleanup(cleanup)
  stream.on('close', () => {
    void cleanup()
  })
  stream.on('error', (error: unknown) => {
    log(`sftp stream error: ${errMessage(error)}`)
  })

  const respond = (reqid: number, body: () => Promise<void>): void => {
    body().catch((error) => {
      log(`sftp request ${reqid} failed: ${errMessage(error)}`)
      replySftpError(stream, reqid, error)
    })
  }

  const getHandle = (reqid: number, handle: Buffer): HandleEntry | undefined => {
    if (handle.length < 4) {
      replySftpStatus(stream, reqid, STATUS_CODE.FAILURE, 'Malformed handle')
      return undefined
    }
    const entry = handles.get(handle.readUInt32BE(0))
    if (!entry) {
      replySftpStatus(stream, reqid, STATUS_CODE.FAILURE, 'Stale file handle')
      return undefined
    }
    return entry
  }

  const addHandle = (entry: HandleEntry): Buffer => {
    const id = nextHandleId++ >>> 0
    handles.set(id, entry)
    const handle = Buffer.alloc(4)
    handle.writeUInt32BE(id, 0)
    return handle
  }

  const dirNames = async (real: string): Promise<SftpName[]> => {
    const dirents = await fs.readdir(real, { withFileTypes: true })
    const names: SftpName[] = []
    for (const dirent of dirents) {
      const entryReal = path.join(real, dirent.name)
      let stats
      try {
        stats = await fs.lstat(entryReal)
      } catch {
        continue // entry disappeared between readdir and lstat
      }
      let filename = dirent.name
      if (pathKind(stats.mode) === 'symlink') {
        try {
          filename = `${dirent.name} -> ${await fs.readlink(entryReal)}`
        } catch {
          // keep the plain name when the link target is unreadable
        }
      }
      names.push({
        filename: dirent.name,
        longname: formatLongName(stats, filename),
        attrs: attrsFromStats(stats)
      })
    }
    return names
  }

  /* OPEN */
  stream.on('OPEN', (reqid: number, filename: string, pflags: number, attrs: SftpAttrs) => {
    respond(reqid, async () => {
      const target = await sandbox.resolveForCreate(filename)
      const flags = buildOpenFlags(pflags)
      const mode = fileMode(attrs ?? {}, 0o666)
      const file = await fs.open(target.real, flags, mode)
      const append = (pflags & OPEN_MODE.APPEND) !== 0
      const handle = addHandle({ kind: 'file', file, real: target.real, append })
      log(`OPEN ${target.virtual} pflags=0x${pflags.toString(16)}`)
      stream.handle(reqid, handle)
    })
  })

  /* CLOSE */
  stream.on('CLOSE', (reqid: number, handle: Buffer) => {
    respond(reqid, async () => {
      if (handle.length < 4) throw new SftpRequestError(STATUS_CODE.FAILURE, 'Malformed handle')
      const id = handle.readUInt32BE(0)
      const entry = handles.get(id)
      handles.delete(id)
      if (entry && entry.kind === 'file') await entry.file.close()
      stream.status(reqid, STATUS_CODE.OK)
    })
  })

  /* READ */
  stream.on('READ', (reqid: number, handle: Buffer, offset: number, len: number) => {
    respond(reqid, async () => {
      const entry = getHandle(reqid, handle)
      if (!entry) return
      if (entry.kind === 'dir')
        throw new SftpRequestError(STATUS_CODE.FAILURE, 'Cannot read a directory handle')
      const size = Math.min(Math.max(len, 0), MAX_READ_CHUNK)
      const buffer = Buffer.allocUnsafe(size)
      const { bytesRead } = await entry.file.read(buffer, 0, size, offset)
      if (bytesRead === 0) {
        stream.status(reqid, STATUS_CODE.EOF)
        return
      }
      stream.data(reqid, buffer.subarray(0, bytesRead))
    })
  })

  /* WRITE */
  stream.on('WRITE', (reqid: number, handle: Buffer, offset: number, data: Buffer) => {
    respond(reqid, async () => {
      const entry = getHandle(reqid, handle)
      if (!entry) return
      if (entry.kind === 'dir')
        throw new SftpRequestError(STATUS_CODE.FAILURE, 'Cannot write a directory handle')
      let written = 0
      while (written < data.length) {
        const position = entry.append ? null : offset + written
        const result = await entry.file.write(data, written, data.length - written, position)
        if (result.bytesWritten <= 0) throw new SftpRequestError(STATUS_CODE.FAILURE, 'Short write')
        written += result.bytesWritten
      }
      stream.status(reqid, STATUS_CODE.OK)
    })
  })

  /* STAT / FSTAT / LSTAT */
  stream.on('STAT', (reqid: number, target: string) => {
    respond(reqid, async () => {
      const resolved = await sandbox.resolveExisting(target)
      stream.attrs(reqid, attrsFromStats(await fs.stat(resolved.real)))
    })
  })

  stream.on('FSTAT', (reqid: number, handle: Buffer) => {
    respond(reqid, async () => {
      const entry = getHandle(reqid, handle)
      if (!entry) return
      if (entry.kind === 'file') {
        stream.attrs(reqid, attrsFromStats(await entry.file.stat()))
        return
      }
      stream.attrs(reqid, attrsFromStats(await fs.stat(entry.real)))
    })
  })

  stream.on('LSTAT', (reqid: number, target: string) => {
    respond(reqid, async () => {
      const resolved = await sandbox.resolveNoFollow(target)
      stream.attrs(reqid, attrsFromStats(await fs.lstat(resolved.real)))
    })
  })

  /* SETSTAT / FSETSTAT */
  stream.on('SETSTAT', (reqid: number, target: string, attrs: SftpAttrs) => {
    respond(reqid, async () => {
      const resolved = await sandbox.resolveExisting(target)
      await applyAttrs(resolved.real, attrs)
      stream.status(reqid, STATUS_CODE.OK)
    })
  })

  stream.on('FSETSTAT', (reqid: number, handle: Buffer, attrs: SftpAttrs) => {
    respond(reqid, async () => {
      const entry = getHandle(reqid, handle)
      if (!entry) return
      if (entry.kind === 'file') {
        if (typeof attrs.mode === 'number' && (attrs.mode & 0o7777) !== 0) {
          await entry.file.chmod(attrs.mode & 0o7777)
        }
        const times = attrsTimes(attrs)
        if (times) await entry.file.utimes(times.atime, times.mtime)
      } else {
        await applyAttrs(entry.real, attrs)
      }
      stream.status(reqid, STATUS_CODE.OK)
    })
  })

  /* OPENDIR / READDIR */
  stream.on('OPENDIR', (reqid: number, target: string) => {
    respond(reqid, async () => {
      const resolved = await sandbox.resolveExisting(target)
      const stats = await fs.stat(resolved.real)
      if (!stats.isDirectory()) throw new SftpRequestError(STATUS_CODE.FAILURE, 'Not a directory')
      const handle = addHandle({
        kind: 'dir',
        real: resolved.real,
        names: await dirNames(resolved.real),
        nextIndex: 0
      })
      log(`OPENDIR ${resolved.virtual}`)
      stream.handle(reqid, handle)
    })
  })

  stream.on('READDIR', (reqid: number, handle: Buffer) => {
    respond(reqid, async () => {
      const entry = getHandle(reqid, handle)
      if (!entry) return
      if (entry.kind !== 'dir')
        throw new SftpRequestError(STATUS_CODE.FAILURE, 'Not a directory handle')
      // Send the listing in batches so a huge directory can never produce an
      // oversized SFTP packet; the client keeps calling READDIR until EOF.
      const batch = entry.names.slice(entry.nextIndex, entry.nextIndex + 128)
      if (batch.length === 0) {
        stream.status(reqid, STATUS_CODE.EOF)
        return
      }
      entry.nextIndex += batch.length
      stream.name(reqid, batch)
    })
  })

  /* MKDIR / RMDIR / REMOVE / RENAME */
  stream.on('MKDIR', (reqid: number, target: string, attrs: SftpAttrs) => {
    respond(reqid, async () => {
      const resolved = await sandbox.resolveForCreate(target)
      await fs.mkdir(resolved.real, { mode: fileMode(attrs ?? {}, 0o755) })
      log(`MKDIR ${resolved.virtual}`)
      stream.status(reqid, STATUS_CODE.OK)
    })
  })

  stream.on('RMDIR', (reqid: number, target: string) => {
    respond(reqid, async () => {
      const resolved = await sandbox.resolveNoFollow(target)
      if (resolved.virtual === '/')
        throw new SftpRequestError(STATUS_CODE.PERMISSION_DENIED, 'Cannot remove the root')
      await fs.rmdir(resolved.real)
      stream.status(reqid, STATUS_CODE.OK)
    })
  })

  stream.on('REMOVE', (reqid: number, target: string) => {
    respond(reqid, async () => {
      const resolved = await sandbox.resolveNoFollow(target)
      const stats = await fs.lstat(resolved.real)
      if (stats.isDirectory()) throw new SftpRequestError(STATUS_CODE.FAILURE, 'Is a directory')
      await fs.unlink(resolved.real)
      stream.status(reqid, STATUS_CODE.OK)
    })
  })

  stream.on('RENAME', (reqid: number, oldTarget: string, newTarget: string) => {
    respond(reqid, async () => {
      const from = await sandbox.resolveNoFollow(oldTarget)
      const to = await sandbox.resolveForCreate(newTarget)
      await fs.rename(from.real, to.real)
      log(`RENAME ${from.virtual} -> ${to.virtual}`)
      stream.status(reqid, STATUS_CODE.OK)
    })
  })

  /* REALPATH / READLINK */
  stream.on('REALPATH', (reqid: number, target: string) => {
    respond(reqid, async () => {
      const resolved = await sandbox.resolveExisting(target)
      const stats = await fs.stat(resolved.real)
      // In absolute mode the client namespace *is* the host namespace, so answer
      // with the canonicalized host path (e.g. `/tmp/x/remote` for `.`).
      const clientPath = sandbox.mode === 'absolute' ? resolved.real : resolved.virtual
      const name: SftpName = {
        filename: clientPath,
        longname: clientPath,
        attrs: attrsFromStats(stats)
      }
      stream.name(reqid, [name])
    })
  })

  stream.on('READLINK', (reqid: number, target: string) => {
    respond(reqid, async () => {
      const resolved = await sandbox.resolveNoFollow(target)
      const linkTarget = await fs.readlink(resolved.real)
      stream.name(reqid, [{ filename: linkTarget, longname: linkTarget, attrs: {} }])
    })
  })
}

function attrsTimes(attrs: SftpAttrs): { atime: number; mtime: number } | undefined {
  if (typeof attrs.mtime !== 'number') return undefined
  const atime = typeof attrs.atime === 'number' ? attrs.atime : attrs.mtime
  return { atime, mtime: attrs.mtime }
}

async function applyAttrs(target: string, attrs: SftpAttrs): Promise<void> {
  if (typeof attrs.mode === 'number' && (attrs.mode & 0o7777) !== 0) {
    await fs.chmod(target, attrs.mode & 0o7777)
  }
  const times = attrsTimes(attrs)
  if (times) await fs.utimes(target, times.atime, times.mtime)
}

/* -------------------------------------------------------------------------- */
/* Terminal (pty) sessions                                                    */
/* -------------------------------------------------------------------------- */

function defaultShell(): string {
  if (process.platform === 'win32') return process.env.COMSPEC ?? 'cmd.exe'
  return process.env.SHELL ?? '/bin/bash'
}

/** Shell argv used for `exec`: POSIX shells take `-c`, cmd.exe takes `/c`. */
function shellArgs(command: string): string[] {
  if (process.platform === 'win32') return ['/d', '/s', '/c', command]
  return ['-c', command]
}

function sessionEnv(state: SessionState, shell: string): Record<string, string | undefined> {
  return {
    ...process.env,
    ...state.env,
    TERM: state.term?.term || 'xterm-256color',
    SHELL: shell
  }
}

function pumpPty(
  ptyProcess: pty.IPty,
  stream: ServerChannel,
  state: SessionState,
  log: DevSshdLog,
  label: string
): void {
  state.activePty = ptyProcess
  let finished = false
  const dataSub = ptyProcess.onData((chunk) => {
    if (!stream.destroyed) stream.write(chunk)
  })
  ptyProcess.onExit(({ exitCode, signal }) => {
    if (finished) return
    finished = true
    dataSub.dispose()
    if (state.activePty === ptyProcess) state.activePty = null
    log(`${label} exited with code ${exitCode}${signal ? ` signal=${signal}` : ''}`)
    try {
      stream.exit(signal ? 128 + signal : exitCode)
      stream.end()
    } catch {
      // channel already closed
    }
  })
  stream.on('data', (data: Buffer) => {
    try {
      ptyProcess.write(data.toString('utf8'))
    } catch {
      // pty already exited
    }
  })
  stream.on('close', () => {
    dataSub.dispose()
    if (!finished) {
      try {
        ptyProcess.kill()
      } catch {
        // already gone
      }
    }
  })
}

function pumpChildProcess(
  child: ChildProcess,
  stream: ServerChannel,
  state: SessionState,
  log: DevSshdLog,
  label: string
): void {
  state.activeChild = child
  let finished = false
  child.stdout?.on('data', (data: Buffer) => {
    if (!stream.destroyed) stream.write(data)
  })
  child.stderr?.on('data', (data: Buffer) => {
    if (!stream.destroyed) stream.stderr.write(data)
  })
  child.on('error', (error) => {
    if (finished) return
    finished = true
    log(`${label} failed to start: ${errMessage(error)}`)
    if (state.activeChild === child) state.activeChild = null
    try {
      stream.exit(127)
      stream.end()
    } catch {
      // channel already closed
    }
  })
  child.on('close', (code, signal) => {
    if (finished) return
    finished = true
    if (state.activeChild === child) state.activeChild = null
    log(`${label} closed with code ${code ?? 0}${signal ? ` signal=${signal}` : ''}`)
    try {
      stream.exit(code ?? (signal ? 1 : 0))
      stream.end()
    } catch {
      // channel already closed
    }
  })
  stream.on('close', () => {
    if (!finished) {
      try {
        child.kill()
      } catch {
        // already gone
      }
    }
  })
}

function handleShell(
  stream: ServerChannel,
  state: SessionState,
  shell: string,
  cwd: string,
  log: DevSshdLog
): void {
  const ptyProcess = pty.spawn(shell, [], {
    name: state.term?.term || 'xterm-256color',
    cols: state.term?.cols ?? 80,
    rows: state.term?.rows ?? 24,
    cwd,
    env: sessionEnv(state, shell)
  })
  log(`shell started (pid ${ptyProcess.pid}, ${state.term?.cols ?? 80}x${state.term?.rows ?? 24})`)
  pumpPty(ptyProcess, stream, state, log, 'shell')
}

function handleExec(
  stream: ServerChannel,
  state: SessionState,
  command: string,
  shell: string,
  cwd: string,
  log: DevSshdLog
): void {
  log(`exec ${JSON.stringify(command)}${state.term ? ' (pty)' : ''}`)
  if (state.term) {
    const ptyProcess = pty.spawn(shell, shellArgs(command), {
      name: state.term.term || 'xterm-256color',
      cols: state.term.cols,
      rows: state.term.rows,
      cwd,
      env: sessionEnv(state, shell)
    })
    pumpPty(ptyProcess, stream, state, log, 'exec')
    return
  }
  const child = spawnChildProcess(shell, shellArgs(command), {
    cwd,
    env: sessionEnv(state, shell) as NodeJS.ProcessEnv
  })
  pumpChildProcess(child, stream, state, log, 'exec')
}

/* -------------------------------------------------------------------------- */
/* Server                                                                     */
/* -------------------------------------------------------------------------- */

function constantTimeEquals(a: string, b: string): boolean {
  const left = createHash('sha256').update(a, 'utf8').digest()
  const right = createHash('sha256').update(b, 'utf8').digest()
  return timingSafeEqual(left, right)
}

function parseAuthorizedKeys(keys: Array<string | Buffer> | undefined): Buffer[] {
  const blobs: Buffer[] = []
  for (const entry of keys ?? []) {
    const line = (Buffer.isBuffer(entry) ? entry.toString('utf8') : entry).trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const parsed = ssh2Utils.parseKey(line)
    const key = Array.isArray(parsed) ? parsed[0] : parsed
    if (!key || key instanceof Error) continue
    blobs.push(key.getPublicSSH())
  }
  return blobs
}

/**
 * Starts the demo SSH server. Resolves once the listener is accepting connections,
 * with the actual bound port (pass `port: 0` for an ephemeral port in tests).
 */
export async function startDevSshd(options: DevSshdOptions): Promise<DevSshdHandle> {
  if (!options || typeof options.root !== 'string' || options.root.length === 0) {
    throw new Error('startDevSshd requires a root directory')
  }
  const log: DevSshdLog = options.log ?? (() => undefined)
  const host = options.host ?? '127.0.0.1'
  const requestedPort = options.port ?? 0
  const username = options.username ?? 'demo'
  const password = options.password ?? 'demo'
  const shellPath = options.shellPath ?? defaultShell()

  const root = path.resolve(options.root)
  await fs.mkdir(root, { recursive: true })
  const rootReal = await fs.realpath(root)
  const sftpPathMode: SftpPathMode = options.sftpPathMode ?? 'virtual'
  const sandbox = new Sandbox(root, rootReal, sftpPathMode)

  const hostKeyPath = path.resolve(
    options.hostKeyPath ?? path.join(process.cwd(), '.dev-sshd', 'host.key')
  )
  const { privateKey } = await ensureHostKey(hostKeyPath, log)
  const fingerprint = hostKeyFingerprint(privateKey)
  const authorizedKeyBlobs = parseAuthorizedKeys(options.authorizedKeys)

  const clients = new Set<Connection>()
  const cleanups = new Set<() => Promise<void>>()

  const server = new Ssh2Server(
    {
      hostKeys: [privateKey],
      ident: 'TermShelf-DevSSHD'
    },
    (client: Connection, info: ClientInfo) => {
      clients.add(client)
      const peer = `${info.ip}:${info.port}`
      log(`client connected from ${peer}`)
      client.on('error', (error) => {
        log(`client ${peer} error: ${errMessage(error)}`)
      })
      client.on('close', () => {
        clients.delete(client)
        log(`client ${peer} disconnected`)
      })

      client.on('authentication', (ctx: AuthContext) => {
        if (ctx.username !== username) {
          ctx.reject(['password', 'publickey'])
          return
        }
        if (ctx.method === 'password') {
          if (constantTimeEquals(ctx.password, password)) {
            ctx.accept()
            log(`password auth accepted for ${ctx.username}`)
          } else {
            ctx.reject(['password', 'publickey'])
            log(`password auth rejected for ${ctx.username}`)
          }
          return
        }
        if (ctx.method === 'publickey') {
          const keyData = ctx.key?.data
          const authorized =
            keyData !== undefined && authorizedKeyBlobs.some((blob) => blob.equals(keyData))
          if (authorized) {
            ctx.accept()
            log(`publickey auth accepted for ${ctx.username}`)
          } else {
            ctx.reject(['password', 'publickey'])
            log(`publickey auth rejected for ${ctx.username}`)
          }
          return
        }
        if (ctx.method === 'none' || ctx.method === 'keyboard-interactive') {
          ctx.reject(['password', 'publickey'])
          return
        }
        ctx.reject(['password', 'publickey'])
      })

      client.on('ready', () => {
        log(`client ${peer} authenticated`)
        client.on('session', (accept) => {
          const session: Session = accept()
          const state: SessionState = { term: null, env: {}, activePty: null, activeChild: null }
          const cleanup = async (): Promise<void> => {
            if (state.activePty) {
              try {
                state.activePty.kill()
              } catch {
                // already gone
              }
              state.activePty = null
            }
            if (state.activeChild) {
              try {
                state.activeChild.kill()
              } catch {
                // already gone
              }
              state.activeChild = null
            }
          }
          cleanups.add(cleanup)
          session.on('close', () => {
            cleanups.delete(cleanup)
            void cleanup()
          })

          session.on('pty', (acceptPty, _reject, info) => {
            state.term = { cols: info.cols, rows: info.rows, term: info.term }
            acceptPty()
          })
          session.on('window-change', (acceptWindowChange, _reject, info) => {
            state.term = {
              cols: info.cols,
              rows: info.rows,
              term: state.term?.term ?? 'xterm-256color'
            }
            try {
              state.activePty?.resize(info.cols, info.rows)
            } catch {
              // pty already exited
            }
            // ssh2 only passes an accept callback for requests with wantReply set;
            // window-change requests have wantReply === false.
            if (typeof acceptWindowChange === 'function') acceptWindowChange()
          })
          session.on('env', (acceptEnv, _reject, info) => {
            state.env[info.key] = info.val
            acceptEnv()
          })
          session.on('shell', (acceptShell) => {
            const stream: ServerChannel = acceptShell()
            handleShell(stream, state, shellPath, rootReal, log)
          })
          session.on('exec', (acceptExec, _reject, info) => {
            const stream: ServerChannel = acceptExec()
            handleExec(stream, state, info.command, shellPath, rootReal, log)
          })
          session.on('sftp', (acceptSftp) => {
            const stream = acceptSftp() as unknown as ServerSftpStream
            log('sftp subsystem started')
            attachSftp(stream, sandbox, log, (cleanupFn) => {
              cleanups.add(cleanupFn)
            })
          })
          session.on('subsystem', (_acceptSubsystem, rejectSubsystem) => {
            rejectSubsystem()
          })
        })
      })
    }
  )

  server.on('error', (error: Error) => log(`server error: ${errMessage(error)}`))

  const port = await new Promise<number>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('Server did not report a TCP address'))
        return
      }
      resolve(address.port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(requestedPort, host)
  })

  log(`dev sshd listening on ${host}:${port} (virtual root / -> ${rootReal})`)

  let closing: Promise<void> | undefined
  const close = async (): Promise<void> => {
    if (closing) return closing
    closing = (async () => {
      for (const cleanup of [...cleanups]) {
        try {
          await cleanup()
        } catch {
          // best effort
        }
      }
      cleanups.clear()
      for (const client of [...clients]) {
        try {
          ;(client as Connection & { end(): void }).end()
        } catch {
          // already closed
        }
      }
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
            ;(server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.()
          } catch {
            // ignore
          }
          done()
        }, CLOSE_GRACE_MS)
        timer.unref?.()
        try {
          server.close(() => done())
        } catch {
          done()
        }
      })
      clients.clear()
      log('dev sshd stopped')
    })()
    return closing
  }

  return {
    host,
    port,
    username,
    password,
    root: rootReal,
    sftpPathMode,
    fingerprint,
    hostKeyPath,
    close
  }
}
