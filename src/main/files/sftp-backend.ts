import type { Readable, Writable } from 'node:stream'
import type { SFTPWrapper, Stats } from 'ssh2'
import type { DirListing, EntryKind, FileEntry, PathStyle } from '@shared/types'
import { MAX_DIR_ENTRIES } from '@shared/constants'
import { AppError } from '../errors'
import {
  assertAbsolutePath,
  breadcrumbsFor,
  dirnamePath,
  joinPath,
  normalizePath,
  parentPathFor
} from '../util/paths'
import { mapSftpError, type SftpOperation } from '../util/ssh-errors'
import type { FileBackend, WriteOptions } from './types'

const POSIX_STYLE: PathStyle = 'posix'

const S_IFMT = 0o170000
const S_IFDIR = 0o040000
const S_IFREG = 0o100000
const S_IFLNK = 0o120000

const STREAM_HIGH_WATER_MARK = 128 * 1024

export interface SftpBackendOptions {
  /** Overrides the detected home directory (`realpath('.')`). Mostly useful for tests. */
  homePath?: string
}

function isDirectory(stats: Stats): boolean {
  return (stats.mode & S_IFMT) === S_IFDIR
}

function isSymbolicLink(stats: Stats): boolean {
  return (stats.mode & S_IFMT) === S_IFLNK
}

function isFile(stats: Stats): boolean {
  return (stats.mode & S_IFMT) === S_IFREG
}

function kindForStats(stats: Stats): EntryKind {
  if (isSymbolicLink(stats)) return 'symlink'
  if (isDirectory(stats)) return 'dir'
  if (isFile(stats)) return 'file'
  return 'other'
}

/** Extracts a POSIX permission mask from an SFTP attribute block. */
function permissionsOf(stats: Stats): number {
  return typeof stats.mode === 'number' ? stats.mode & 0o777 : 0
}

function mtimeMsOf(stats: Stats): number {
  const mtime = typeof stats.mtime === 'number' ? stats.mtime : 0
  return mtime > 0 ? mtime * 1000 : 0
}

function sizeOf(stats: Stats): number {
  return typeof stats.size === 'number' && Number.isFinite(stats.size) ? stats.size : 0
}

/** Reads the target out of a `ls -l`-style longname (`... name -> target`) without extra round trips. */
function symlinkTargetFromLongname(longname: string | undefined): string | undefined {
  if (typeof longname !== 'string') return undefined
  const marker = longname.indexOf(' -> ')
  if (marker === -1) return undefined
  const target = longname.slice(marker + 4)
  return target || undefined
}

/** Returns false for entries that must never become a child `FileEntry`. */
function isSafeEntryName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('\0')
  )
}

function compareEntries(a: FileEntry, b: FileEntry): number {
  const aFolder = a.kind === 'dir'
  const bFolder = b.kind === 'dir'
  if (aFolder !== bFolder) return aFolder ? -1 : 1
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
}

/** Validates a single path segment passed from IPC (`mkdir`/`rename` names). */
function assertEntryName(name: string): string {
  if (
    typeof name !== 'string' ||
    !name ||
    name.length > 255 ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0')
  ) {
    throw new AppError('FS_INVALID_PATH', `Invalid name: ${String(name)}`)
  }
  return name
}

/**
 * Promisifies one ssh2 SFTP method call, translating protocol status codes into
 * {@link AppError}. `target` is used for error messages and `details.path`.
 */
function sftpCall<T>(
  target: string,
  operation: SftpOperation,
  invoke: (done: (error: Error | null | undefined, result?: T) => void) => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    try {
      invoke((error, result) => {
        if (error) reject(mapSftpError(error, target, operation))
        else resolve(result as T)
      })
    } catch (error) {
      reject(mapSftpError(error, target, operation))
    }
  })
}

/**
 * {@link FileBackend} implementation for a remote SSH session backed by an SFTP
 * subsystem. All paths are absolute POSIX paths as seen by the remote server.
 */
export class SftpBackend implements FileBackend {
  readonly pathStyle: PathStyle = POSIX_STYLE
  readonly isLocal = false

