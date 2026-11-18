import type { AppErrorCode, AppErrorPayload, IpcResult } from '@shared/types'

/** Typed application error that can cross the IPC boundary without leaking internals. */
export class AppError extends Error {
  readonly code: AppErrorCode
  readonly details?: Record<string, unknown>

  constructor(code: AppErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.details = details
  }

  toPayload(): AppErrorPayload {
    return {
      code: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {})
    }
  }
}

const SYSTEM_CODES: Record<string, AppErrorCode> = {
  ENOENT: 'FS_NOT_FOUND',
  EACCES: 'FS_PERMISSION_DENIED',
  EPERM: 'FS_PERMISSION_DENIED',
  EEXIST: 'FS_EXISTS',
  ENOTDIR: 'FS_NOT_FOUND',
  EISDIR: 'FS_EXISTS',
  ENOTEMPTY: 'FS_EXISTS',
  ENAMETOOLONG: 'FS_INVALID_PATH',
  EINVAL: 'FS_INVALID_PATH'
}

export function toErrorPayload(
  error: unknown,
  fallback: AppErrorCode = 'UNKNOWN'
): AppErrorPayload {
  if (error instanceof AppError) return error.toPayload()
  if (error && typeof error === 'object') {
    const err = error as { code?: unknown; message?: unknown }
    const message = typeof err.message === 'string' ? err.message : 'Unexpected error'
    if (typeof err.code === 'string') {
      const mapped = SYSTEM_CODES[err.code]
      if (mapped) return { code: mapped, message }
    }
    return { code: fallback, message }
  }
  if (typeof error === 'string') return { code: fallback, message: error }
  return { code: fallback, message: 'Unexpected error' }
}

export function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data }
}

export function fail(error: unknown, fallback: AppErrorCode = 'UNKNOWN'): IpcResult<never> {
  return { ok: false, error: toErrorPayload(error, fallback) }
}
