import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LocalTerminalMode, SshProfile } from '@shared/types'
import { AppError } from '../../src/main/errors'
import {
  CONFIG_VERSION,
  createConfigStore,
  defaultSettings,
  defaultUiState
} from '../../src/main/store/config-store'
import type { ConfigStoreOptions, SafeStorageLike } from '../../src/main/store/config-store'
import type { ConfigStore } from '../../src/main/store/types'

/** Deterministic stand-in for Electron's safeStorage (prefix marks ciphertext). */
class FakeSafeStorage implements SafeStorageLike {
  available = true
  readonly encryptedValues: string[] = []

  isEncryptionAvailable(): boolean {
    return this.available
  }

  encryptString(value: string): Buffer {
    this.encryptedValues.push(value)
    return Buffer.from(`ENC:${value}`, 'utf8')
  }

  decryptString(value: Buffer): string {
    const text = value.toString('utf8')
    if (!text.startsWith('ENC:')) throw new Error('Not a fake ciphertext')
    return text.slice(4)
  }
}

let workDir: string
let configPath: string
let downloadDir: string
let safeStorage: FakeSafeStorage

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'termshelf-config-'))
  configPath = path.join(workDir, 'config.json')
  downloadDir = path.join(workDir, 'Downloads')
  safeStorage = new FakeSafeStorage()
})

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true })
})

function options(overrides: Partial<ConfigStoreOptions> = {}): ConfigStoreOptions {
  return { filePath: configPath, defaultDownloadDir: downloadDir, safeStorage, ...overrides }
}

async function openStore(overrides: Partial<ConfigStoreOptions> = {}): Promise<ConfigStore> {
  return createConfigStore(options(overrides))
}

async function readConfig(): Promise<Record<string, any>> {
  return JSON.parse(await readFile(configPath, 'utf8')) as Record<string, any>
}

function makeProfile(overrides: Partial<SshProfile> = {}): SshProfile {
  return {
    name: 'Demo server',
    host: '127.0.0.1',
    port: 2222,
    username: 'demo',
    authMethod: 'password',
    saveProfile: true,
    saveSecret: false,
    ...overrides
  }
}

async function corruptBackups(): Promise<string[]> {
  const entries = await readdir(workDir)
  return entries.filter((name) => name.startsWith('config.json.corrupt-') && name.endsWith('.bak'))
}

describe('ConfigStore basics', () => {
  it('starts with defaults and does not write a config file until something changes', async () => {
    const store = await openStore()
    expect(store.encryptionAvailable).toBe(true)
    expect(store.getSettings()).toEqual(defaultSettings(downloadDir))
    expect(store.getUi()).toEqual(defaultUiState())
    expect(store.listProfiles()).toEqual([])
    expect(store.listKnownHosts()).toEqual([])

    await store.flush()
    await expect(readFile(configPath, 'utf8')).rejects.toThrow()
  })

  it('returns defensive copies of settings and UI state', async () => {
    const store = await openStore()
    const settings = store.getSettings()
    settings.fontSize = 1
    expect(store.getSettings().fontSize).toBe(defaultSettings(downloadDir).fontSize)

    const ui = store.getUi()
    ui.sidebarWidth = 1
    expect(store.getUi().sidebarWidth).toBe(defaultUiState().sidebarWidth)
  })

  it('writes a versioned config file with the expected top-level shape', async () => {
    const store = await openStore()
    store.saveProfile(makeProfile())
    store.trustHostKey({
      host: '127.0.0.1',
      port: 2222,
      algorithm: 'ssh-ed25519',
      fingerprint: 'SHA256:abc'
    })
    await store.flush()

    const config = await readConfig()
    expect(config.version).toBe(CONFIG_VERSION)
    expect(config.settings.defaultDownloadDir).toBe(downloadDir)
    expect(config.ui.sidebarWidth).toBe(defaultUiState().sidebarWidth)
    expect(config.profiles).toHaveLength(1)
    expect(config.knownHosts).toHaveLength(1)
    expect(config.secrets).toEqual({})
  })
})

