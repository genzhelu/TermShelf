import type { AppErrorPayload, HostKeyInfo } from '@shared/types'

export interface HostKeyPrompt {
  hostKey: HostKeyInfo
  mismatch: boolean
  expectedFingerprint: string | null
}

function asHostKey(value: unknown): HostKeyInfo | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<HostKeyInfo>
  if (
    typeof candidate.host !== 'string' ||
    typeof candidate.port !== 'number' ||
    typeof candidate.algorithm !== 'string' ||
    typeof candidate.fingerprint !== 'string'
  ) {
    return null
  }
  return {
    host: candidate.host,
    port: candidate.port,
    algorithm: candidate.algorithm,
    fingerprint: candidate.fingerprint
  }
}

function readExpectedFingerprint(details: Record<string, unknown> | undefined): string | null {
  if (!details) return null
  const direct = details.expectedFingerprint ?? details.expected
  if (typeof direct === 'string') return direct
  const record = asHostKey(direct)
  if (record) return record.fingerprint
  return null
}

/**
 * Extracts the host-key challenge from a createSsh error payload. The main
 * process attaches `details.hostKey` for SSH_HOST_KEY_UNKNOWN/MISMATCH and may
 * attach the previously trusted fingerprint.
 */
export function hostKeyPromptFromError(error: AppErrorPayload): HostKeyPrompt | null {
  if (error.code !== 'SSH_HOST_KEY_UNKNOWN' && error.code !== 'SSH_HOST_KEY_MISMATCH') return null
  const details = error.details
  const hostKey =
    asHostKey(details?.hostKey) ??
    asHostKey(details?.knownHost) ??
    asHostKey(details) ??
    asHostKey(error)
  if (!hostKey) return null
  return {
    hostKey,
    mismatch: error.code === 'SSH_HOST_KEY_MISMATCH',
    expectedFingerprint: readExpectedFingerprint(details)
  }
}
