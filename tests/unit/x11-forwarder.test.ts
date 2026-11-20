import net from 'node:net'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_X11_CHANNELS, X11Forwarder } from '../../src/main/x11/forwarder'
import type { X11Target } from '../../src/main/x11/service'

const servers: net.Server[] = []

async function startEchoServer(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.pipe(socket)
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

function waitForData(stream: NodeJS.ReadableStream, expected: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for X11 relay data')), 2_000)
    stream.on('data', (chunk: Buffer | string) => {
      clearTimeout(timer)
      expect(String(chunk)).toBe(expected)
      resolve()
    })
  })
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

describe('X11Forwarder', () => {
  it('relays bytes between an SSH channel and the local X11 server', async () => {
    const port = await startEchoServer()
    const target: X11Target = { kind: 'tcp', host: '127.0.0.1', port }
    const warnings: string[] = []
    const forwarder = new X11Forwarder(target, (message) => warnings.push(message))
    const channel = new PassThrough()
    expect(forwarder.attach(channel)).toBe(true)
    const reply = waitForData(channel, 'x11-payload')
    channel.write('x11-payload')
    await reply
    expect(forwarder.activeCount).toBe(1)
    forwarder.close()
    expect(forwarder.activeCount).toBe(0)
    expect(warnings).toEqual([])
  })

  it('rejects channels above the concurrency limit and warns once', () => {
    const warnings: string[] = []
    const forwarder = new X11Forwarder({ kind: 'tcp', host: '127.0.0.1', port: 1 }, (message) =>
      warnings.push(message)
    )
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
    const forwarder = new X11Forwarder({ kind: 'tcp', host: '127.0.0.1', port: 1 }, (message) =>
      warnings.push(message)
    )
    const channel = new PassThrough()
    expect(forwarder.attach(channel)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(warnings).toHaveLength(1)
    expect(forwarder.activeCount).toBe(0)
    forwarder.close()
  })
})
