import type { Platform, PathStyle } from '@shared/types'

/** Accepts a platform or a session path style; both use the same win32/posix split. */
type PlatformOrStyle = Platform | PathStyle

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g

function decodePath(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

function isWin32Style(value: PlatformOrStyle): boolean {
  return value === 'win32'
}

/**
 * Parses the payload of an OSC 7 (current working directory) sequence emitted
 * by shells as `file://<host>/<path>` into an absolute path in the style the
 * session's file backend expects.
 *
 * Handles percent-encoded paths, raw paths, Windows drive paths, and the
 * MSYS/Cygwin style `/C:/Users/...` produced by some terminals. Returns null
 * when the payload is not a usable absolute path for the given style; callers
 * should then ignore the sequence.
 */
export function parseOsc7Path(data: string, platform: PlatformOrStyle): string | null {
  if (typeof data !== 'string') return null
  let raw = data.replace(CONTROL_CHARS, '').trim()
  if (!raw) return null

  if (/^file:\/\//i.test(raw)) {
    let rest = raw.slice('file://'.length)
    if (rest.startsWith('/')) {
      // `file:///home/user`: empty authority, path begins immediately.
      raw = rest
    } else if (isWin32Style(platform) && /^[a-zA-Z]:[\\/]/.test(rest)) {
      // Non-standard but seen: `file://C:/Users/name`
      raw = rest
    } else {
      const slash = rest.indexOf('/')
      if (slash === -1) return null
      rest = rest.slice(slash)
      raw = rest
    }
  }

  let decoded = decodePath(raw)
  if (!decoded) return null

  if (isWin32Style(platform)) {
    if (/^\/[a-zA-Z]:[\\/]/.test(decoded)) decoded = decoded.slice(1)
    if (/^\/[a-zA-Z]:$/.test(decoded)) decoded = decoded.slice(1)
    const isDrive = /^[a-zA-Z]:[\\/]/.test(decoded)
    const isUnc = /^\\\\[^\\/]+[\\/]/.test(decoded)
    if (!isDrive && !isUnc) return null
    // Normalize forward slashes from shells that emit them on Windows.
    return decoded.replace(/\//g, '\\').replace(/\\\\{2,}/g, '\\\\')
  }

  if (!decoded.startsWith('/')) return null
  if (decoded.length > 4096) return null
  return decoded
}

/** Extracts the host portion of an OSC 7 payload, when present. */
export function parseOsc7Host(data: string): string | null {
  const match = /^file:\/\/([^/]*)/i.exec(data.replace(CONTROL_CHARS, '').trim())
  if (!match) return null
  const host = match[1] ?? ''
  if (!host || host.toLowerCase() === 'localhost') return null
  try {
    return decodeURIComponent(host)
  } catch {
    return host
  }
}
