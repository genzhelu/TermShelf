import crypto from 'node:crypto'
import ssh2 from 'ssh2'
import type { HostKeyInfo } from '@shared/types'

/** OpenSSH-style SHA-256 fingerprint prefix. */
export const FINGERPRINT_PREFIX = 'SHA256:'

/** ssh wire format allows algorithm names far shorter than this; keeps parsing bounded. */
const MAX_ALGORITHM_NAME_LENGTH = 64

const PRINTABLE_ALGORITHM = /^[a-z0-9@._+-]+$/i

function base64WithoutPadding(buffer: Buffer): string {
  return buffer.toString('base64').replace(/=+$/, '')
}

/**
 * Computes the OpenSSH-style SHA-256 fingerprint of a raw host key blob.
 * Returns e.g. `SHA256:VYl2y3Wm...` (base64, trailing padding stripped).
 */
export function fingerprintKey(rawKey: Buffer): string {
  const digest = crypto.createHash('sha256').update(rawKey).digest()
  return FINGERPRINT_PREFIX + base64WithoutPadding(digest)
}

function algorithmFromWireFormat(rawKey: Buffer): string | null {
  if (!Buffer.isBuffer(rawKey) || rawKey.length < 5) return null
  const length = rawKey.readUInt32BE(0)
  if (length < 1 || length > MAX_ALGORITHM_NAME_LENGTH || length + 4 > rawKey.length) return null
  const name = rawKey.subarray(4, 4 + length).toString('latin1')
  return PRINTABLE_ALGORITHM.test(name) ? name : null
}

/**
 * Derives the key algorithm (e.g. `ssh-ed25519`, `rsa-sha2-256`) from a host key
 * blob. ssh2's `hostVerifier` hands us the raw SSH wire-format blob, which starts
 * with a length-prefixed algorithm name; fall back to `ssh2.utils.parseKey` for
 * other representations and finally to `'unknown'`.
 */
export function deriveKeyAlgorithm(rawKey: Buffer): string {
  const fromWire = algorithmFromWireFormat(rawKey)
  if (fromWire) return fromWire
  try {
    const parsed = ssh2.utils.parseKey(rawKey)
    if (parsed && !(parsed instanceof Error) && typeof parsed.type === 'string') {
      return parsed.type
    }
  } catch {
    // Not a parseable key format; fall through.
  }
  return 'unknown'
}

/**
 * Builds the `HostKeyInfo` record used for trust decisions, persistence and the
 * error payloads emitted for unknown/mismatched keys.
 */
export function hostKeyInfo(rawKey: Buffer, host: string, port: number): HostKeyInfo {
  return {
    host,
    port,
    algorithm: deriveKeyAlgorithm(rawKey),
    fingerprint: fingerprintKey(rawKey)
  }
}

/**
 * Describes a raw host key without attaching it to a host, useful for logging and
 * tests. The returned object intentionally contains no secret material.
 */
export function describeHostKey(rawKey: Buffer): { algorithm: string; fingerprint: string } {
  return { algorithm: deriveKeyAlgorithm(rawKey), fingerprint: fingerprintKey(rawKey) }
}

/** Formats a fingerprint for display; centralises the prefix for UI/test matching. */
export function formatFingerprint(rawKey: Buffer): string {
  return fingerprintKey(rawKey)
}
