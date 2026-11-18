import fs from 'node:fs'
import type { Readable, Writable } from 'node:stream'
import type { OpenMode, SFTPWrapper, Stats } from 'ssh2'
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
import type { FileBackend, FileTransferHooks, WriteOptions } from './types'

const POSIX_STYLE: PathStyle = 'posix'

const S_IFMT = 0o170000
const S_IFDIR = 0o040000
const S_IFREG = 0o100000
const S_IFLNK = 0o120000

const STREAM_HIGH_WATER_MARK = 128 * 1024

/**
 * SFTP is latency-bound: a single read/write stream keeps only one request in
 * flight, so throughput collapses on links with even modest RTT. The fast path
 * below keeps many chunk requests in flight (similar to ssh2's fastGet/fastPut)
 * while still supporting progress reporting and cancellation.
 */
const TRANSFER_CONCURRENCY = 32
const TRANSFER_CHUNK_SIZE = 128 * 1024

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

  private openRaw(target: string, flags: OpenMode, mode = 0o666): Promise<Buffer> {
    return sftpCall<Buffer>(target, 'open', (done) =>
      this.sftp.open(target, flags, mode, (error, handle) => done(error, handle))
    )
  }

  private closeRaw(handle: Buffer): Promise<void> {
    return new Promise<void>((resolve) => {
      try {
        this.sftp.close(handle, () => resolve())
      } catch {
        resolve()
      }
    })
  }

  private readRaw(
    target: string,
    handle: Buffer,
    buffer: Buffer,
    length: number,
    position: number
  ): Promise<number> {
    return sftpCall<number>(target, 'read', (done) =>
      this.sftp.read(handle, buffer, 0, length, position, (error, bytesRead) =>
        done(error, bytesRead)
      )
    )
  }

  private writeRaw(
    target: string,
    handle: Buffer,
    buffer: Buffer,
    length: number,
    position: number
  ): Promise<void> {
    return sftpCall<void>(target, 'write', (done) =>
      this.sftp.write(handle, buffer, 0, length, position, (error) => done(error))
    )
  }

  /**
   * Pipelined SFTP upload. Several chunks are read locally and written remotely
   * concurrently, which is dramatically faster than a single ordered stream.
   * Honours `hooks.signal` and reports byte progress.
   */
  async uploadFile(
    localPath: string,
    rawRemotePath: string,
    hooks?: FileTransferHooks
  ): Promise<void> {
    const target = this.checked(rawRemotePath)
    const signal = hooks?.signal
    if (signal?.aborted) throw new AppError('TRANSFER_CANCELLED', 'Transfer cancelled')

    let localStats: fs.Stats
    try {
      localStats = await fs.promises.stat(localPath)
    } catch (error) {
      throw new AppError('FS_NOT_FOUND', `Cannot read local file ${localPath}`, {
        cause: (error as Error).message
      })
    }
    if (!localStats.isFile()) {
      throw new AppError('INVALID_ARGUMENT', `Not a file: ${localPath}`)
    }

    const localHandle = await fs.promises.open(localPath, 'r')
    let remoteHandle: Buffer | null = null
    let aborted = false
    const onAbort = (): void => {
      aborted = true
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    try {
      remoteHandle = await this.openRaw(target, 'w', localStats.mode & 0o777)
      const total = localStats.size
      if (total === 0) {
        hooks?.onProgress?.(0)
        return
      }

      const concurrency = Math.min(
        TRANSFER_CONCURRENCY,
        Math.max(1, Math.ceil(total / TRANSFER_CHUNK_SIZE))
      )
      let nextOffset = 0
      let transferred = 0
      let failure: unknown = null

      const worker = async (): Promise<void> => {
        const buffer = Buffer.allocUnsafe(TRANSFER_CHUNK_SIZE)
        while (!failure && !aborted) {
          const chunkStart = nextOffset
          nextOffset += TRANSFER_CHUNK_SIZE
          if (chunkStart >= total) return
          const chunkEnd = Math.min(chunkStart + TRANSFER_CHUNK_SIZE, total)
          let position = chunkStart
          while (position < chunkEnd && !failure && !aborted) {
            const length = Math.min(TRANSFER_CHUNK_SIZE, chunkEnd - position)
            let bytesRead: number
            try {
              const result = await localHandle.read(buffer, 0, length, position)
              bytesRead = result.bytesRead
            } catch (error) {
              failure = error
              return
            }
            if (bytesRead <= 0) {
              failure = new AppError(
                'TRANSFER_FAILED',
                `Unexpected end of local file: ${localPath}`
              )
              return
            }
            try {
              await this.writeRaw(target, remoteHandle!, buffer, bytesRead, position)
            } catch (error) {
              failure = error
              return
            }
            position += bytesRead
            transferred += bytesRead
            try {
              hooks?.onProgress?.(transferred)
            } catch {
              // A UI/progress callback must never fail the transfer.
            }
          }
        }
      }

      await Promise.all(Array.from({ length: concurrency }, () => worker()))
      if (aborted) throw new AppError('TRANSFER_CANCELLED', 'Transfer cancelled')
      if (failure) throw failure
    } finally {
      signal?.removeEventListener('abort', onAbort)
      try {
        await localHandle.close()
      } catch {
        // best effort
      }
      if (remoteHandle) await this.closeRaw(remoteHandle)
    }
  }

  /**
   * Pipelined SFTP download, mirroring {@link uploadFile}. Short reads from the
   * server are handled explicitly, so server-side chunk caps cannot corrupt data.
   */
  async downloadFile(
    rawRemotePath: string,
    localPath: string,
    hooks?: FileTransferHooks
  ): Promise<void> {
    const target = this.checked(rawRemotePath)
    const signal = hooks?.signal
    if (signal?.aborted) throw new AppError('TRANSFER_CANCELLED', 'Transfer cancelled')

    const remoteStats = await this.statRaw(target)
    if (isDirectory(remoteStats)) {
      throw new AppError('NOT_SUPPORTED', `Cannot download a directory as a file: ${target}`)
    }
    const total = sizeOf(remoteStats)

    const remoteHandle = await this.openRaw(target, 'r')
    let localHandle: fs.promises.FileHandle | null = null
    let aborted = false
    const onAbort = (): void => {
      aborted = true
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    try {
      localHandle = await fs.promises.open(localPath, 'w')
      if (total === 0) {
        hooks?.onProgress?.(0)
        return
      }
      const concurrency = Math.min(
        TRANSFER_CONCURRENCY,
        Math.max(1, Math.ceil(total / TRANSFER_CHUNK_SIZE))
      )
      let nextOffset = 0
      let transferred = 0
      let failure: unknown = null

      const writeAllLocal = async (
        buffer: Buffer,
        length: number,
        position: number
      ): Promise<void> => {
        let written = 0
        while (written < length) {
          const result = await localHandle!.write(
            buffer,
            written,
            length - written,
            position + written
          )
          if (result.bytesWritten <= 0) {
            throw new AppError('TRANSFER_FAILED', `Could not write local file: ${localPath}`)
          }
          written += result.bytesWritten
        }
      }

      const worker = async (): Promise<void> => {
        const buffer = Buffer.allocUnsafe(TRANSFER_CHUNK_SIZE)
        while (!failure && !aborted) {
          const chunkStart = nextOffset
          nextOffset += TRANSFER_CHUNK_SIZE
          if (chunkStart >= total) return
          const chunkEnd = Math.min(chunkStart + TRANSFER_CHUNK_SIZE, total)
          let position = chunkStart
          while (position < chunkEnd && !failure && !aborted) {
            const length = Math.min(TRANSFER_CHUNK_SIZE, chunkEnd - position)
            let bytesRead: number
            try {
              bytesRead = await this.readRaw(target, remoteHandle, buffer, length, position)
            } catch (error) {
              failure = error
              return
            }
            if (bytesRead <= 0) {
              failure = new AppError('TRANSFER_FAILED', `Unexpected end of remote file: ${target}`)
              return
            }
            try {
              await writeAllLocal(buffer, bytesRead, position)
            } catch (error) {
              failure = error
              return
            }
            position += bytesRead
            transferred += bytesRead
            try {
              hooks?.onProgress?.(transferred)
            } catch {
              // ignore progress callback failures
            }
          }
        }
      }

      await Promise.all(Array.from({ length: concurrency }, () => worker()))
      if (aborted) throw new AppError('TRANSFER_CANCELLED', 'Transfer cancelled')
      if (failure) throw failure
    } finally {
      signal?.removeEventListener('abort', onAbort)
      if (localHandle) {
        try {
          await localHandle.close()
        } catch {
          // best effort
        }
      }
      await this.closeRaw(remoteHandle)
    }
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
