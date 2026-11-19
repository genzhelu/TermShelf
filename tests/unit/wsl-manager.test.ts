import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionManager } from '../../src/main/sessions/manager'
import type { ConfigStore } from '../../src/main/store/types'
import type { AppEvent, Settings, WslInfo } from '../../src/shared/types'
import type { WslContext, WslService } from '../../src/main/wsl/service'

const directories: string[] = []

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termshelf-manager-wsl-'))
  directories.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of directories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe.skipIf(process.platform === 'win32')('SessionManager WSL fallback', () => {
  it('cancels a pending WSL start during shutdown without native fallback', async () => {
    const root = tempDir()
    fs.mkdirSync(path.join(root, 'tmp'), { recursive: true })
    const fakeWsl = path.join(tempDir(), 'fake-wsl')
    fs.writeFileSync(fakeWsl, '#!/bin/sh\nsleep 5\n', { mode: 0o755 })

    const context: WslContext = {
      distro: 'Ubuntu',
      homePath: '/home/test',
      shellPath: '/bin/bash',
      uncRoot: root,
      uncRootCandidates: [root]
    }
    const fakeWslService = {
      executablePath: fakeWsl,
      async info(): Promise<WslInfo> {
        return { available: true, distros: ['Ubuntu'], defaultDistro: 'Ubuntu' }
      },
      async resolveContext(): Promise<WslContext> {
        return context
      },
      async testReadable(): Promise<boolean> {
        return true
      }
    } as unknown as WslService
    const settings = {
      localTerminal: 'wsl',
      wslDistro: null,
      shellPath: null
    } as Settings
    const store = { getSettings: () => settings } as unknown as ConfigStore
    const manager = new SessionManager(store, () => undefined, tempDir(), fakeWslService, 'win32')

    const starting = manager.createLocal({ cols: 80, rows: 20, terminal: 'wsl' })
    await new Promise((resolve) => setTimeout(resolve, 100))
    await manager.disposeAll()
    await expect(starting).rejects.toBeInstanceOf(Error)
  }, 10_000)

  it('falls back to a native session when wsl.exe starts and immediately exits', async () => {
    const root = tempDir()
    fs.mkdirSync(path.join(root, 'tmp'), { recursive: true })
    const fakeWsl = path.join(tempDir(), 'fake-wsl')
    fs.writeFileSync(fakeWsl, '#!/bin/sh\nexit 1\n', { mode: 0o755 })

    const context: WslContext = {
      distro: 'Ubuntu',
      homePath: '/home/test',
      shellPath: '/bin/bash',
      uncRoot: root,
      uncRootCandidates: [root]
    }
    const fakeWslService = {
      executablePath: fakeWsl,
      async info(): Promise<WslInfo> {
        return { available: true, distros: ['Ubuntu'], defaultDistro: 'Ubuntu' }
      },
      async resolveContext(): Promise<WslContext> {
        return context
      },
      async testReadable(): Promise<boolean> {
        return true
      }
    } as unknown as WslService

    const settings = {
      localTerminal: 'wsl',
      wslDistro: null,
      shellPath: null
    } as Settings
    const store = {
      getSettings: () => settings
    } as unknown as ConfigStore
    const events: AppEvent[] = []
    const manager = new SessionManager(
      store,
      (event) => events.push(event),
      tempDir(),
      fakeWslService,
      'win32'
    )

    try {
      const descriptor = await manager.createLocal({
        cols: 80,
        rows: 20,
        terminal: 'wsl'
      })
      expect(descriptor.environment).toBe('native')
      expect(events.some((event) => event.type === 'toast' && event.level === 'warn')).toBe(true)
    } finally {
      await manager.disposeAll()
    }
  }, 10_000)
})
