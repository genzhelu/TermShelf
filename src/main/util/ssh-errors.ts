import type { AppErrorCode } from '@shared/types'
import { AppError } from '../errors'

/** Operations that can fail on a remote filesystem; used to choose sensible error codes. */
export type SftpOperation =
  | 'list'
  | 'stat'
  | 'lstat'
  | 'realpath'
  | 'readlink'
  | 'mkdir'
  | 'rename'
  | 'remove'
  | 'unlink'
  | 'rmdir'
  | 'open'
  | 'read'
  | 'setstat'

/** ssh2 SFTP errors carry the protocol status code as a numeric `code` property. */
export interface SftpStatusError extends Error {
  code: number
}

const STATUS_MESSAGES: Record<number, string> = {
  1: 'Unexpected end of file',
  2: 'No such file or directory',
  3: 'Permission denied',
  4: 'Remote operation failed',
  5: 'Bad message',
  6: 'No connection',
  7: 'Connection lost',
  8: 'Operation not supported'
}

const CREATION_OPERATIONS = new Set<SftpOperation>(['mkdir', 'rename', 'setstat'])
const REMOVAL_OPERATIONS = new Set<SftpOperation>(['remove', 'unlink', 'rmdir'])

export function sftpStatusCode(error: unknown): number | undefined {
  if (
    error &&
    typeof error === 'object' &&
    typeof (error as { code?: unknown }).code === 'number'
  ) {
    const code = (error as { code: number }).code
    return Number.isFinite(code) ? code : undefined
  }
  return undefined
}

export function isSftpStatusError(error: unknown): error is SftpStatusError {
  return sftpStatusCode(error) !== undefined
}

function errorMessage(error: unknown): string | undefined {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error) return error
  return undefined
}

function codeForStatus(status: number, operation: SftpOperation): AppErrorCode {
  switch (status) {
    case 2:
      return 'FS_NOT_FOUND'
    case 3:
      return 'FS_PERMISSION_DENIED'
    case 4:
      // SFTP v3 reports most semantic failures with the generic FAILURE status.
      if (CREATION_OPERATIONS.has(operation) || REMOVAL_OPERATIONS.has(operation))
        return 'FS_EXISTS'
      return 'UNKNOWN'
    case 6:
    case 7:
      return 'SSH_DISCONNECTED'
    case 8:
      return 'NOT_SUPPORTED'
    default:
      return 'UNKNOWN'
  }
}

function withPath(message: string, target: string): string {
  return message.includes(target) ? message : `${message}: ${target}`
}

/** Wraps a channel-level failure (SFTP channel closed mid-operation) as a disconnect. */
function isChannelFailure(error: unknown): boolean {
  const level = (error as { level?: unknown } | undefined)?.level
  if (level === 'client-ssh' || level === 'client-socket') return true
  const message = errorMessage(error)?.toLowerCase() ?? ''
  return /no response|connection (?:lost|closed|reset)|channel (?:closed|failure)|not connected/.test(
    message
  )
}

/**
 * Maps a raw ssh2 SFTP error to an {@link AppError} whose code matches the shared
 * `AppErrorCode` union. Messages always include the affected path; no secrets can
 * appear in an SFTP error message.
 */
export function mapSftpError(
  error: unknown,
  target: string,
  operation: SftpOperation = 'stat'
): AppError {
  if (error instanceof AppError) return error
  const status = sftpStatusCode(error)
  if (status !== undefined) {
    const code = codeForStatus(status, operation)
    const detail = errorMessage(error) ?? STATUS_MESSAGES[status] ?? 'Remote filesystem error'
    return new AppError(code, withPath(detail, target), {
      path: target,
      operation,
      sftpCode: status
    })
  }
  if (isChannelFailure(error)) {
    return new AppError(
      'SSH_DISCONNECTED',
      withPath(errorMessage(error) ?? 'The SSH connection was lost', target),
      { path: target, operation }
    )
  }
  const detail = errorMessage(error) ?? 'Remote filesystem error'
  return new AppError('UNKNOWN', withPath(detail, target), { path: target, operation })
}

/**
 * Maps an error raised by the ssh2 client (connection, handshake or auth) to the
 * shared error codes. Host-key failures are detected by SshSession itself and
 * reported with full `HostKeyInfo`; this is the fallback classification.
 */
export function mapSshClientError(
  error: unknown,
  host: string,
  port: number,
  attempting: string
): AppError {
  if (error instanceof AppError) return error
  const level = (error as { level?: unknown } | undefined)?.level
  const message = errorMessage(error) ?? 'SSH connection failed'
  const target = `${host}:${port}`

  if (level === 'client-authentication' || /authentication|permission denied/i.test(message)) {
    return new AppError(
      'SSH_AUTH_FAILED',
      `SSH authentication failed for ${attempting} (${target})`,
      {
        host,
        port
      }
    )
  }
  if (level === 'client-timeout') {
    return new AppError('SSH_CONNECT_FAILED', `Timed out connecting to ${target}`, { host, port })
  }
  if (level === 'handshake' && /host key|host denied|verification/i.test(message)) {
    return new AppError('SSH_HOST_KEY_UNKNOWN', `Host key verification failed for ${target}`, {
      host,
      port
    })
  }
  return new AppError('SSH_CONNECT_FAILED', `Could not connect to ${target}: ${message}`, {
    host,
    port
  })
}
