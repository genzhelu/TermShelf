const BYTE_UNITS = ['KB', 'MB', 'GB', 'TB', 'PB'] as const

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(digits)} ${BYTE_UNITS[unit]}`
}

const numberFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })
const compactFormatter = new Intl.NumberFormat(undefined, {
  notation: 'compact',
  maximumFractionDigits: 1
})

export function formatCount(count: number): string {
  return numberFormatter.format(count)
}

export function formatCompactCount(count: number): string {
  return compactFormatter.format(count)
}

export function pluralize(count: number, singular: string, plural?: string): string {
  return count === 1 ? singular : (plural ?? `${singular}s`)
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

export function formatTime(ms: number): string {
  const date = new Date(ms)
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

/** Compact timestamp for the file list (terminal-style, not locale heavy). */
export function formatDate(ms: number | null | undefined): string {
  if (!ms || !Number.isFinite(ms)) return '—'
  const date = new Date(ms)
  const now = new Date()
  if (date.toDateString() === now.toDateString()) return formatTime(ms)
  const month = MONTHS[date.getMonth()]
  if (date.getFullYear() === now.getFullYear()) {
    return `${month} ${date.getDate()} ${formatTime(ms)}`
  }
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

export function formatDateTime(ms: number | null | undefined): string {
  if (!ms || !Number.isFinite(ms)) return 'Unknown'
  const date = new Date(ms)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${formatTime(ms)}`
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`
  const seconds = Math.round(ms / 100) / 10
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  if (minutes < 60) return `${minutes}m ${rest}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

export function formatRate(bytes: number, ms: number): string {
  if (!Number.isFinite(bytes) || !Number.isFinite(ms) || ms <= 0 || bytes <= 0) return '—'
  return `${formatBytes((bytes / ms) * 1000)}/s`
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g

/** Trims/sanitizes a terminal title so it is safe to render and short enough for a tab. */
export function sanitizeTitle(raw: string, maxLength = 60): string {
  const cleaned = raw.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim()
  if (cleaned.length <= maxLength) return cleaned
  return `${cleaned.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`
}

/** Shortens the middle of long paths/strings: `/home/us…/deep/project`. */
export function truncateMiddle(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  const keep = maxLength - 1
  const head = Math.ceil(keep / 2)
  const tail = keep - head
  return `${text.slice(0, head)}…${tail > 0 ? text.slice(-tail) : ''}`
}

export function isHiddenName(name: string): boolean {
  return name.startsWith('.') && name !== '.' && name !== '..'
}

export function percent(done: number, total: number): number {
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return 0
  return Math.min(100, Math.max(0, (done / total) * 100))
}
