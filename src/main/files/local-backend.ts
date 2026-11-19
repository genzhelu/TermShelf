import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Readable, Writable } from 'node:stream'
import type { DirListing, EntryKind, FileEntry, PathStyle } from '@shared/types'
import { MAX_DIR_ENTRIES } from '@shared/constants'
import { AppError } from '../errors'
import type { FileBackend, WriteOptions } from './types'
import {
  assertAbsolutePath,
  breadcrumbsFor,
  joinPath,
  normalizePath,
  parentPathFor,
  pathStyleForPlatform
} from '../util/paths'

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let nextIndex = 0
  const workers = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    while (true) {
      const index = nextIndex
      nextIndex += 1
      if (index >= items.length) return
      results[index] = await fn(items[index]!)
    }
  })
  await Promise.all(workers)
  return results
}

function kindForStats(isDirectory: boolean, isSymbolicLink: boolean, isFile: boolean): EntryKind {
  if (isSymbolicLink) return 'symlink'
  if (isDirectory) return 'dir'
  if (isFile) return 'file'
  return 'other'
}

export class LocalBackend implements FileBackend {
  readonly pathStyle: PathStyle
  readonly isLocal = true

  constructor() {
    this.pathStyle = pathStyleForPlatform()
  }

  async home(): Promise<string> {
    return os.homedir()
  }

  localPathFor(backendPath: string): string {
    return backendPath
  }

  private checked(rawPath: string): string {
    assertAbsolutePath(this.pathStyle, rawPath)
    return normalizePath(this.pathStyle, rawPath)
  }

  async list(rawPath: string): Promise<DirListing> {
    const target = this.checked(rawPath)
    let dirents: fs.Dirent[]
    try {
      dirents = await fs.promises.readdir(target, { withFileTypes: true })
    } catch (error) {
      throw new AppError('FS_NOT_FOUND', `Cannot read folder ${target}`, {
        cause: (error as Error).message
      })
    }

    const entries = (
      await mapLimit(dirents, 32, async (dirent): Promise<FileEntry | null> => {
        const entryPath = joinPath(this.pathStyle, target, dirent.name)
        try {
          const stat = await fs.promises.lstat(entryPath)
          const kind = kindForStats(stat.isDirectory(), stat.isSymbolicLink(), stat.isFile())
          let symlinkTarget: string | undefined
          if (kind === 'symlink') {
            try {
              symlinkTarget = await fs.promises.readlink(entryPath)
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
          return null
        }
      })
    ).filter((entry): entry is FileEntry => entry !== null)

    entries.sort(compareEntries)
    const truncated = entries.length > MAX_DIR_ENTRIES
    return {
      path: target,
      parentPath: parentPathFor(this.pathStyle, target),
      breadcrumbs: breadcrumbsFor(this.pathStyle, target),
      entries: truncated ? entries.slice(0, MAX_DIR_ENTRIES) : entries,
      truncated
    }
  }

  async stat(rawPath: string): Promise<FileEntry> {
    const target = this.checked(rawPath)
    let stat: fs.Stats
    try {
      stat = await fs.promises.lstat(target)
    } catch {
      throw new AppError('FS_NOT_FOUND', `No such file or folder: ${target}`)
    }
    const kind = kindForStats(stat.isDirectory(), stat.isSymbolicLink(), stat.isFile())
    let symlinkTarget: string | undefined
    if (kind === 'symlink') {
      try {
        symlinkTarget = await fs.promises.readlink(target)
      } catch {
        // ignore
      }
    }
    return {
      path: target,
      name: path.basename(target),
      kind,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      mode: stat.mode & 0o777,
      ...(symlinkTarget ? { symlinkTarget } : {})
    }
  }

  async realpath(rawPath: string): Promise<string> {
    const target = this.checked(rawPath)
    try {
      return await fs.promises.realpath(target)
    } catch {
      throw new AppError('FS_NOT_FOUND', `No such file or folder: ${target}`)
    }
  }

  async mkdir(parentPath: string, name: string): Promise<string> {
    const parent = this.checked(parentPath)
    const target = joinPath(this.pathStyle, parent, name)
    try {
      await fs.promises.mkdir(target)
      return target
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EEXIST') throw new AppError('FS_EXISTS', `Folder already exists: ${name}`)
      throw error
    }
  }

  async rename(rawPath: string, newName: string): Promise<string> {
    const target = this.checked(rawPath)
    const destination = joinPath(this.pathStyle, path.dirname(target), newName)
    try {
      await fs.promises.rename(target, destination)
      return destination
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
      const target = this.checked(rawPath)
      let stat: fs.Stats
      try {
        stat = await fs.promises.lstat(target)
      } catch {
        continue
      }
      try {
        if (stat.isDirectory() && !stat.isSymbolicLink()) {
          if (recursive) await fs.promises.rm(target, { recursive: true, force: true })
          else await fs.promises.rmdir(target)
        } else {
          await fs.promises.unlink(target)
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'EACCES' || code === 'EPERM') {
          throw new AppError('FS_PERMISSION_DENIED', `Permission denied: ${target}`)
        }
        if (code === 'ENOTEMPTY') {
          throw new AppError('FS_EXISTS', `Folder is not empty: ${target}`)
        }
        throw error
      }
    }
  }

  createReadStream(rawPath: string): Readable {
    const target = this.checked(rawPath)
    return fs.createReadStream(target, { highWaterMark: 128 * 1024 })
  }

  createWriteStream(rawPath: string, options?: WriteOptions): Writable {
    const target = this.checked(rawPath)
    return fs.createWriteStream(target, {
      highWaterMark: 128 * 1024,
      ...(options?.mode !== undefined ? { mode: options.mode } : {})
    })
  }

  async setTimes(rawPath: string, mtimeMs: number): Promise<void> {
    const target = this.checked(rawPath)
    const mtime = new Date(mtimeMs)
    await fs.promises.utimes(target, mtime, mtime)
  }
}

function compareEntries(a: FileEntry, b: FileEntry): number {
  const aFolder = a.kind === 'dir'
  const bFolder = b.kind === 'dir'
  if (aFolder !== bFolder) return aFolder ? -1 : 1
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
}