  private readonly sftp: SFTPWrapper
  private readonly providedHome: string | undefined
  private homePromise: Promise<string> | null = null

  constructor(sftp: SFTPWrapper, options?: SftpBackendOptions) {
    this.sftp = sftp
    this.providedHome = options?.homePath
  }

  static from(sftp: SFTPWrapper, options?: SftpBackendOptions): SftpBackend {
    return new SftpBackend(sftp, options)
  }

  /** Validates that a caller-supplied path is absolute and normalises it. */
  private checked(rawPath: string): string {
    assertAbsolutePath(POSIX_STYLE, rawPath)
    return normalizePath(POSIX_STYLE, rawPath)
  }

  private lstatRaw(target: string): Promise<Stats> {
    return sftpCall<Stats>(target, 'lstat', (done) => this.sftp.lstat(target, done))
  }

  private statRaw(target: string): Promise<Stats> {
    return sftpCall<Stats>(target, 'stat', (done) => this.sftp.stat(target, done))
  }

  private readdirRaw(
    target: string
  ): Promise<Array<{ filename: string; longname?: string; attrs: Stats }>> {
    return sftpCall(target, 'list', (done) => this.sftp.readdir(target, done))
  }

  private rmdirRaw(target: string): Promise<void> {
    return sftpCall<void>(target, 'rmdir', (done) => this.sftp.rmdir(target, done))
  }

  private unlinkRaw(target: string): Promise<void> {
    return sftpCall<void>(target, 'unlink', (done) => this.sftp.unlink(target, done))
  }

  async home(): Promise<string> {
    if (this.providedHome) return this.providedHome
    if (!this.homePromise) {
      this.homePromise = this.resolveHome()
      this.homePromise.catch(() => {
        this.homePromise = null
      })
    }
    return this.homePromise
  }

  private async resolveHome(): Promise<string> {
    const resolved = await sftpCall<string>('.', 'realpath', (done) =>
      this.sftp.realpath('.', done)
    )
    if (typeof resolved !== 'string' || !resolved.startsWith('/')) {
      throw new AppError('FS_NOT_FOUND', 'Remote server did not report a home directory')
    }
    return normalizePath(POSIX_STYLE, resolved)
  }

  async list(rawPath: string): Promise<DirListing> {
    const target = this.checked(rawPath)
    const listing = await this.readdirRaw(target)

    const entries: FileEntry[] = []
    for (const entry of listing) {
      if (!isSafeEntryName(entry.filename)) continue
      const stats = entry.attrs
      const kind = kindForStats(stats)
      const entryPath = joinPath(POSIX_STYLE, target, entry.filename)
      const symlinkTarget =
        kind === 'symlink' ? symlinkTargetFromLongname(entry.longname) : undefined
      entries.push({
        path: entryPath,
        name: entry.filename,
        kind,
        size: sizeOf(stats),
        mtimeMs: mtimeMsOf(stats),
        mode: permissionsOf(stats),
        ...(symlinkTarget ? { symlinkTarget } : {})
      })
    }

    entries.sort(compareEntries)
    const truncated = entries.length > MAX_DIR_ENTRIES
    return {
      path: target,
      parentPath: parentPathFor(POSIX_STYLE, target),
      breadcrumbs: breadcrumbsFor(POSIX_STYLE, target),
      entries: truncated ? entries.slice(0, MAX_DIR_ENTRIES) : entries,
      truncated
    }
  }

  async stat(rawPath: string): Promise<FileEntry> {
    const target = this.checked(rawPath)
    const stats = await this.lstatRaw(target)
    const kind = kindForStats(stats)
    let symlinkTarget: string | undefined
    if (kind === 'symlink') {
      try {
        symlinkTarget = await sftpCall<string>(target, 'readlink', (done) =>
          this.sftp.readlink(target, done)
        )
      } catch {
        symlinkTarget = undefined
      }
    }
    return {
      path: target,
      name: normalizePath(POSIX_STYLE, target).split('/').pop() ?? target,
      kind,
      size: sizeOf(stats),
      mtimeMs: mtimeMsOf(stats),
      mode: permissionsOf(stats),
      ...(symlinkTarget ? { symlinkTarget } : {})
    }
  }

