import net from 'node:net'
import type { Duplex } from 'node:stream'
import type { X11Target } from './service'

/** Upper bound for concurrent X11 clients (each window generally uses one). */
export const MAX_X11_CHANNELS = 64
const CONNECT_TIMEOUT_MS = 5_000

/**
 * Relays incoming SSH X11 channels to the local X server. Each SSH channel is
 * a raw X11 client connection, so the two streams can simply be piped together.
 */
export class X11Forwarder {
  private readonly sockets = new Set<net.Socket>()
  private readonly channels = new Set<Duplex>()
  private closed = false
  private warned = false

  constructor(
    private readonly target: X11Target,
    private readonly warn: (message: string) => void = () => undefined
  ) {}

  get activeCount(): number {
    return this.channels.size
  }

  canAccept(): boolean {
    return !this.closed && this.channels.size < MAX_X11_CHANNELS
  }

  /** Accepts an X11 channel and connects it to the local display. */
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

    let connected = false
    let finished = false
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
    const timer = setTimeout(() => {
      this.warnOnce('Timed out connecting a remote GUI window to the local X11 server')
      finish()
    }, CONNECT_TIMEOUT_MS)
    timer.unref?.()

    socket.once('connect', () => {
      if (finished) return
      connected = true
      clearTimeout(timer)
      try {
        channel.pipe(socket)
        socket.pipe(channel)
      } catch {
        finish()
      }
    })
    socket.once('error', () => {
      if (!connected) {
        this.warnOnce('Could not connect a remote GUI window to the local X11 server')
      }
      finish()
    })
    socket.once('close', finish)
    channel.once('error', finish)
    channel.once('close', finish)
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
