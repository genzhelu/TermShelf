import fs from 'node:fs'
import path from 'node:path'
import type { Readable, Writable } from 'node:stream'
import type { DirListing, EntryKind, FileEntry, PathStyle } from '@shared/types'
import { MAX_DIR_ENTRIES } from '@shared/constants'
import { AppError } from '../errors'
import { linuxToNative, nativeToLinux, normalizeLinuxPath } from '../wsl/paths'
import type { FileBackend, WriteOptions } from './types'
import { breadcrumbsFor, joinPath, parentPathFor } from '../util/paths'

const POSIX: PathStyle = 'posix'

function kindForStats(isDirectory: boolean, isSymbolicLink: boolean, isFile: boolean): EntryKind {
  if (isSymbolicLink) return 'symlink'
  if (isDirectory) return 'dir'
  if (isFile) return 'file'
  return 'other'
}

function compareEntries(a: FileEntry, b: FileEntry): number {
  const aFolder = a.kind === 'dir'
  const bFolder = b.kind === 'dir'
  if (aFolder !== bFolder) return aFolder ? -1 : 1
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      results[index] = await fn(items[index]!)
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * FileBackend for a WSL distribution. It exposes Linux/POSIX paths to the
 * renderer while accessing the same files through the Windows UNC mount
 * (\\wsl.localhost\<distro>\... or \\wsl$\<distro>\...). A null root creates a
 * terminal-only session whose file operations fail with WSL_FS_UNAVAILABLE.
 */
export class WslBackend implements FileBackend {
  readonly pathStyle: PathStyle = POSIX
  readonly isLocal = false

  constructor(
    private readonly rootPath: string | null,
    private readonly homePath: string
  ) {}

  async home(): Promise<string> {
    return this.homePath
  }

  private assertRoot(): string {
    if (!this.rootPath) {
      throw new AppError(
        'WSL_FS_UNAVAILABLE',
        'The WSL filesystem is not accessible from Windows. Start the distribution and retry.'
      )
    }
    return this.rootPath
  }

  private checked(rawPath: string): { linuxPath: string; nativePath: string } {
    const linuxPath = normalizeLinuxPath(rawPath)
    return { linuxPath, nativePath: linuxToNative(this.assertRoot(), linuxPath) }
  }

  async list(rawPath: string): Promise<DirListing> {
    const { linuxPath, nativePath } = this.checked(rawPath)
    let dirents: fs.Dirent[]
    try {
      dirents = await fs.promises.readdir(nativePath, { withFileTypes: true })
    } catch (error) {
      throw new AppError('FS_NOT_FOUND', `Cannot read WSL folder ${linuxPath}`, {
        cause: (error as Error).message
      })
    }

    const entries = (
      await mapLimit(dirents, 32, async (dirent): Promise<FileEntry | null> => {
        const entryPath = joinPath(POSIX, linuxPath, dirent.name)
        const entryNative = path.join(nativePath, dirent.name)
        try {
          const stat = await fs.promises.lstat(entryNative)
          const kind = kindForStats(stat.isDirectory(), stat.isSymbolicLink(), stat.isFile())
          let symlinkTarget: string | undefined
          if (kind === 'symlink') {
            try {
              symlinkTarget = await fs.promises.readlink(entryNative)
            } catch {
              symlinkTarget = undefined
            }
          }
          return {
            path: entryPath,
            name: dirent.name,
            kind,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            mode: stat.mode & 0o777,
            ...(symlinkTarget ? { symlinkTarget } : {})
          }
        } catch {
          // Linux filenames that Windows cannot address over UNC are skipped.
          return null
        }
      })
    ).filter((entry): entry is FileEntry => entry !== null)

    entries.sort(compareEntries)
    const truncated = entries.length > MAX_DIR_ENTRIES
    return {
      path: linuxPath,
      parentPath: parentPathFor(POSIX, linuxPath),
      breadcrumbs: breadcrumbsFor(POSIX, linuxPath),
      entries: truncated ? entries.slice(0, MAX_DIR_ENTRIES) : entries,
      truncated
    }
  }

  async stat(rawPath: string): Promise<FileEntry> {
    const { linuxPath, nativePath } = this.checked(rawPath)
    let stat: fs.Stats
    try {
      stat = await fs.promises.lstat(nativePath)
    } catch {
      throw new AppError('FS_NOT_FOUND', `No such file or folder: ${linuxPath}`)
    }
    const kind = kindForStats(stat.isDirectory(), stat.isSymbolicLink(), stat.isFile())
    let symlinkTarget: string | undefined
    if (kind === 'symlink') {
      try {
        symlinkTarget = await fs.promises.readlink(nativePath)
      } catch {
        symlinkTarget = undefined
      }
    }
    return {
      path: linuxPath,
      name: path.posix.basename(linuxPath),
      kind,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      mode: stat.mode & 0o777,
      ...(symlinkTarget ? { symlinkTarget } : {})
    }
  }

  async realpath(rawPath: string): Promise<string> {
    const { linuxPath, nativePath } = this.checked(rawPath)
    try {
      const resolved = await fs.promises.realpath(nativePath)
      return nativeToLinux(this.assertRoot(), resolved) ?? linuxPath
    } catch {
      throw new AppError('FS_NOT_FOUND', `No such file or folder: ${linuxPath}`)
    }
  }

  async mkdir(parentPath: string, name: string): Promise<string> {
    const parent = this.checked(parentPath)
    const targetLinux = joinPath(POSIX, parent.linuxPath, name)
    const targetNative = linuxToNative(this.assertRoot(), targetLinux)
    try {
      await fs.promises.mkdir(targetNative)
      return targetLinux
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new AppError('FS_EXISTS', `Folder already exists: ${name}`)
      }
      throw error
    }
  }

  async rename(rawPath: string, newName: string): Promise<string> {
    const { linuxPath, nativePath } = this.checked(rawPath)
    const destinationLinux = joinPath(POSIX, path.posix.dirname(linuxPath), newName)
    const destinationNative = linuxToNative(this.assertRoot(), destinationLinux)
    try {
      await fs.promises.rename(nativePath, destinationNative)
      return destinationLinux
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EEXIST' || code === 'EPERM' || code === 'ENOTEMPTY') {
        throw new AppError('FS_EXISTS', `Cannot rename: ${newName} already exists`)
      }
      throw error
    }
  }

  async remove(paths: string[], recursive: boolean): Promise<void> {
    for (const rawPath of paths) {
      const { nativePath } = this.checked(rawPath)
      let stat: fs.Stats
      try {
        stat = await fs.promises.lstat(nativePath)
      } catch {
        continue
      }
      try {
        if (stat.isDirectory() && !stat.isSymbolicLink()) {
          if (recursive) await fs.promises.rm(nativePath, { recursive: true, force: true })
          else await fs.promises.rmdir(nativePath)
        } else {
          await fs.promises.unlink(nativePath)
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'EACCES' || code === 'EPERM') {
          throw new AppError('FS_PERMISSION_DENIED', `Permission denied: ${rawPath}`)
        }
        throw error
      }
    }
  }

  createReadStream(rawPath: string): Readable {
    return fs.createReadStream(this.checked(rawPath).nativePath, { highWaterMark: 128 * 1024 })
  }

  createWriteStream(rawPath: string, options?: WriteOptions): Writable {
    return fs.createWriteStream(this.checked(rawPath).nativePath, {
      highWaterMark: 128 * 1024,
      ...(options?.mode !== undefined ? { mode: options.mode } : {})
    })
  }

  async setTimes(rawPath: string, mtimeMs: number): Promise<void> {
    const { nativePath } = this.checked(rawPath)
    const mtime = new Date(mtimeMs)
    await fs.promises.utimes(nativePath, mtime, mtime)
  }
}
