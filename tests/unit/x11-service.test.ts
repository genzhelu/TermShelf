import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  X11Service,
  buildX11SetupPacket,
  parseDisplayNumber,
  parseWslgProbe,
  parseXauthEntries,
  probeX11Target
} from '../../src/main/x11/service'
import type { WslContext, WslService } from '../../src/main/wsl/service'
import type { WslInfo } from '../../src/shared/types'

const servers: net.Server[] = []

function startXServer(handler: (socket: net.Socket, index: number) => void): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let index = 0
    const server = net.createServer((socket) => {
      index += 1
      handler(socket, index)
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

async function closeServer(server: net.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

function wslFixture(overrides: Partial<WslInfo> = {}): WslService {
  const context: WslContext = {
    distro: 'Ubuntu',
    homePath: '/home/test',
    shellPath: '/bin/bash',
    uncRoot: null,
    uncRootCandidates: []
  }
  return {
    async info() {
      return {
        available: true,
        distros: ['Ubuntu'],
        defaultDistro: 'Ubuntu',
        ...overrides
      }
    },
    async resolveContext() {
      return context
    },
    async runInDistro(_distro: string, args: string[]) {
      if (args[0] === 'sh' && args[1] === '-c' && args[2]?.includes('DISPLAY=')) {
        return {
          code: 0,
          stdout: 'DISPLAY=:0\nSOCKET=/mnt/wslg/.X11-unix/X0\nHELPER=python3\n',
          stderr: ''
        }
      }
      return { code: 0, stdout: '', stderr: '' }
    },
    executablePath: 'C:\\fake\\wsl.exe'
  } as unknown as WslService
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await closeServer(server)
  }
  delete process.env.DISPLAY
})

describe('X11 protocol helpers', () => {
  it('parses local display names', () => {
    expect(parseDisplayNumber(':0')).toBe(0)
    expect(parseDisplayNumber('localhost:10.0')).toBe(10)
    expect(parseDisplayNumber('host.example:3')).toBe(3)
    expect(parseDisplayNumber('not-a-display')).toBeNull()
  })

  it('parses restorable xauth entries', () => {
    expect(
      parseXauthEntries(
        'host/unix:0  MIT-MAGIC-COOKIE-1  0123456789abcdef\nbad line\nhostname:10 MIT-MAGIC-COOKIE-1 feedface\n'
      )
    ).toEqual([
      { display: 'host/unix:0', protocol: 'MIT-MAGIC-COOKIE-1', hex: '0123456789abcdef' },
      { display: 'hostname:10', protocol: 'MIT-MAGIC-COOKIE-1', hex: 'feedface' }
    ])
  })

  it('parses the WSLg probe and prefers the /mnt/wslg mount', () => {
    expect(
      parseWslgProbe(
        'DISPLAY=:0\nSOCKET=/tmp/.X11-unix/X0\nSOCKET=/mnt/wslg/.X11-unix/X0\nHELPER=python3\n'
      )
    ).toEqual({
      display: ':0',
      socket: '/mnt/wslg/.X11-unix/X0',
      python: true
    })
  })

  it('selects the WSLg socket matching the reported display number', () => {
    expect(
      parseWslgProbe(
        'DISPLAY=:1\nSOCKET=/mnt/wslg/.X11-unix/X0\nSOCKET=/mnt/wslg/.X11-unix/X1\nHELPER=python3\n'
      ).socket
    ).toBe('/mnt/wslg/.X11-unix/X1')
  })

  it('builds a little-endian X11 setup packet with padded auth fields', () => {
    const cookie = Buffer.alloc(16, 0xab)
    const packet = buildX11SetupPacket(cookie)
    expect(packet[0]).toBe('l'.charCodeAt(0))
    expect(packet.readUInt16LE(2)).toBe(11)
    expect(packet.readUInt16LE(6)).toBe('MIT-MAGIC-COOKIE-1'.length)
    expect(packet.readUInt16LE(8)).toBe(16)
    expect(packet.length).toBe(12 + 18 + 2 + 16)
  })
})

describe('probeX11Target', () => {
  it('accepts a server that replies with setup success', async () => {
    const port = await startXServer((socket) => {
      socket.once('data', () => socket.end(Buffer.from([1, 0, 11, 0])))
    })
    expect(await probeX11Target({ kind: 'tcp', host: '127.0.0.1', port }, Buffer.alloc(16))).toBe(
      true
    )
  })

  it('sends the bridge preface before the X11 setup', async () => {
    const preface = Buffer.from('bridge-secret')
    let received = Buffer.alloc(0)
    const server = net.createServer((socket) => {
      socket.on('data', (chunk) => {
        received = Buffer.concat([received, chunk])
        if (received.length >= preface.length + 12) {
          socket.end(Buffer.from([1, 0, 11, 0]))
        }
      })
      socket.on('error', () => undefined)
    })
    servers.push(server)
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        resolve(typeof address === 'object' && address ? address.port : 0)
      })
    })
    expect(
      await probeX11Target({ kind: 'tcp', host: '127.0.0.1', port, preface }, Buffer.alloc(16))
    ).toBe(true)
    expect(received.subarray(0, preface.length).equals(preface)).toBe(true)
  })
  it('rejects an authentication failure or closed connection', async () => {
    const port = await startXServer((socket) => {
      socket.once('data', () => socket.end(Buffer.from([0])))
    })
    expect(await probeX11Target({ kind: 'tcp', host: '127.0.0.1', port }, Buffer.alloc(16))).toBe(
      false
    )
  })
})

