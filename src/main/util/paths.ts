import path from 'node:path'
import type { Breadcrumb, PathStyle, Platform } from '@shared/types'
import { AppError } from '../errors'

export function pathStyleForPlatform(platform: NodeJS.Platform = process.platform): PathStyle {
  return platform === 'win32' ? 'win32' : 'posix'
}

export function joinPath(style: PathStyle, ...parts: string[]): string {
  return style === 'win32' ? path.win32.join(...parts) : path.posix.join(...parts)
}

export function dirnamePath(style: PathStyle, value: string): string {
  return style === 'win32' ? path.win32.dirname(value) : path.posix.dirname(value)
}

export function basenamePath(style: PathStyle, value: string): string {
  return style === 'win32' ? path.win32.basename(value) : path.posix.basename(value)
}

export function normalizePath(style: PathStyle, value: string): string {
  return style === 'win32' ? path.win32.normalize(value) : path.posix.normalize(value)
}

export function isAbsolutePath(style: PathStyle, value: string): boolean {
  return style === 'win32' ? path.win32.isAbsolute(value) : path.posix.isAbsolute(value)
}

export function assertAbsolutePath(style: PathStyle, value: string): void {
  if (!value || value.length > 4096 || !isAbsolutePath(style, value)) {
    throw new AppError('FS_INVALID_PATH', `Invalid path: ${value}`)
  }
}

function splitRoot(
  style: PathStyle,
  value: string
): { breadcrumbs: Breadcrumb[]; parent: string | null } {
  const normalized = normalizePath(style, value)
  const root = style === 'win32' ? path.win32.parse(normalized).root : '/'

  if (normalized === root) {
    return {
      breadcrumbs: [{ name: root === '/' ? '/' : root.replace(/[\\/]+$/, ''), path: root }],
      parent: null
    }
  }

  const breadcrumbs: Breadcrumb[] = [
    { name: root === '/' ? '/' : root.replace(/[\\/]+$/, ''), path: root }
  ]
  const rest = normalized.slice(root.length)
  const segments = rest.split(/[\\/]+/).filter(Boolean)
  let current = root
  for (const segment of segments) {
    current = joinPath(style, current, segment)
    breadcrumbs.push({ name: segment, path: current })
  }
  const parent = breadcrumbs.length > 1 ? breadcrumbs[breadcrumbs.length - 2]!.path : null
  return { breadcrumbs, parent }
}

export function breadcrumbsFor(style: PathStyle, value: string): Breadcrumb[] {
  return splitRoot(style, value).breadcrumbs
}

export function parentPathFor(style: PathStyle, value: string): string | null {
  return splitRoot(style, value).parent
}

export function splitNameExtension(name: string): { base: string; extension: string } {
  const extension = path.extname(name)
  if (!extension || extension === name) return { base: name, extension: '' }
  return { base: name.slice(0, -extension.length), extension }
}

/** Finds a non-colliding name using the `name (1).ext` convention. */
export function nextAvailableName(name: string, exists: (candidate: string) => boolean): string {
  if (!exists(name)) return name
  const { base, extension } = splitNameExtension(name)
  for (let index = 1; index < 10_000; index += 1) {
    const candidate = `${base} (${index})${extension}`
    if (!exists(candidate)) return candidate
  }
  const stamp = Date.now().toString(36)
  return `${base}-${stamp}${extension}`
}

const WINDOWS_RESERVED = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9'
])

/**
 * Makes a remote/POSIX filename safe for writing into the local OS. Returns the
 * original name when no change is needed.
 */
export function sanitizeLocalFilename(
  name: string,
  platform: Platform = process.platform as Platform
): string {
  let result = name
  if (platform === 'win32') {
    result = result.replace(/[<>:"\\/|?*\u0000-\u001f]/g, '_')
    result = result.replace(/[. ]+$/g, '')
    if (!result) result = 'download'
    const stem = result.split('.')[0]?.toLowerCase() ?? ''
    if (WINDOWS_RESERVED.has(stem)) result = `_${result}`
  } else if (platform === 'darwin') {
    result = result.replace(/[/\u0000]/g, '_')
  } else {
    result = result.replace(/[/\u0000]/g, '_')
  }
  if (!result.trim()) result = 'download'
  if (result.length > 200) {
    const { extension } = splitNameExtension(result)
    result = result.slice(0, 200 - extension.length) + extension
  }
  return result
}

/** Quote a path for POSIX shell command strings (bash/zsh/fish). */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
