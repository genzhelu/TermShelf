import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startDevSshd } from '../../tools/dev-sshd/server'
import type { DevSshdHandle } from '../../tools/dev-sshd/server'
import { SshSession } from '../../src/main/sessions/ssh'
import type { ConfigStore } from '../../src/main/store/types'
import type { AppEvent, SshConnectRequest } from '../../src/shared/types'
import type { X11Service, X11Session } from '../../src/main/x11/service'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup().catch(() => undefined)
  }
})

describe('SSH X11 fallback', () => {
  it('keeps the terminal connected when the remote host rejects X11', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'termshelf-x11-fallback-'))
    const sshd: DevSshdHandle = await startDevSshd({ root, port: 0 })
    cleanups.push(async () => {
      await sshd.close()
      await rm(root, { recursive: true, force: true })
    })

    let cleanupCalls = 0
    let targetClosed = false
    const fakeX11 = {
      async info() {
        return { available: true, backend: 'x11' as const, label: 'test X11' }
      },
      async prepareSession(): Promise<X11Session> {
        return {
          backend: 'x11',
          cookie: Buffer.alloc(16, 1),
          target: { kind: 'tcp', host: '127.0.0.1', port: 1 },
          cleanup: async () => {
            cleanupCalls += 1
          }
        }
      },
      async dispose() {
        targetClosed = true
      }
    } as unknown as X11Service

    const events: AppEvent[] = []
    const knownHost = {
      host: sshd.host,
      port: sshd.port,
      algorithm: 'ssh-ed25519',
      fingerprint: sshd.fingerprint,
      addedAt: new Date().toISOString()
    }
    const store = {
      async saveProfile(profile: unknown) {
        return profile
      },
      getKnownHost(host: string, port: number) {
        return host === knownHost.host && port === knownHost.port ? knownHost : undefined
      },
      getSecret() {
        return undefined
      }
    } as unknown as ConfigStore
    const profile = {
      name: 'localhost',
      host: sshd.host,
      port: sshd.port,
      username: sshd.username,
      authMethod: 'password' as const,
      saveProfile: false,
      saveSecret: false,
      x11: true
    }
    const request: SshConnectRequest = {
      profile,
      password: sshd.password,
      cols: 80,
      rows: 20
    }
    const session = new SshSession({
      id: 'x11-fallback',
      request,
      store,
      emit: (event) => events.push(event),
      x11: fakeX11
    })
    cleanups.push(async () => {
      await session.dispose()
    })

    const descriptor = await session.start()
    expect(descriptor.status).toBe('connected')
    expect(descriptor.environment).toBe('ssh')
    expect(cleanupCalls).toBe(1)
    expect(
      events.some(
        (event) => event.type === 'toast' && /rejected X11|without a GUI/i.test(event.message)
      )
    ).toBe(true)
    expect(targetClosed).toBe(false)
  }, 20_000)
})
