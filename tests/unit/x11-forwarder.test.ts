import net from 'node:net'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_X11_CHANNELS, X11Forwarder } from '../../src/main/x11/forwarder'
import { buildX11SetupPacket, type X11Target } from '../../src/main/x11/service'

const servers: net.Server[] = []

function padded(length: number): number {
  return length + ((4 - (length % 4)) % 4)
}

function setupLength(packet: Buffer): number {
  const nameLength = packet.readUInt16LE(6)
  const dataLength = packet.readUInt16LE(8)
  return 12 + padded(nameLength) + padded(dataLength)
}

function authData(packet: Buffer): Buffer {
  const nameLength = packet.readUInt16LE(6)
  const dataLength = packet.readUInt16LE(8)
  const offset = 12 + padded(nameLength)
  return packet.subarray(offset, offset + dataLength)
}

async function startXServer(
  onSetup: (packet: Buffer, socket: net.Socket) => void
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer((socket) => {
      let buffer = Buffer.alloc(0)
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk])
        if (buffer.length < 12) return
        const length = setupLength(buffer)
        if (buffer.length < length) return
        onSetup(buffer.subarray(0, length), socket)
      })
      socket.on('error', () => undefined)
    })
    servers.push(server)
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address === 'object' && address) resolve(address.port)
      else reject(new Error('no address'))
    })
  })
}

async function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Timed out waiting for condition')
}

function waitForMarker(stream: PassThrough, marker: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let seen = ''
    const timer = setTimeout(() => reject(new Error('Timed out waiting for relay response')), 2_000)
    stream.on('data', (chunk: Buffer) => {
      seen += chunk.toString('utf8')
      if (seen.includes(marker)) {
        clearTimeout(timer)
        resolve()
      }
    })
  })
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

describe('X11Forwarder', () => {
  it('authenticates the SSH setup and relays the local server response', async () => {
    const expectedCookie = Buffer.alloc(16, 1)
    const localCookie = Buffer.alloc(16, 2)
    let receivedCookie: Buffer | null = null
    let setupCalls = 0
    const port = await startXServer((packet, socket) => {
      setupCalls += 1
      receivedCookie = authData(packet)
      socket.write(Buffer.from('server-reply'))
    })
    const target: X11Target = { kind: 'tcp', host: '127.0.0.1', port }
    const warnings: string[] = []
    const forwarder = new X11Forwarder({
      target,
      expectedCookie,
      localCookie,
      warn: (message) => warnings.push(message)
    })
    const channel = new PassThrough()
    expect(forwarder.attach(channel)).toBe(true)
    const response = waitForMarker(channel, 'server-reply')
    channel.write(buildX11SetupPacket(expectedCookie))
    await response
    expect((receivedCookie as Buffer | null)?.equals(localCookie)).toBe(true)
    expect(setupCalls).toBe(1)
    expect(forwarder.activeCount).toBe(1)
    forwarder.close()
    expect(forwarder.activeCount).toBe(0)
    expect(warnings).toEqual([])
  })

  it('forwards the original setup when the local server has no auth', async () => {
    const expectedCookie = Buffer.alloc(16, 6)
    let receivedCookie: Buffer | null = null
    const port = await startXServer((packet, socket) => {
      receivedCookie = authData(packet)
      socket.write(Buffer.from('no-auth-reply'))
    })
    const warnings: string[] = []
    const forwarder = new X11Forwarder({
      target: { kind: 'tcp', host: '127.0.0.1', port },
      expectedCookie,
      localCookie: null,
      warn: (message) => warnings.push(message)
    })
    const channel = new PassThrough()
    expect(forwarder.attach(channel)).toBe(true)
    const response = waitForMarker(channel, 'no-auth-reply')
    channel.write(buildX11SetupPacket(expectedCookie))
    await response
    expect(warnings).toEqual([])
    expect((receivedCookie as Buffer | null)?.equals(expectedCookie)).toBe(true)
    forwarder.close()
  })

  it('rejects a channel using the wrong SSH cookie before relaying it', async () => {
    const expectedCookie = Buffer.alloc(16, 4)
    const wrongCookie = Buffer.alloc(16, 5)
    let setupSeen = false
    const port = await startXServer((_packet) => {
      setupSeen = true
    })
    const warnings: string[] = []
    const forwarder = new X11Forwarder({
      target: { kind: 'tcp', host: '127.0.0.1', port },
      expectedCookie,
      localCookie: null,
      warn: (message) => warnings.push(message)
    })
    const channel = new PassThrough()
    forwarder.attach(channel)
    channel.write(buildX11SetupPacket(wrongCookie))
    await waitFor(() => warnings.length === 1)
    expect(setupSeen).toBe(false)
    expect(warnings).toHaveLength(1)
    forwarder.close()
  })

  it('rejects channels above the concurrency limit and warns once', () => {
    const warnings: string[] = []
    const forwarder = new X11Forwarder({
      target: { kind: 'tcp', host: '127.0.0.1', port: 1 },
      expectedCookie: Buffer.alloc(16),
      localCookie: null,
      warn: (message) => warnings.push(message)
    })
    for (let index = 0; index < MAX_X11_CHANNELS; index += 1) {
      expect(forwarder.attach(new PassThrough())).toBe(true)
    }
    expect(forwarder.canAccept()).toBe(false)
    expect(forwarder.attach(new PassThrough())).toBe(false)
    expect(warnings).toHaveLength(1)
    forwarder.close()
  })

  it('warns once and cleans up when the local X server is unreachable', async () => {
    const warnings: string[] = []
    const forwarder = new X11Forwarder({
      target: { kind: 'tcp', host: '127.0.0.1', port: 1 },
      expectedCookie: Buffer.alloc(16),
      localCookie: null,
      warn: (message) => warnings.push(message)
    })
    const channel = new PassThrough()
    expect(forwarder.attach(channel)).toBe(true)
    await waitFor(() => warnings.length === 1)
    expect(warnings).toHaveLength(1)
    expect(forwarder.activeCount).toBe(0)
    forwarder.close()
  })
})
