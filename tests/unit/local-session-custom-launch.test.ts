import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalSession } from '../../src/main/sessions/local'
import { WslBackend } from '../../src/main/files/wsl-backend'
import type { AppEvent } from '../../src/shared/types'

const directories: string[] = []
const POSIX_ONLY = process.platform === 'win32'

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termshelf-custom-launch-'))
  directories.push(dir)
  return dir
}

function eventsSink(events: AppEvent[]): (event: AppEvent) => void {
  return (event) => events.push(event)
}

async function waitUntil(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

afterEach(() => {
  for (const dir of directories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe.skipIf(POSIX_ONLY)('LocalSession custom launch (WSL profile plumbing)', () => {
  it('advertises the WSL environment/home and routes terminal data through the custom shell', async () => {
    const root = tempDir()
    fs.mkdirSync(path.join(root, 'home', 'test'), { recursive: true })
    const events: AppEvent[] = []
    let cleaned = 0
    const session = new LocalSession({
      id: 'custom-ok',
      request: { cols: 80, rows: 20 },
      runtimeRoot: tempDir(),
      emit: eventsSink(events),
      environment: 'wsl',
      backend: new WslBackend(root, '/home/test'),
      homePath: '/home/test',
      label: 'WSL · Test',
      startupGraceMs: 100,
      launch: async () => ({
        file: '/bin/bash',
        args: ['-c', 'printf CUSTOM_LAUNCH_OK; sleep 0.25'],
        env: { TERM: 'xterm-256color' },
        label: 'WSL · Test · bash',
        cleanup: async () => {
          cleaned += 1
        }
      })
    })

    const descriptor = await session.start()
    expect(descriptor.environment).toBe('wsl')
    expect(descriptor.homePath).toBe('/home/test')
    expect(descriptor.pathStyle).toBe('posix')
    expect(descriptor.title).toContain('WSL')

    await waitUntil(() =>
      events.some(
        (event) => event.type === 'session:data' && event.data.includes('CUSTOM_LAUNCH_OK')
      )
    )
    await waitUntil(() =>
      events.some((event) => event.type === 'session:state' && event.status === 'ended')
    )
    await waitUntil(() => cleaned === 1)
    await session.dispose()
    expect(cleaned).toBe(1)
  })

  it('rejects startup and cleans up when the custom shell exits immediately', async () => {
    const root = tempDir()
    fs.mkdirSync(path.join(root, 'home', 'test'), { recursive: true })
    const events: AppEvent[] = []
    let cleaned = 0
    const session = new LocalSession({
      id: 'custom-fail',
      request: { cols: 80, rows: 20 },
      runtimeRoot: tempDir(),
      emit: eventsSink(events),
      environment: 'wsl',
      backend: new WslBackend(root, '/home/test'),
      homePath: '/home/test',
      startupGraceMs: 100,
      launch: async () => ({
        file: path.join(root, 'missing-wsl-executable'),
        args: [],
        label: 'WSL · Broken',
        cleanup: async () => {
          cleaned += 1
        }
      })
    })

    await expect(session.start()).rejects.toMatchObject({ code: 'SHELL_SPAWN_FAILED' })
    expect(cleaned).toBe(1)
    expect(events.some((event) => event.type === 'session:state' && event.status === 'ended')).toBe(
      false
    )
    await session.dispose()
    expect(cleaned).toBe(1)
  })

  it('detects a delayed exit inside the startup grace period', async () => {
    const root = tempDir()
    const events: AppEvent[] = []
    let cleaned = 0
    const session = new LocalSession({
      id: 'custom-delayed-exit',
      request: { cols: 80, rows: 20 },
      runtimeRoot: tempDir(),
      emit: eventsSink(events),
      environment: 'wsl',
      backend: new WslBackend(root, '/home/test'),
      homePath: '/home/test',
      startupGraceMs: 1_000,
      launch: async () => ({
        file: '/bin/bash',
        args: ['-c', 'sleep 0.3; exit 3'],
        label: 'WSL · Delayed failure',
        cleanup: async () => {
          cleaned += 1
        }
      })
    })
    await expect(session.start()).rejects.toMatchObject({ code: 'SHELL_SPAWN_FAILED' })
    expect(cleaned).toBe(1)
    await session.dispose()
  })

  it('cancels an in-flight launch without spawning a PTY after dispose', async () => {
    const root = tempDir()
    fs.mkdirSync(path.join(root, 'home', 'test'), { recursive: true })
    const events: AppEvent[] = []
    let cleaned = 0
    let releaseLaunch: (() => void) | null = null
    const session = new LocalSession({
      id: 'custom-cancel',
      request: { cols: 80, rows: 20 },
      runtimeRoot: tempDir(),
      emit: eventsSink(events),
      environment: 'wsl',
      backend: new WslBackend(root, '/home/test'),
      homePath: '/home/test',
      startupGraceMs: 100,
      launch: () =>
        new Promise((resolve) => {
          releaseLaunch = () => {
            resolve({
              file: '/bin/bash',
              args: ['-c', 'sleep 2'],
              label: 'WSL · Cancelled',
              cleanup: async () => {
                cleaned += 1
              }
            })
          }
        })
    })

    const starting = session.start()
    await waitUntil(() => releaseLaunch !== null)
    await session.dispose()
    releaseLaunch!()
    await expect(starting).rejects.toMatchObject({ code: 'SHELL_SPAWN_FAILED' })
    expect(cleaned).toBe(1)
    expect(events.some((event) => event.type === 'session:data')).toBe(false)
  })
})