describe('ConfigStore profiles and secrets', () => {
  it('persists a profile and reloads it', async () => {
    const store = await openStore()
    const saved = store.saveProfile(makeProfile())
    expect(saved.id).toBeTruthy()
    expect(saved.hasSavedPassword).toBe(false)
    await store.flush()

    const reloaded = await openStore()
    expect(reloaded.listProfiles()).toHaveLength(1)
    expect(reloaded.getStoredProfile(saved.id)?.host).toBe('127.0.0.1')
    expect(reloaded.getStoredProfile(saved.id)?.username).toBe('demo')
  })

  it('round-trips encrypted secrets and never writes plaintext', async () => {
    const store = await openStore()
    const saved = store.saveProfile(makeProfile({ saveSecret: true }), {
      password: 's3cret-password',
      passphrase: 'p@ssphrase-value'
    })
    expect(saved.hasSavedPassword).toBe(true)
    expect(saved.hasSavedPassphrase).toBe(true)
    expect(store.getSecret(saved.id, 'password')).toBe('s3cret-password')
    expect(store.getSecret(saved.id, 'passphrase')).toBe('p@ssphrase-value')
    await store.flush()

    const text = await readFile(configPath, 'utf8')
    expect(text).not.toContain('s3cret-password')
    expect(text).not.toContain('p@ssphrase-value')

    const config = await readConfig()
    const blob = config.secrets[saved.id].password as string
    expect(Buffer.from(blob, 'base64').toString('utf8')).toBe('ENC:s3cret-password')

    const reloaded = await openStore()
    expect(reloaded.getSecret(saved.id, 'password')).toBe('s3cret-password')
    expect(reloaded.getSecret(saved.id, 'passphrase')).toBe('p@ssphrase-value')
    expect(reloaded.listProfiles()[0]?.hasSavedPassword).toBe(true)
    expect(reloaded.listProfiles()[0]?.hasSavedPassphrase).toBe(true)
  })

  it('stores no secret at all when OS encryption is unavailable', async () => {
    safeStorage.available = false
    const store = await openStore()
    expect(store.encryptionAvailable).toBe(false)
    const saved = store.saveProfile(makeProfile({ saveSecret: true }), { password: 'plain-secret' })
    expect(saved.hasSavedPassword).toBe(false)
    expect(store.getSecret(saved.id, 'password')).toBeUndefined()
    await store.flush()

    const text = await readFile(configPath, 'utf8')
    expect(text).not.toContain('plain-secret')
    expect((await readConfig()).secrets).toEqual({})
  })

  it('persists the X11 forwarding preference on profiles', async () => {
    const store = await openStore()
    const saved = store.saveProfile(makeProfile({ x11: true }))
    expect(saved.x11).toBe(true)
    expect(store.listProfiles()[0]?.x11).toBe(true)
    await store.flush()

    const reloaded = await openStore()
    expect(reloaded.listProfiles()[0]?.x11).toBe(true)
    const updated = reloaded.saveProfile(makeProfile({ id: saved.id, x11: false }))
    expect(updated.x11).toBe(false)
  })

  it('behaves the same when no safeStorage backend is provided', async () => {
    const store = await openStore({ safeStorage: undefined })
    expect(store.encryptionAvailable).toBe(false)
    const saved = store.saveProfile(makeProfile({ saveSecret: true }), { password: 'unencrypted' })
    expect(saved.hasSavedPassword).toBe(false)
    await store.flush()
    expect(await readFile(configPath, 'utf8')).not.toContain('unencrypted')
  })

  it('drops saved secrets when saveSecret becomes false', async () => {
    const store = await openStore()
    const saved = store.saveProfile(makeProfile({ saveSecret: true }), { password: 'first-secret' })
    expect(store.getSecret(saved.id, 'password')).toBe('first-secret')

    const updated = store.saveProfile(makeProfile({ id: saved.id, saveSecret: false }))
    expect(updated.hasSavedPassword).toBe(false)
    expect(store.getSecret(saved.id, 'password')).toBeUndefined()
    await store.flush()

    const reloaded = await openStore()
    expect(reloaded.getSecret(saved.id, 'password')).toBeUndefined()
    expect((await readConfig()).secrets[saved.id]).toBeUndefined()
  })

  it('keeps existing ciphertext when a save carries no new secrets', async () => {
    const store = await openStore()
    const saved = store.saveProfile(makeProfile({ saveSecret: true }), { password: 'kept-secret' })
    await store.flush()

    // e.g. editing the profile name without re-entering the password.
    const updated = store.saveProfile(
      makeProfile({ id: saved.id, name: 'Renamed', saveSecret: true })
    )
    expect(updated.hasSavedPassword).toBe(true)
    expect(store.getSecret(saved.id, 'password')).toBe('kept-secret')

    await store.flush()
    const reloaded = await openStore()
    expect(reloaded.getSecret(saved.id, 'password')).toBe('kept-secret')
  })

  it('never persists one-off profiles (saveProfile: false)', async () => {
    const store = await openStore()
    const saved = store.saveProfile(makeProfile({ saveProfile: false, saveSecret: true }), {
      password: 'one-off'
    })
    expect(saved.id).toBeTruthy()
    expect(store.listProfiles()).toEqual([])
    await store.flush()
    await expect(readFile(configPath, 'utf8')).rejects.toThrow()
  })

  it('deletes a profile together with its secrets', async () => {
    const store = await openStore()
    const saved = store.saveProfile(makeProfile({ saveSecret: true }), { password: 'gone-secret' })
    await store.flush()

    store.deleteProfile(saved.id)
    expect(store.listProfiles()).toEqual([])
    expect(store.getSecret(saved.id, 'password')).toBeUndefined()
    await store.flush()

    const reloaded = await openStore()
    expect(reloaded.listProfiles()).toEqual([])
    expect((await readConfig()).secrets).toEqual({})
  })

  it('recomputes hasSavedPassword flags from the stored blobs on load', async () => {
    const passwordBlob = Buffer.from('ENC:loaded-secret', 'utf8').toString('base64')
    const config = {
      version: CONFIG_VERSION,
      settings: defaultSettings(downloadDir),
      ui: defaultUiState(),
      profiles: [
        {
          id: 'profile-1',
          name: 'Stale flags',
          host: 'example.test',
          port: 22,
          username: 'demo',
          authMethod: 'password',
          hasSavedPassword: false,
          hasSavedPassphrase: false
        }
      ],
      knownHosts: [],
      secrets: { 'profile-1': { password: passwordBlob } }
    }
    await writeFile(configPath, JSON.stringify(config), 'utf8')

    const store = await openStore()
    expect(store.listProfiles()[0]?.hasSavedPassword).toBe(true)
    expect(store.getSecret('profile-1', 'password')).toBe('loaded-secret')
  })
})

