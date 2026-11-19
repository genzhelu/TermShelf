import path from 'node:path'
import { AppError } from '../errors'

/** Validates and normalises an absolute Linux path used by a WSL session. */
export function normalizeLinuxPath(input: string): string {
  if (typeof input !== 'string' || !input.startsWith('/') || input.length > 4096) {
    throw new AppError('FS_INVALID_PATH', `Invalid Linux path: ${String(input)}`)
  }
  if (input.includes('\u0000')) throw new AppError('FS_INVALID_PATH', 'Path contains NUL')
  const normalized = path.posix.normalize(input)
  return normalized.startsWith('/') ? normalized : `/${normalized}`
}

/** Maps a Linux path to the corresponding path under a Windows UNC root (or a fake test root). */
export function linuxToNative(rootPath: string, linuxPath: string): string {
  const normalized = normalizeLinuxPath(linuxPath)
  const segments = normalized.split('/').filter(Boolean)
  return segments.length > 0 ? path.join(rootPath, ...segments) : rootPath
}

/** Strips Windows extended-path prefixes so realpath results can be compared. */
function normalizeNative(value: string): string {
  if (value.startsWith('\\\\?\\UNC\\')) return `\\\\${value.slice(8)}`
  if (value.startsWith('\\\\?\\')) return value.slice(4)
  return value
}

/**
 * Maps a resolved native path back to Linux style. Returns null when it lies
 * outside the configured root (e.g. a UNC realpath spelling we cannot undo).
 */
export function nativeToLinux(rootPath: string, nativePath: string): string | null {
  const root = path.resolve(normalizeNative(rootPath))
  const native = path.resolve(normalizeNative(nativePath))
  const caseInsensitive = process.platform === 'win32'
  const rootCmp = caseInsensitive ? root.toLowerCase() : root
  const nativeCmp = caseInsensitive ? native.toLowerCase() : native
  if (nativeCmp === rootCmp) return '/'
  if (!nativeCmp.startsWith(rootCmp + path.sep)) return null
  const relative = native
    .slice(root.length + 1)
    .split(path.sep)
    .filter(Boolean)
  return `/${relative.join('/')}`
}
