import type { Breadcrumb, PathStyle } from '@shared/types'

export function separatorFor(style: PathStyle): string {
  return style === 'win32' ? '\\' : '/'
}

export function isAbsolutePath(style: PathStyle, input: string): boolean {
  const value = input.trim()
  if (!value) return false
  if (style === 'win32') {
    return (
      /^[a-zA-Z]:[\\/]/.test(value) ||
      /^\\\\[^\\/]+[\\/][^\\/]+/.test(value) ||
      /^[\\/]{2}\?[\\/]/.test(value)
    )
  }
  return value.startsWith('/')
}

/** Joins a child onto an absolute base path in the backend's path style. */
export function joinPath(style: PathStyle, base: string, child: string): string {
  if (!base) return child
  const separator = separatorFor(style)
  const trimmed =
    base.endsWith(separator) || base.endsWith('/') ? base.replace(/[\\/]+$/, '') : base
  if (!trimmed) return `${separator}${child}`
  return `${trimmed}${separator}${child}`
}

/** Removes trailing separators, but keeps filesystem roots intact. */
export function normalizePath(style: PathStyle, input: string): string {
  const value = input.trim()
  if (!value) return value
  const separator = separatorFor(style)
  if (style === 'win32') {
    if (/^[a-zA-Z]:[\\/]?$/.test(value)) return `${value.slice(0, 2).toUpperCase()}\\`
    if (/^\\\\[^\\]+\\?$/.test(value)) return value.replace(/\\+$/, '\\')
    return value.replace(/[\\/]+$/, '')
  }
  if (value === '/') return '/'
  const normalized = value.replace(/\/+$/, '')
  return normalized || separator
}

export function pathsEqual(style: PathStyle, a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b
  const left = normalizePath(style, a)
  const right = normalizePath(style, b)
  return style === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

export function fileNameFor(path: string, style: PathStyle): string {
  const value = path.replace(/[\\/]+$/, '')
  if (!value) return path
  if (style === 'win32' && /^[a-zA-Z]:$/.test(value)) return value
  const parts = value.split(/[\\/]/)
  return parts[parts.length - 1] || value
}

/**
 * Fallback parent computation for editable path bars where no DirListing is
 * available yet. Uses the backend's path style, never the local OS.
 */
export function parentPathFor(style: PathStyle, path: string): string | null {
  const normalized = normalizePath(style, path)
  if (style === 'win32') {
    if (/^[a-zA-Z]:\\$/.test(normalized) || /^\\\\[^\\]+\\?$/.test(normalized)) return null
    const next = normalized.replace(/\\[^\\]+$/, '')
    if (/^[a-zA-Z]:$/.test(next)) return `${next}\\`
    return next || null
  }
  if (normalized === '/') return null
  const next = normalized.replace(/\/[^/]+$/, '')
  return next || '/'
}

function crumb(name: string, path: string): Breadcrumb {
  return { name, path }
}

/** Builds breadcrumbs from a raw path string (used before a listing exists). */
export function breadcrumbsFromPath(style: PathStyle, path: string): Breadcrumb[] {
  const normalized = normalizePath(style, path)
  if (style === 'win32') {
    const unc = /^\\\\([^\\]+)\\([^\\]+)(.*)$/.exec(normalized)
    if (unc) {
      const server = unc[1] ?? ''
      const share = unc[2] ?? ''
      const base = `\\\\${server}\\${share}`
      const rest = (unc[3] ?? '').split(/[\\/]/).filter(Boolean)
      const crumbs: Breadcrumb[] = [crumb(`\\\\${server}`, `\\\\${server}`), crumb(share, base)]
      let current = base
      for (const part of rest) {
        current = joinPath('win32', current, part)
        crumbs.push(crumb(part, current))
      }
      return crumbs
    }
    const driveMatch = /^([a-zA-Z]:)\\?(.*)$/.exec(normalized)
    if (!driveMatch) return [crumb(normalized, normalized)]
    const drive = (driveMatch[1] ?? '').toUpperCase()
    const root = `${drive}\\`
    const crumbs: Breadcrumb[] = [crumb(drive, root)]
    const rest = (driveMatch[2] ?? '').split(/[\\/]/).filter(Boolean)
    let current = root
    for (const part of rest) {
      current = joinPath('win32', current, part)
      crumbs.push(crumb(part, current))
    }
    return crumbs
  }
  const crumbs: Breadcrumb[] = [crumb('/', '/')]
  const parts = normalized.split('/').filter(Boolean)
  let current = ''
  for (const part of parts) {
    current = `${current}/${part}`
    crumbs.push(crumb(part, current))
  }
  return crumbs
}

export function resolveChildPath(style: PathStyle, directory: string, child: string): string {
  return joinPath(style, directory, child)
}
