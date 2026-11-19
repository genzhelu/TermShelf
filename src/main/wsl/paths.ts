import path from 'node:path'
import { AppError } from '../errors'

const WINDOWS_INVALID_CHARS = /[<>:"|?*\u0000-\u001f]/
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i

/** True when a Linux name can be addressed without Win32 reinterpreting it. */
export function isWin32SafeComponent(component: string): boolean {
  if (
    component.length === 0 ||
    component.length > 255 ||
    component === '.' ||
    component === '..' ||
    component.includes('/') ||
    component.includes('\\') ||
    component.endsWith('.') ||
    component.endsWith(' ') ||
    WINDOWS_INVALID_CHARS.test(component) ||
    WINDOWS_RESERVED.test(component.trim())
  ) {
    return false
  }
  return true
}

/** Validates and normalises an absolute Linux path used by a WSL session. */
export function normalizeLinuxPath(input: string): string {
  if (typeof input !== 'string' || !input.startsWith('/') || input.length > 4096) {
    throw new AppError('FS_INVALID_PATH', `Invalid Linux path: ${String(input)}`)
  }
  if (input.includes('\u0000')) throw new AppError('FS_INVALID_PATH', 'Path contains NUL')
  // A backslash is a valid Linux filename character but a Win32 separator when
  // the path travels through the UNC bridge; using it would address another
  // file. Reject it explicitly instead of silently mapping to a different path.
  if (input.includes('\\')) {
    throw new AppError(
      'FS_INVALID_PATH',
      'Linux paths containing a backslash cannot be accessed through the Windows WSL bridge'
    )
  }
  const normalized = path.posix.normalize(input)
  const safe = normalized.startsWith('/') ? normalized : `/${normalized}`
  for (const component of safe.split('/')) {
    if (component && !isWin32SafeComponent(component)) {
      throw new AppError(
        'FS_INVALID_PATH',
        `Linux path component cannot be represented safely over the Windows WSL bridge: ${component}`
      )
    }
  }
  return safe
}

/** Validates a single new entry name before it is joined into a WSL path. */
export function validateLinuxEntryName(name: string): string {
  if (typeof name !== 'string' || !isWin32SafeComponent(name)) {
    throw new AppError('FS_INVALID_PATH', `Invalid WSL entry name: ${String(name)}`)
  }
  return name
}

function isUncPath(value: string): boolean {
  return /^\\\\[^\\]+\\/.test(value) || /^\\\\\?\\UNC\\/i.test(value)
}

/** Chooses Win32 path rules when either side is a Windows UNC path. */
function pathApiFor(...values: string[]): path.PlatformPath {
  return values.some((value) => isUncPath(value)) ? path.win32 : path
}

/** Maps a Linux path to the corresponding path under a Windows UNC root (or a fake test root). */
export function linuxToNative(rootPath: string, linuxPath: string): string {
  const normalized = normalizeLinuxPath(linuxPath)
  const segments = normalized.split('/').filter(Boolean)
  const api = pathApiFor(rootPath)
  return segments.length > 0 ? api.join(rootPath, ...segments) : rootPath
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
  const api = pathApiFor(rootPath, nativePath)
  const root = api.resolve(normalizeNative(rootPath))
  const native = api.resolve(normalizeNative(nativePath))
  const caseInsensitive = api === path.win32 || process.platform === 'win32'
  const rootCmp = caseInsensitive ? root.toLowerCase() : root
  const nativeCmp = caseInsensitive ? native.toLowerCase() : native
  if (nativeCmp === rootCmp) return '/'
  // UNC share roots resolve with a trailing separator; do not append another.
  const rootPrefix = rootCmp.endsWith(api.sep) ? rootCmp : `${rootCmp}${api.sep}`
  if (!nativeCmp.startsWith(rootPrefix)) return null
  // Compare case-folded strings, but slice the original path: lowercasing a
  // Unicode component (e.g. İ -> i̇) can change its code-unit length.
  const originalPrefix = root.endsWith(api.sep) ? root : `${root}${api.sep}`
  const relative = native.slice(originalPrefix.length).split(api.sep).filter(Boolean)
  return relative.length > 0 ? `/${relative.join('/')}` : '/'
}