describe('X11Service detection', () => {
  it('reports WSLg on Windows when a bridge helper and socket exist', async () => {
    const service = new X11Service({ platform: 'win32', wsl: wslFixture() })
    await expect(service.info(true)).resolves.toMatchObject({
      available: true,
      backend: 'wslg'
    })
  })

  it('reports WSLg unavailable when no bridge helper exists', async () => {
    const wsl = wslFixture()
    ;(wsl.runInDistro as unknown as (d: string, a: string[]) => Promise<unknown>) = async () => ({
      code: 0,
      stdout: 'DISPLAY=:0\nSOCKET=/mnt/wslg/.X11-unix/X0\n',
      stderr: ''
    })
    const service = new X11Service({ platform: 'win32', wsl })
    const info = await service.info(true)
    expect(info.available).toBe(false)
    expect(info.detail).toContain('python3')
  })

  it('reports a local Linux display and no display when DISPLAY is missing', async () => {
    process.env.DISPLAY = ':99'
    const available = new X11Service({
      platform: 'linux',
      wsl: wslFixture(),
      pathExists: (target) => target === '/tmp/.X11-unix/X99'
    })
    await expect(available.info(true)).resolves.toMatchObject({
      available: true,
      backend: 'x11'
    })

    delete process.env.DISPLAY
    const unavailable = new X11Service({ platform: 'linux', wsl: wslFixture() })
    await expect(unavailable.info(true)).resolves.toMatchObject({
      available: false,
      backend: 'none'
    })
  })
})

describe('X11Service prepareSession', () => {
  it('substitutes the local xauth cookie instead of modifying the authority file', async () => {
    const commands: string[][] = []
    let connections = 0
    const server = net.createServer((socket) => {
      connections += 1
      socket.once('data', () => {
        socket.end(Buffer.from([connections >= 2 ? 1 : 0]))
      })
    })
    servers.push(server)
    const tcpPort = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        resolve(typeof address === 'object' && address ? address.port : 0)
      })
    })
    const display = `:${tcpPort - 6000}`
    process.env.DISPLAY = display

    const service = new X11Service({
      platform: 'linux',
      wsl: wslFixture(),
      pathExists: () => false,
      runCommand: async (file, args) => {
        commands.push([file, ...args])
        if (args[0] === 'list') {
          return {
            code: 0,
            stdout: `host/unix:${tcpPort - 6000} MIT-MAGIC-COOKIE-1 00112233445566778899aabbccddeeff\n`,
            stderr: ''
          }
        }
        return { code: 0, stdout: '', stderr: '' }
      },
      infoTtlMs: 0
    })
    const session = await service.prepareSession()
    expect(session.target).toEqual({ kind: 'tcp', host: '127.0.0.1', port: tcpPort })
    expect(session.localCookie?.toString('hex')).toBe('00112233445566778899aabbccddeeff')
    expect(commands.map((args) => args[1])).toEqual(['list'])
    await session.cleanup()
  })
})
