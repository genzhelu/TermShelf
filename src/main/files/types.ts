import type { Readable, Writable } from 'node:stream'
import type { DirListing, FileEntry, PathStyle } from '@shared/types'

export interface WriteOptions {
  mode?: number
  mtimeMs?: number
}

/** Optional hooks for an optimised, cancellable file transfer implementation. */
export interface FileTransferHooks {
  signal?: AbortSignal
  onProgress?: (bytesTransferred: number) => void
}

/** Arguments for a fast path that the transfer engine uses when available. */
export interface FileTransferOptions extends FileTransferHooks {
  /** Absolute source path (local for uploads, backend path for downloads). */
  sourcePath: string
  /** Absolute destination path (backend path for uploads, local for downloads). */
  destinationPath: string
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

  /**
   * Optional pipelined upload of one local file to the backend. SFTP overrides
   * these to keep many requests in flight; without them the engine falls back to
   * a single ordered stream (much slower for downloads over latent links).
   */
  uploadFile?(localPath: string, remotePath: string, hooks?: FileTransferHooks): Promise<void>
  /** Optional pipelined download of one backend file to a local path. */
  downloadFile?(remotePath: string, localPath: string, hooks?: FileTransferHooks): Promise<void>
}