describe('ConfigStore known hosts', () => {
  it('trusts, persists and forgets host keys', async () => {
    const store = await openStore()
    store.trustHostKey({
      host: '127.0.0.1',
      port: 2222,
      algorithm: 'ssh-ed25519',
      fingerprint: 'SHA256:abcdef'
    })
    expect(store.getKnownHost('127.0.0.1', 2222)?.fingerprint).toBe('SHA256:abcdef')
    expect(store.listKnownHosts()).toHaveLength(1)
    await store.flush()

    const reloaded = await openStore()
    expect(reloaded.getKnownHost('127.0.0.1', 2222)?.algorithm).toBe('ssh-ed25519')
    reloaded.forgetHostKey('127.0.0.1', 2222)
    expect(reloaded.getKnownHost('127.0.0.1', 2222)).toBeUndefined()
    await reloaded.flush()

    const again = await openStore()
    expect(again.listKnownHosts()).toEqual([])
  })

  it('rejects invalid host key records', async () => {
    const store = await openStore()
    try {
      store.trustHostKey({
        host: '',
        port: 2222,
        algorithm: 'ssh-ed25519',
        fingerprint: 'SHA256:x'
      })
      throw new Error('expected trustHostKey to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(AppError)
      expect((error as AppError).code).toBe('INVALID_ARGUMENT')
    }
  })
})

describe('ConfigStore settings, UI and recovery', () => {
  it('clamps numeric settings and UI values and persists them', async () => {
    const store = await openStore()
    const settings = store.updateSettings({
      fontSize: 999,
      showHiddenFiles: true,
      confirmDelete: false,
      defaultDownloadDir: '/new/downloads'
    })
    expect(settings.fontSize).toBe(32)
    expect(settings.showHiddenFiles).toBe(true)
    expect(settings.confirmDelete).toBe(false)
    expect(settings.defaultDownloadDir).toBe('/new/downloads')
    expect(store.updateSettings({ fontSize: 2 }).fontSize).toBe(8)

    const ui = store.updateUi({
      sidebarWidth: 20,
      transferDrawerHeight: 5000,
      sortKey: 'size',
      sortDir: 'desc'
    })
    expect(ui.sidebarWidth).toBe(180)
    expect(ui.transferDrawerHeight).toBe(800)
    expect(ui.sortKey).toBe('size')
    expect(ui.sortDir).toBe('desc')

    store.setWindowBounds({ x: 10, y: 20, width: 1280, height: 800 })
    store.setWindowBounds({ x: 0, y: 0, width: 0, height: 0 }) // invalid, ignored
    expect(store.getUi().windowBounds).toEqual({ x: 10, y: 20, width: 1280, height: 800 })
    store.setWindowBounds(null)
    expect(store.getUi().windowBounds).toBeNull()
    await store.flush()

    const reloaded = await openStore()
    expect(reloaded.getSettings().fontSize).toBe(8)
    expect(reloaded.getUi().sidebarWidth).toBe(180)
    expect(reloaded.getUi().sortKey).toBe('size')
    expect(reloaded.getUi().windowBounds).toBeNull()
  })

  it('recovers from corrupt JSON by backing it up and using defaults', async () => {
    const corrupt = '{ this is not valid json'
    await writeFile(configPath, corrupt, 'utf8')

    const store = await openStore()
    expect(store.getSettings()).toEqual(defaultSettings(downloadDir))
    await store.flush()

    const backups = await corruptBackups()
    expect(backups).toHaveLength(1)
    expect(await readFile(path.join(workDir, backups[0]!), 'utf8')).toBe(corrupt)
    const recovered = await readConfig()
    expect(recovered.version).toBe(CONFIG_VERSION)
  })

  it('recovers from an unknown config version', async () => {
    await writeFile(
      configPath,
      JSON.stringify({ version: CONFIG_VERSION + 1, settings: {}, ui: {} }),
      'utf8'
    )
    const store = await openStore()
    expect(store.getSettings()).toEqual(defaultSettings(downloadDir))
    await store.flush()
    expect(await corruptBackups()).toHaveLength(1)
    expect((await readConfig()).version).toBe(CONFIG_VERSION)
  })

  it('ignores malformed fields but keeps valid siblings', async () => {
    const config = {
      version: CONFIG_VERSION,
      settings: {
        ...defaultSettings(downloadDir),
        fontSize: 'huge',
        followCwd: 'yes',
        showHiddenFiles: true
      },
      ui: { ...defaultUiState(), sidebarWidth: 5000, sortKey: 'sideways' },
      profiles: [
        { id: '', name: '' },
        { id: 'ok', name: 'Valid', host: 'h', username: 'u' }
      ],
      knownHosts: [{}],
      secrets: {}
    }
    await writeFile(configPath, JSON.stringify(config), 'utf8')

    const store = await openStore()
    const settings = store.getSettings()
    expect(settings.fontSize).toBe(defaultSettings(downloadDir).fontSize)
    expect(settings.followCwd).toBe(true)
    expect(settings.showHiddenFiles).toBe(true)
    expect(store.getUi().sidebarWidth).toBe(1200)
    expect(store.getUi().sortKey).toBe('name')
    expect(store.listProfiles()).toHaveLength(1)
    expect(store.listKnownHosts()).toEqual([])
  })
})

describe('ConfigStore local terminal (WSL) settings', () => {
  it('defaults to auto terminal selection and the WSL default distro', async () => {
    const store = await openStore()
    const settings = store.getSettings()
    expect(settings.localTerminal).toBe('auto')
    expect(settings.wslDistro).toBeNull()

    // Defaults alone are not persisted; force a write and check the serialized shape.
    store.setWindowBounds({ x: 10, y: 20, width: 1280, height: 800 })
    await store.flush()
    const config = await readConfig()
    expect(config.settings.localTerminal).toBe('auto')
    expect(config.settings.wslDistro).toBeNull()
  })

  it('applies and persists valid localTerminal / wslDistro updates', async () => {
    const store = await openStore()
    expect(store.updateSettings({ localTerminal: 'wsl' }).localTerminal).toBe('wsl')
    expect(store.updateSettings({ wslDistro: '  Ubuntu-22.04  ' }).wslDistro).toBe('Ubuntu-22.04')
    expect(store.updateSettings({ localTerminal: 'native' }).localTerminal).toBe('native')
    await store.flush()

    const reloaded = await openStore()
    expect(reloaded.getSettings().localTerminal).toBe('native')
    expect(reloaded.getSettings().wslDistro).toBe('Ubuntu-22.04')
  })

  it('ignores unknown modes and validates distro values without clobbering state', async () => {
    const store = await openStore()
    store.updateSettings({ localTerminal: 'wsl', wslDistro: 'Debian' })

    // Unknown enum values are ignored (state is preserved).
    expect(
      store.updateSettings({ localTerminal: 'hyper-v' as unknown as LocalTerminalMode })
        .localTerminal
    ).toBe('wsl')
    // Non-string distro values are ignored.
    expect(store.updateSettings({ wslDistro: 42 as unknown as string }).wslDistro).toBe('Debian')
    // Empty/whitespace strings and null mean "the WSL default distro".
    expect(store.updateSettings({ wslDistro: '   ' }).wslDistro).toBeNull()
    expect(store.updateSettings({ wslDistro: 'Debian' }).wslDistro).toBe('Debian')
    expect(store.updateSettings({ wslDistro: null }).wslDistro).toBeNull()
    // An 'auto' patch does not disturb the distro field unless it is provided.
    expect(store.updateSettings({ localTerminal: 'auto' }).wslDistro).toBeNull()
  })

  it('loads persisted localTerminal / wslDistro from the config file', async () => {
    const config = {
      version: CONFIG_VERSION,
      settings: {
        ...defaultSettings(downloadDir),
        localTerminal: 'wsl',
        wslDistro: 'Ubuntu-22.04'
      },
      ui: defaultUiState(),
      profiles: [],
      knownHosts: [],
      secrets: {}
    }
    await writeFile(configPath, JSON.stringify(config), 'utf8')

    const store = await openStore()
    expect(store.getSettings().localTerminal).toBe('wsl')
    expect(store.getSettings().wslDistro).toBe('Ubuntu-22.04')
    await store.flush()
    const reloaded = await openStore()
    expect(reloaded.getSettings()).toMatchObject({
      localTerminal: 'wsl',
      wslDistro: 'Ubuntu-22.04'
    })
  })

  it('sanitizes invalid persisted localTerminal / wslDistro values', async () => {
    const invalid = {
      version: CONFIG_VERSION,
      settings: {
        ...defaultSettings(downloadDir),
        localTerminal: 'not-a-mode',
        wslDistro: 7
      },
      ui: defaultUiState(),
      profiles: [],
      knownHosts: [],
      secrets: {}
    }
    await writeFile(configPath, JSON.stringify(invalid), 'utf8')
    const fallbackStore = await openStore()
    expect(fallbackStore.getSettings().localTerminal).toBe('auto')
    expect(fallbackStore.getSettings().wslDistro).toBeNull()

    const blank = {
      version: CONFIG_VERSION,
      settings: { ...defaultSettings(downloadDir), localTerminal: 'wsl', wslDistro: '   ' },
      ui: defaultUiState(),
      profiles: [],
      knownHosts: [],
      secrets: {}
    }
    await writeFile(configPath, JSON.stringify(blank), 'utf8')
    const blankStore = await openStore()
    expect(blankStore.getSettings().localTerminal).toBe('wsl')
    expect(blankStore.getSettings().wslDistro).toBeNull()
  })
})
