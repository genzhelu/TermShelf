import net from 'node:net'
import type { Duplex } from 'node:stream'
import type { X11Target } from './service'

/** Upper bound for concurrent X11 clients (each window generally uses one). */
export const MAX_X11_CHANNELS = 64
const CONNECT_TIMEOUT_MS = 5_000
const MAX_SETUP_BYTES = 8_192

export interface X11ForwarderOptions {
  target: X11Target
  /** Cookie requested from ssh2; the remote X client must present it. */
  expectedCookie: Buffer
  /** Cookie accepted by the local server, substituted before relaying. */
  localCookie: Buffer | null
  warn?: (message: string) => void
}

interface ParsedSetup {
  total: number
  outbound: Buffer
  remainder: Buffer
}

function paddedLength(length: number): number {
  return length + ((4 - (length % 4)) % 4)
}

/**
 * Validates and parses an X11 connection setup, replacing the per-SSH cookie
 * with the local server's cookie when authentication is required. The remote
 * host never learns the local credential.
 */
function parseSetup(
  data: Buffer,
  expectedCookie: Buffer,
  localCookie: Buffer | null
): ParsedSetup | 'incomplete' | 'invalid' {
  if (data.length < 12) return 'incomplete'
  if (data[0] !== 0x6c && data[0] !== 0x42) return 'invalid'
  const little = data[0] === 0x6c
  const readUInt16 = (offset: number): number =>
    little ? data.readUInt16LE(offset) : data.readUInt16BE(offset)
  if (readUInt16(2) !== 11) return 'invalid'
  const nameLength = readUInt16(6)
  const dataLength = readUInt16(8)
  if (nameLength > 1_024 || dataLength > 1_024) return 'invalid'
  const total = 12 + paddedLength(nameLength) + paddedLength(dataLength)
  if (total > MAX_SETUP_BYTES) return 'invalid'
  if (data.length < total) return 'incomplete'

  const authName = data.subarray(12, 12 + nameLength).toString('ascii')
  const authDataOffset = 12 + paddedLength(nameLength)
  const authData = data.subarray(authDataOffset, authDataOffset + dataLength)
  if (authName !== 'MIT-MAGIC-COOKIE-1') return 'invalid'
  if (authData.length !== expectedCookie.length || !authData.equals(expectedCookie)) {
    return 'invalid'
  }

  let outbound: Buffer
  if (localCookie) {
    const header = Buffer.from(data.subarray(0, 12))
    if (little) header.writeUInt16LE(localCookie.length, 8)
    else header.writeUInt16BE(localCookie.length, 8)
    const name = data.subarray(12, 12 + nameLength)
    const namePad = Buffer.alloc(paddedLength(nameLength) - nameLength)
    const cookiePad = Buffer.alloc(paddedLength(localCookie.length) - localCookie.length)
    outbound = Buffer.concat([header, name, namePad, localCookie, cookiePad])
  } else {
    outbound = data.subarray(0, total)
  }
  return { total, outbound, remainder: data.subarray(total) }
}

/**
 * Relays incoming SSH X11 channels to the local X server. The first stream
 * bytes are the X11 setup; it is authenticated against the per-session cookie
 * and, when needed, rewritten with the local server credential before relay.
 */
export class X11Forwarder {
  private readonly sockets = new Set<net.Socket>()
  private readonly channels = new Set<Duplex>()
  private readonly target: X11Target
  private readonly expectedCookie: Buffer
  private readonly localCookie: Buffer | null
  private readonly warn: (message: string) => void
  private closed = false
  private warned = false

  constructor(options: X11ForwarderOptions) {
    this.target = options.target
    this.expectedCookie = options.expectedCookie
    this.localCookie = options.localCookie
    this.warn = options.warn ?? (() => undefined)
  }

  get activeCount(): number {
    return this.channels.size
  }

  canAccept(): boolean {
    return !this.closed && this.channels.size < MAX_X11_CHANNELS
  }

  attach(channel: Duplex): boolean {
    if (!this.canAccept()) {
      try {
        channel.destroy()
      } catch {
        // already closed
      }
      this.warnOnce(
        this.closed
          ? 'The X11 forwarder is closed'
          : `Too many remote GUI connections (limit ${MAX_X11_CHANNELS})`
      )
      return false
    }

    const socket =
      this.target.kind === 'unix'
        ? net.connect({ path: this.target.path })
        : net.connect({ host: this.target.host, port: this.target.port })
    this.sockets.add(socket)
    this.channels.add(channel)

    let setupDone = false
    let socketReady = false
    let finished = false
    let pending = Buffer.alloc(0)
    let setup: ParsedSetup | null = null

    const finish = (): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      this.sockets.delete(socket)
      this.channels.delete(channel)
      try {
        socket.destroy()
      } catch {
        // ignore
      }
      try {
        channel.destroy()
      } catch {
        // ignore
      }
    }
    const fail = (message: string): void => {
      this.warnOnce(message)
      finish()
    }
    const flush = (): void => {
      if (finished || !setupDone || !socketReady || !setup) return
      try {
        if (this.target.kind === 'tcp' && this.target.preface) {
          socket.write(this.target.preface)
        }
        socket.write(setup.outbound)
        if (setup.remainder.length > 0) socket.write(setup.remainder)
      } catch {
        fail('Could not write to the local X11 server')
        return
      }
      channel.pause()
      channel.removeListener('data', onChannelData)
      channel.pipe(socket)
      socket.pipe(channel)
      channel.resume()
    }
    const onChannelData = (chunk: Buffer): void => {
      if (finished || setupDone) return
      pending = Buffer.concat([pending, chunk])
      if (pending.length > MAX_SETUP_BYTES) {
        fail('Invalid X11 connection setup from the remote GUI')
        return
      }
      const parsed = parseSetup(pending, this.expectedCookie, this.localCookie)
      if (parsed === 'incomplete') return
      if (parsed === 'invalid') {
        fail('Remote GUI X11 authentication failed')
        return
      }
      setup = parsed
      setupDone = true
      pending = Buffer.alloc(0)
      flush()
    }

    channel.pause()
    channel.on('data', onChannelData)
    channel.once('error', finish)
    channel.once('close', finish)
    channel.resume()

    const timer = setTimeout(() => {
      fail('Timed out connecting a remote GUI window to the local X11 server')
    }, CONNECT_TIMEOUT_MS)
    timer.unref?.()

    socket.once('connect', () => {
      if (finished) return
      socketReady = true
      flush()
    })
    socket.once('error', () => {
      fail('Could not connect a remote GUI window to the local X11 server')
    })
    socket.once('close', finish)
    return true
  }

  close(): void {
    this.closed = true
    for (const socket of this.sockets) {
      try {
        socket.destroy()
      } catch {
        // ignore
      }
    }
    for (const channel of this.channels) {
      try {
        channel.destroy()
      } catch {
        // ignore
      }
    }
    this.sockets.clear()
    this.channels.clear()
  }

  private warnOnce(message: string): void {
    if (this.warned) return
    this.warned = true
    this.warn(message)
  }
}
