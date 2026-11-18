import type { TermshelfApi } from '@shared/ipc-contract'
import type { AppErrorCode, AppErrorPayload, IpcResult } from '@shared/types'

/** True while the preload bridge is present. The real app always has it. */
export function hasBridge(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.termshelf === 'object' &&
    window.termshelf !== null
  )
}

export function getApi(): TermshelfApi {
  if (!hasBridge()) {
    throw new Error('The TermShelf bridge is unavailable. Restart the application.')
  }
  return window.termshelf
}

export function toErrorPayload(
  error: unknown,
  fallback: AppErrorCode = 'UNKNOWN'
): AppErrorPayload {
  if (error && typeof error === 'object') {
    const candidate = error as Partial<AppErrorPayload>
    if (typeof candidate.code === 'string' && typeof candidate.message === 'string') {
      const payload: AppErrorPayload = {
        code: candidate.code as AppErrorCode,
        message: candidate.message
      }
      if (candidate.details) payload.details = candidate.details
      return payload
    }
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message.length > 0) {
      return { code: fallback, message }
    }
  }
  if (typeof error === 'string' && error.length > 0) return { code: fallback, message: error }
  return { code: fallback, message: 'Something went wrong.' }
}

/**
 * Runs an IPC call and converts transport rejections (destroyed frame, missing
 * bridge, handler crash) into the same `{ ok: false }` shape so callers never
 * need a try/catch around an API call.
 */
export async function safeCall<T>(call: () => Promise<IpcResult<T>>): Promise<IpcResult<T>> {
  try {
    return await call()
  } catch (error) {
    return { ok: false, error: toErrorPayload(error) }
  }
}

const FRIENDLY_CODE_NAMES: Partial<Record<AppErrorCode, string>> = {
  SSH_AUTH_FAILED: 'Authentication failed',
  SSH_AUTH_REQUIRED: 'Authentication required',
  SSH_CONNECT_FAILED: 'Could not connect',
  SSH_SFTP_UNAVAILABLE: 'SFTP unavailable',
  SSH_DISCONNECTED: 'Connection lost',
  SHELL_SPAWN_FAILED: 'Could not start shell',
  FS_NOT_FOUND: 'Not found',
  FS_PERMISSION_DENIED: 'Permission denied',
  FS_EXISTS: 'Already exists',
  FS_INVALID_PATH: 'Invalid path',
  TRANSFER_CONFLICT: 'Transfer conflict',
  TRANSFER_CANCELLED: 'Transfer cancelled',
  TRANSFER_FAILED: 'Transfer failed',
  INVALID_ARGUMENT: 'Invalid request',
  NOT_SUPPORTED: 'Not supported',
  UNKNOWN: 'Unexpected error'
}

/** Human-friendly one-line message for toasts and inline errors. */
export function errorMessage(error: AppErrorPayload | null | undefined): string {
  if (!error) return ''
  const friendly = FRIENDLY_CODE_NAMES[error.code]
  if (!friendly) return error.message || 'Something went wrong.'
  if (!error.message) return friendly
  return error.message === friendly ? friendly : `${friendly}: ${error.message}`
}

/** Detail string used by the SSH/host-key flows. */
export function errorDetail(error: AppErrorPayload | null | undefined, key: string): string | null {
  const value = error?.details?.[key]
  return typeof value === 'string' ? value : null
}