  async realpath(rawPath: string): Promise<string> {
    const target = this.checked(rawPath)
    const resolved = await sftpCall<string>(target, 'realpath', (done) =>
      this.sftp.realpath(target, done)
    )
    return typeof resolved === 'string' && resolved.startsWith('/')
      ? normalizePath(POSIX_STYLE, resolved)
      : normalizePath(POSIX_STYLE, target)
  }

  async mkdir(parentPath: string, name: string): Promise<string> {
    const parent = this.checked(parentPath)
    const target = joinPath(POSIX_STYLE, parent, assertEntryName(name))
    await sftpCall<void>(target, 'mkdir', (done) => this.sftp.mkdir(target, done))
    return target
  }

  async rename(rawPath: string, newName: string): Promise<string> {
    const target = this.checked(rawPath)
    const destination = joinPath(
      POSIX_STYLE,
      dirnamePath(POSIX_STYLE, target),
      assertEntryName(newName)
    )
    await sftpCall<void>(target, 'rename', (done) => this.sftp.rename(target, destination, done))
    return destination
  }

  async remove(paths: string[], recursive: boolean): Promise<void> {
    for (const rawPath of paths) {
      const target = this.checked(rawPath)
      if (recursive) {
        try {
          await this.removeRecursive(target)
        } catch (error) {
          if (error instanceof AppError && error.code === 'FS_NOT_FOUND') continue
          throw error
        }
        continue
      }
      let stats: Stats
      try {
        stats = await this.lstatRaw(target)
      } catch (error) {
        if (error instanceof AppError && error.code === 'FS_NOT_FOUND') continue
        throw error
      }
      if (isDirectory(stats) && !isSymbolicLink(stats)) await this.rmdirRaw(target)
      else await this.unlinkRaw(target)
    }
  }

  /** Depth-first removal; symlinks are unlinked, never followed. */
  private async removeRecursive(target: string): Promise<void> {
    const stats = await this.lstatRaw(target)
    if (isDirectory(stats) && !isSymbolicLink(stats)) {
      const children = await this.readdirRaw(target)
      for (const child of children) {
        if (!isSafeEntryName(child.filename)) continue
        await this.removeRecursive(joinPath(POSIX_STYLE, target, child.filename))
      }
      await this.rmdirRaw(target)
      return
    }
    await this.unlinkRaw(target)
  }

  createReadStream(rawPath: string): Readable {
    const target = this.checked(rawPath)
    return this.sftp.createReadStream(target, { highWaterMark: STREAM_HIGH_WATER_MARK })
  }

  createWriteStream(rawPath: string, options?: WriteOptions): Writable {
    const target = this.checked(rawPath)
    const stream = this.sftp.createWriteStream(target, {
      flags: 'w',
      highWaterMark: STREAM_HIGH_WATER_MARK,
      ...(options?.mode !== undefined ? { mode: options.mode } : {})
    })
    if (options?.mtimeMs !== undefined) {
      const mtimeMs = options.mtimeMs
      // SFTP has no open-time mtime attribute; apply it once the handle closes.
      stream.once('close', () => {
        void this.setTimes(target, mtimeMs).catch(() => {
          // Metadata preservation is best effort, matching local downloads.
        })
      })
    }
    return stream
  }

  async setTimes(rawPath: string, mtimeMs: number): Promise<void> {
    const target = this.checked(rawPath)
    if (!Number.isFinite(mtimeMs)) {
      throw new AppError('INVALID_ARGUMENT', `Invalid timestamp for ${target}`)
    }
    const date = new Date(mtimeMs)
    await sftpCall<void>(target, 'setstat', (done) => this.sftp.utimes(target, date, date, done))
  }

  /** Touches the remote path through `stat` so callers can probe existence cheaply. */
  async exists(rawPath: string): Promise<boolean> {
    try {
      await this.statRaw(this.checked(rawPath))
      return true
    } catch (error) {
      if (error instanceof AppError && error.code === 'FS_NOT_FOUND') return false
      throw error
    }
  }
}
