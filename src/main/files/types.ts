import type { Readable, Writable } from 'node:stream'
import type { DirListing, FileEntry, PathStyle } from '@shared/types'

export interface WriteOptions {
  mode?: number
  mtimeMs?: number
}

/**
 * Unified filesystem access for local and SSH/SFTP sessions. All paths are
 * absolute in the backend's own path style; callers never mix styles.
 */
export interface FileBackend {
  readonly pathStyle: PathStyle
  readonly isLocal: boolean
  home(): Promise<string>
  list(path: string): Promise<DirListing>
  stat(path: string): Promise<FileEntry>
  realpath(path: string): Promise<string>
  /** Creates a directory and returns its absolute path. */
  mkdir(parentPath: string, name: string): Promise<string>
  /** Renames within the same directory and returns the new absolute path. */
  rename(path: string, newName: string): Promise<string>
  remove(paths: string[], recursive: boolean): Promise<void>
  createReadStream(path: string): Readable
  createWriteStream(path: string, options?: WriteOptions): Writable
  setTimes(path: string, mtimeMs: number): Promise<void>
}
