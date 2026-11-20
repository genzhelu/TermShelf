import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { X11Service } from '../../src/main/x11/service'
import type { WslContext, WslService } from '../../src/main/wsl/service'
import type { WslInfo } from '../../src/shared/types'

const dirs: string[] = []
let server: net.Server | null = null
let service: X11Service | null = null

afterEach(async () => {
  await service?.dispose()
  service = null
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = null
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termshelf-bridge-test-'))
  dirs.push(dir)
  return dir
}

function canConnect(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    socket.setTimeout(300)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
    socket.once('timeout', () => {
      socket.destroy()
      resolve(false)
    })
  })
}

describe.skipIf(process.platform === 'win32')('authenticated WSLg bridge', () => {
  it('requires the per-session preface and closes the listener after release', async () => {
    const root = tempDir()
    const socketPath = path.join(root, 'x11.sock')
    const wrapper = path.join(root, 'fake-wsl')
    fs.writeFileSync(wrapper, '#!/bin/sh\nexec python3 -u -c "$7" "$8" "$9"\n', { mode: 0o755 })
    server = net.createServer((socket) => {
      socket.once('data', () => socket.end(Buffer.from([1, 0, 11, 0, 0, 0, 0, 0])))
      socket.on('error', () => undefined)
    })
    await new Promise<void>((resolve) => server!.listen(socketPath, () => resolve()))

    const context: WslContext = {
      distro: 'Ubuntu',
      homePath: '/home/test',
      shellPath: '/bin/bash',
      uncRoot: null,
      uncRootCandidates: []
    }
    const wsl = {
      executablePath: wrapper,
      async info(): Promise<WslInfo> {
        return { available: true, distros: ['Ubuntu'], defaultDistro: 'Ubuntu' }
      },
      async resolveContext(): Promise<WslContext> {
        return context
      },
      async runInDistro(_distro: string, args: string[]) {
        if ((args[2] ?? '').includes('DISPLAY=')) {
          return {
            code: 0,
            stdout: `DISPLAY=:0\nSOCKET=${socketPath}\nHELPER=python3\n`,
            stderr: ''
          }
        }
        return { code: 0, stdout: '', stderr: '' }
      }
    } as unknown as WslService

    service = new X11Service({ platform: 'win32', wsl, infoTtlMs: 0 })
    const session = await service.prepareSession()
    expect(session.backend).toBe('wslg')
    expect(session.target.kind).toBe('tcp')
    if (session.target.kind !== 'tcp') return
    expect(session.target.preface?.length).toBeGreaterThan(0)
    expect(session.localCookie).toBeNull()
    expect(await canConnect(session.target.port)).toBe(true)

    // A process without the random preface cannot reach the X server.
    const direct = await new Promise<boolean>((resolve) => {
      const socket = net.connect({
        host: '127.0.0.1',
        port: session.target.kind === 'tcp' ? session.target.port : 0
      })
      socket.once('connect', () => {
        socket.write(Buffer.from('not-the-token'))
        socket.once('data', () => {
          socket.destroy()
          resolve(true)
        })
        socket.once('close', () => resolve(false))
      })
      socket.once('error', () => resolve(false))
      setTimeout(() => {
        socket.destroy()
        resolve(false)
      }, 400)
    })
    expect(direct).toBe(false)

    await session.cleanup()
    await new Promise((resolve) => setTimeout(resolve, 2_500))
    expect(await canConnect(session.target.port)).toBe(false)
  }, 20_000)
})
