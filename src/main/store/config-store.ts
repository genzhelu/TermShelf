import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  AuthMethod,
  LocalTerminalMode,
  HostKeyInfo,
  HostKeyRecord,
  Settings,
  SortDir,
  SortKey,
  SshProfile,
  SshProfileSummary,
  UiState,
  WindowBounds
} from '@shared/types'
import { AppError } from '../errors'
import type { ConfigStore, StoredProfile, StoredSecret, UiPatch } from './types'

/** On-disk config format version. Older/unrecognised files are backed up and replaced. */
export const CONFIG_VERSION = 1

/** Delay used to coalesce rapid mutations into a single atomic write. */
const FLUSH_DEBOUNCE_MS = 150

const MAX_PATH_LENGTH = 4096
const MAX_SHORT_STRING = 255
const MAX_FINGERPRINT_LENGTH = 512
const MAX_ALGORITHM_LENGTH = 64

/**
 * Minimal subset of Electron's `safeStorage` API. Injected by the caller so the
 * config store is importable and testable from plain Node without Electron.
 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

export interface ConfigStoreOptions {
  /** Absolute path of the JSON config file. */
  filePath: string
  /** Directory used for `defaultDownloadDir`/`lastDownloadDir` on first run. */
  defaultDownloadDir: string
  /** Optional OS-backed encryption used for saved SSH secrets. */
  safeStorage?: SafeStorageLike
}

interface PersistedSecretBlobs {
  password?: string
  passphrase?: string
}

interface ParsedConfig {
  settings: Settings
  ui: UiState
  profiles: unknown[]
  knownHosts: unknown[]
  secrets: Record<string, unknown>
}

interface PersistedConfig {
  version: number
  settings: Settings
  ui: UiState
  profiles: StoredProfile[]
  knownHosts: HostKeyRecord[]
  secrets: Record<string, PersistedSecretBlobs>
}

const SORT_KEYS: readonly SortKey[] = ['name', 'size', 'mtime']
const SORT_DIRS: readonly SortDir[] = ['asc', 'desc']
const AUTH_METHODS: readonly AuthMethod[] = ['password', 'privateKey', 'agent']
const LOCAL_TERMINAL_MODES: readonly LocalTerminalMode[] = ['auto', 'native', 'wsl']

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asString(value: unknown, fallback: string, maxLength = MAX_PATH_LENGTH): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.length > maxLength ? value.slice(0, maxLength) : value
  return trimmed
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const rounded = Math.round(value)
  return Math.min(max, Math.max(min, rounded))
}

function asNullableString(value: unknown, fallback: string | null): string | null {
  if (value === null) return null
  if (typeof value === 'string') return value.slice(0, MAX_PATH_LENGTH)
  return fallback
}

function asSortKey(value: unknown, fallback: SortKey): SortKey {
  return SORT_KEYS.includes(value as SortKey) ? (value as SortKey) : fallback
}

function asSortDir(value: unknown, fallback: SortDir): SortDir {
  return SORT_DIRS.includes(value as SortDir) ? (value as SortDir) : fallback
}

function asAuthMethod(value: unknown, fallback: AuthMethod): AuthMethod {
  return AUTH_METHODS.includes(value as AuthMethod) ? (value as AuthMethod) : fallback
}

export function defaultSettings(defaultDownloadDir: string): Settings {
  return {
    defaultDownloadDir,
    lastDownloadDir: defaultDownloadDir,
    followCwd: true,
    showHiddenFiles: false,
    fontSize: 13,
    shellPath: null,
    localTerminal: 'auto',
    wslDistro: null,
    confirmDelete: true
  }
}

export function defaultUiState(): UiState {
  return {
    sidebarWidth: 320,
    transferDrawerHeight: 170,
    sortKey: 'name',
    sortDir: 'asc',
    windowBounds: null
  }
}

function sanitizeSettings(value: unknown, fallback: Settings): Settings {
  const record = isRecord(value) ? value : {}
  return {
    defaultDownloadDir: asString(record.defaultDownloadDir, fallback.defaultDownloadDir),
    lastDownloadDir: asString(record.lastDownloadDir, fallback.lastDownloadDir),
    followCwd: asBoolean(record.followCwd, fallback.followCwd),
    showHiddenFiles: asBoolean(record.showHiddenFiles, fallback.showHiddenFiles),
    fontSize: clampInt(record.fontSize, 8, 32, fallback.fontSize),
    shellPath: asNullableString(record.shellPath, fallback.shellPath),
    localTerminal: LOCAL_TERMINAL_MODES.includes(record.localTerminal as LocalTerminalMode)
      ? (record.localTerminal as LocalTerminalMode)
      : fallback.localTerminal,
    wslDistro:
      typeof record.wslDistro === 'string'
        ? record.wslDistro.trim() || null
        : record.wslDistro === null
          ? null
          : fallback.wslDistro,
    confirmDelete: asBoolean(record.confirmDelete, fallback.confirmDelete)
  }
}

function sanitizeWindowBounds(value: unknown): WindowBounds | null {
  if (!isRecord(value)) return null
  const { x, y, width, height } = value
  if ([x, y, width, height].some((part) => typeof part !== 'number' || !Number.isFinite(part))) {
    return null
  }
  const result = {
    x: Math.round(x as number),
    y: Math.round(y as number),
    width: Math.round(width as number),
    height: Math.round(height as number)
  }
  if (result.width < 1 || result.height < 1 || result.width > 100_000 || result.height > 100_000) {
    return null
  }
  return result
}

function sanitizeUi(value: unknown, fallback: UiState): UiState {
  const record = isRecord(value) ? value : {}
  return {
    sidebarWidth: clampInt(record.sidebarWidth, 180, 1200, fallback.sidebarWidth),
    transferDrawerHeight: clampInt(
      record.transferDrawerHeight,
      80,
      800,
      fallback.transferDrawerHeight
    ),
    sortKey: asSortKey(record.sortKey, fallback.sortKey),
    sortDir: asSortDir(record.sortDir, fallback.sortDir),
    windowBounds:
      record.windowBounds === undefined
        ? fallback.windowBounds
        : sanitizeWindowBounds(record.windowBounds)
  }
}

function sanitizeProfile(value: unknown): StoredProfile | null {
  if (!isRecord(value)) return null
  const id = typeof value.id === 'string' ? value.id.trim().slice(0, 128) : ''
  const name = typeof value.name === 'string' ? value.name.slice(0, 80) : ''
  const host = typeof value.host === 'string' ? value.host.slice(0, MAX_SHORT_STRING) : ''
  const username =
    typeof value.username === 'string' ? value.username.slice(0, MAX_SHORT_STRING) : ''
  if (!id || !name || !host || !username) return null
  const lastUsedAt =
    typeof value.lastUsedAt === 'string' && !Number.isNaN(Date.parse(value.lastUsedAt))
      ? value.lastUsedAt
      : undefined
  const privateKeyPath =
    typeof value.privateKeyPath === 'string' && value.privateKeyPath
      ? value.privateKeyPath.slice(0, MAX_PATH_LENGTH)
      : undefined
  return {
    id,
    name,
    host,
    port: clampInt(value.port, 1, 65_535, 22),
    username,
    authMethod: asAuthMethod(value.authMethod, 'password'),
    ...(privateKeyPath ? { privateKeyPath } : {}),
    x11: asBoolean(value.x11, false),
    hasSavedPassword: asBoolean(value.hasSavedPassword, false),
    hasSavedPassphrase: asBoolean(value.hasSavedPassphrase, false),
    ...(lastUsedAt ? { lastUsedAt } : {})
  }
}

function sanitizeKnownHost(value: unknown): HostKeyRecord | null {
  if (!isRecord(value)) return null
  const host = typeof value.host === 'string' ? value.host.slice(0, MAX_SHORT_STRING) : ''
  const algorithm =
    typeof value.algorithm === 'string' ? value.algorithm.slice(0, MAX_ALGORITHM_LENGTH) : ''
  const fingerprint =
    typeof value.fingerprint === 'string' ? value.fingerprint.slice(0, MAX_FINGERPRINT_LENGTH) : ''
  if (!host || !algorithm || !fingerprint) return null
  const addedAt =
    typeof value.addedAt === 'string' && !Number.isNaN(Date.parse(value.addedAt))
      ? value.addedAt
      : new Date().toISOString()
  return {
    host,
    port: clampInt(value.port, 1, 65_535, 22),
    algorithm,
    fingerprint,
    addedAt
  }
}

function sanitizeSecretBlobs(value: unknown): PersistedSecretBlobs {
  const record = isRecord(value) ? value : {}
  const result: PersistedSecretBlobs = {}
  if (typeof record.password === 'string' && record.password) result.password = record.password
  if (typeof record.passphrase === 'string' && record.passphrase) {
    result.passphrase = record.passphrase
  }
  return result
}

function knownHostKey(host: string, port: number): string {
  return `${host}:${port}`
}

export class ConfigStoreImpl implements ConfigStore {
  readonly encryptionAvailable: boolean

  private readonly filePath: string
  private readonly safeStorage: SafeStorageLike | undefined
  private settings: Settings
  private ui: UiState
  private readonly profiles = new Map<string, StoredProfile>()
  private readonly knownHosts = new Map<string, HostKeyRecord>()
  /** Saved secrets keyed by profile id; values are encrypted, base64-encoded blobs. */
  private readonly secrets = new Map<string, PersistedSecretBlobs>()

  private dirty = false
  private timer: NodeJS.Timeout | null = null
  private pendingWrite: Promise<void> = Promise.resolve()

  private constructor(options: ConfigStoreOptions) {
    this.filePath = options.filePath
    this.safeStorage = options.safeStorage
    this.encryptionAvailable = this.resolveEncryptionAvailable()
    this.settings = defaultSettings(options.defaultDownloadDir)
    this.ui = defaultUiState()
  }

  static async open(options: ConfigStoreOptions): Promise<ConfigStoreImpl> {
    const store = new ConfigStoreImpl(options)
    await store.load()
    return store
  }

  private resolveEncryptionAvailable(): boolean {
    if (!this.safeStorage) return false
    try {
      return this.safeStorage.isEncryptionAvailable() === true
    } catch {
      return false
    }
  }

  private async load(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.filePath, 'utf8')
    } catch {
      // First run (ENOENT) or an unreadable file: use defaults. The file is only
      // rewritten once the caller mutates state, so unreadable data is not clobbered.
      return
    }

    const parsed = this.parseConfig(raw)
    if (!parsed) {
      await this.backupCorruptFile(raw)
      this.dirty = true
      this.scheduleFlush()
      return
    }
    this.applyPersisted(parsed)
  }

  private parseConfig(raw: string): ParsedConfig | null {
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      return null
    }
    if (!isRecord(value)) return null
    if (value.version !== CONFIG_VERSION) return null
    if (!isRecord(value.settings) || !isRecord(value.ui)) return null
    return {
      settings: sanitizeSettings(value.settings, this.settings),
      ui: sanitizeUi(value.ui, this.ui),
      profiles: Array.isArray(value.profiles) ? value.profiles : [],
      knownHosts: Array.isArray(value.knownHosts) ? value.knownHosts : [],
      secrets: isRecord(value.secrets) ? value.secrets : {}
    }
  }

  private applyPersisted(parsed: ParsedConfig): void {
    this.settings = parsed.settings
    this.ui = parsed.ui
    for (const candidate of parsed.profiles) {
      const profile = sanitizeProfile(candidate)
      if (profile) this.profiles.set(profile.id, profile)
    }
    for (const candidate of parsed.knownHosts) {
      const record = sanitizeKnownHost(candidate)
      if (record) this.knownHosts.set(knownHostKey(record.host, record.port), record)
    }
    for (const [profileId, blobs] of Object.entries(parsed.secrets)) {
      if (!this.profiles.has(profileId)) continue
      const sanitized = sanitizeSecretBlobs(blobs)
      if (sanitized.password || sanitized.passphrase) this.secrets.set(profileId, sanitized)
    }
    // Persisted hasSaved* flags may be stale (e.g. blobs deleted); recompute them.
    for (const profile of this.profiles.values()) {
      profile.hasSavedPassword = this.hasSecret(profile.id, 'password')
      profile.hasSavedPassphrase = this.hasSecret(profile.id, 'passphrase')
    }
  }

  private async backupCorruptFile(raw: string): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backupPath = `${this.filePath}.corrupt-${stamp}-${randomUUID().slice(0, 8)}.bak`
    try {
      await writeFile(backupPath, raw, { mode: 0o600 })
    } catch {
      // Backup is best effort; defaults are still used.
    }
  }

  private cloneSettings(): Settings {
    return { ...this.settings }
  }

  private cloneUi(): UiState {
    return {
      ...this.ui,
      windowBounds: this.ui.windowBounds ? { ...this.ui.windowBounds } : null
    }
  }

  getSettings(): Settings {
    return this.cloneSettings()
  }

  getUi(): UiState {
    return this.cloneUi()
  }

  /** Applies only well-formed fields; numbers are clamped to the supported ranges. */
  updateSettings(patch: Partial<Settings>): Settings {
    const record = isRecord(patch) ? patch : {}
    const next: Settings = {
      defaultDownloadDir: this.settings.defaultDownloadDir,
      lastDownloadDir: this.settings.lastDownloadDir,
      followCwd: this.settings.followCwd,
      showHiddenFiles: this.settings.showHiddenFiles,
      fontSize: this.settings.fontSize,
      shellPath: this.settings.shellPath,
      localTerminal: this.settings.localTerminal,
      wslDistro: this.settings.wslDistro,
      confirmDelete: this.settings.confirmDelete
    }
    if (record.defaultDownloadDir !== undefined) {
      next.defaultDownloadDir = asString(record.defaultDownloadDir, next.defaultDownloadDir)
    }
    if (record.lastDownloadDir !== undefined) {
      next.lastDownloadDir = asString(record.lastDownloadDir, next.lastDownloadDir)
    }
    if (record.followCwd !== undefined) next.followCwd = asBoolean(record.followCwd, next.followCwd)
    if (record.showHiddenFiles !== undefined) {
      next.showHiddenFiles = asBoolean(record.showHiddenFiles, next.showHiddenFiles)
    }
    if (record.fontSize !== undefined) {
      next.fontSize = clampInt(record.fontSize, 8, 32, next.fontSize)
    }
    if (record.shellPath !== undefined) {
      next.shellPath = asNullableString(record.shellPath, next.shellPath)
    }
    if (record.localTerminal !== undefined) {
      if (
        typeof record.localTerminal === 'string' &&
        LOCAL_TERMINAL_MODES.includes(record.localTerminal as LocalTerminalMode)
      ) {
        next.localTerminal = record.localTerminal as LocalTerminalMode
      }
    }
    if (record.wslDistro !== undefined) {
      if (typeof record.wslDistro === 'string') {
        next.wslDistro = record.wslDistro.trim() || null
      } else if (record.wslDistro === null) {
        next.wslDistro = null
      }
    }
    if (record.confirmDelete !== undefined) {
      next.confirmDelete = asBoolean(record.confirmDelete, next.confirmDelete)
    }
    this.settings = next
    this.markDirty()
    return this.cloneSettings()
  }

  updateUi(patch: UiPatch): UiState {
    const record = isRecord(patch) ? patch : {}
    const next = this.cloneUi()
    if (record.sidebarWidth !== undefined) {
      next.sidebarWidth = clampInt(record.sidebarWidth, 180, 1200, next.sidebarWidth)
    }
    if (record.transferDrawerHeight !== undefined) {
      next.transferDrawerHeight = clampInt(
        record.transferDrawerHeight,
        80,
        800,
        next.transferDrawerHeight
      )
    }
    if (record.sortKey !== undefined) next.sortKey = asSortKey(record.sortKey, next.sortKey)
    if (record.sortDir !== undefined) next.sortDir = asSortDir(record.sortDir, next.sortDir)
    this.ui = next
    this.markDirty()
    return this.cloneUi()
  }

  setWindowBounds(bounds: WindowBounds | null): void {
    if (bounds !== null) {
      const sanitized = sanitizeWindowBounds(bounds)
      if (!sanitized) return
      this.ui.windowBounds = sanitized
    } else {
      this.ui.windowBounds = null
    }
    this.markDirty()
  }

  listProfiles(): SshProfileSummary[] {
    return [...this.profiles.values()].map((profile) => this.toSummary(profile))
  }

  saveProfile(profile: SshProfile, secrets?: StoredSecret): SshProfileSummary {
    const id = profile.id?.trim() || randomUUID()

    if (!profile.saveProfile) {
      // Do not persist anything for one-off connections, but still return a
      // stable summary so the caller can use the id immediately.
      const existing = this.profiles.get(id)
      return this.toSummary({
        id,
        name: profile.name,
        host: profile.host,
        port: profile.port,
        username: profile.username,
        authMethod: profile.authMethod,
        ...(profile.privateKeyPath ? { privateKeyPath: profile.privateKeyPath } : {}),
        x11: profile.x11 === true,
        hasSavedPassword: false,
        hasSavedPassphrase: false,
        ...(existing?.lastUsedAt ? { lastUsedAt: existing.lastUsedAt } : {})
      })
    }

    if (!profile.saveSecret) {
      // The caller explicitly asked not to save secrets: drop any saved ones.
      this.secrets.delete(id)
    } else if (this.encryptionAvailable && secrets) {
      const merged = this.secrets.get(id) ?? {}
      const next: PersistedSecretBlobs = { ...merged }
      if (typeof secrets.password === 'string' && secrets.password) {
        const encrypted = this.encryptSecret(secrets.password)
        if (encrypted) next.password = encrypted
      }
      if (typeof secrets.passphrase === 'string' && secrets.passphrase) {
        const encrypted = this.encryptSecret(secrets.passphrase)
        if (encrypted) next.passphrase = encrypted
      }
      if (next.password || next.passphrase) this.secrets.set(id, next)
      else this.secrets.delete(id)
    }
    // Otherwise existing ciphertext is left untouched: a save with no new secrets
    // must not erase previously saved credentials, and no plaintext can be written
    // when encryption is unavailable.

    const record: StoredProfile = {
      id,
      name: profile.name,
      host: profile.host,
      port: profile.port,
      username: profile.username,
      authMethod: profile.authMethod,
      ...(profile.privateKeyPath ? { privateKeyPath: profile.privateKeyPath } : {}),
      x11: profile.x11 === true,
      hasSavedPassword: this.hasSecret(id, 'password'),
      hasSavedPassphrase: this.hasSecret(id, 'passphrase'),
      lastUsedAt: new Date().toISOString()
    }
    this.profiles.set(id, record)
    this.markDirty()
    return this.toSummary(record)
  }

  deleteProfile(profileId: string): void {
    const removedProfile = this.profiles.delete(profileId)
    const removedSecret = this.secrets.delete(profileId)
    if (removedProfile || removedSecret) this.markDirty()
  }

  getStoredProfile(profileId: string): StoredProfile | undefined {
    const record = this.profiles.get(profileId)
    return record ? this.toSummary(record) : undefined
  }

  getSecret(profileId: string, kind: 'password' | 'passphrase'): string | undefined {
    if (!this.encryptionAvailable) return undefined
    const blob = this.secrets.get(profileId)?.[kind]
    if (!blob) return undefined
    try {
      const decrypted = this.safeStorage?.decryptString(Buffer.from(blob, 'base64'))
      return typeof decrypted === 'string' && decrypted ? decrypted : undefined
    } catch {
      return undefined
    }
  }

  listKnownHosts(): HostKeyRecord[] {
    return [...this.knownHosts.values()].map((record) => ({ ...record }))
  }

  getKnownHost(host: string, port: number): HostKeyRecord | undefined {
    const record = this.knownHosts.get(knownHostKey(host, port))
    return record ? { ...record } : undefined
  }

  trustHostKey(info: HostKeyInfo): void {
    if (!info.host || !info.algorithm || !info.fingerprint || !Number.isFinite(info.port)) {
      throw new AppError('INVALID_ARGUMENT', 'Invalid host key record')
    }
    const record: HostKeyRecord = {
      host: info.host,
      port: Math.round(info.port),
      algorithm: info.algorithm,
      fingerprint: info.fingerprint,
      addedAt: new Date().toISOString()
    }
    this.knownHosts.set(knownHostKey(record.host, record.port), record)
    this.markDirty()
  }

  forgetHostKey(host: string, port: number): void {
    if (this.knownHosts.delete(knownHostKey(host, port))) this.markDirty()
  }

  async flush(): Promise<void> {
    this.clearTimer()
    if (!this.dirty) {
      await this.pendingWrite.catch(() => undefined)
      return
    }
    this.dirty = false
    const run = this.pendingWrite.catch(() => undefined).then(() => this.writeNow())
    this.pendingWrite = run
    await run
  }

  private markDirty(): void {
    this.dirty = true
    this.scheduleFlush()
  }

  private scheduleFlush(): void {
    if (this.timer) clearTimeout(this.timer)
    const timer = setTimeout(() => {
      this.timer = null
      void this.flush().catch(() => {
        this.dirty = true
      })
    }, FLUSH_DEBOUNCE_MS)
    // Never keep the process alive just for a config flush.
    timer.unref?.()
    this.timer = timer
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private hasSecret(profileId: string, kind: 'password' | 'passphrase'): boolean {
    if (!this.encryptionAvailable) return false
    return Boolean(this.secrets.get(profileId)?.[kind])
  }

  private encryptSecret(plaintext: string): string | undefined {
    if (!this.safeStorage || !this.encryptionAvailable) return undefined
    try {
      const encrypted = this.safeStorage.encryptString(plaintext)
      if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) return undefined
      return encrypted.toString('base64')
    } catch {
      return undefined
    }
  }

  private toSummary(record: StoredProfile): SshProfileSummary {
    return {
      id: record.id,
      name: record.name,
      host: record.host,
      port: record.port,
      username: record.username,
      authMethod: record.authMethod,
      ...(record.privateKeyPath ? { privateKeyPath: record.privateKeyPath } : {}),
      x11: record.x11,
      hasSavedPassword: this.hasSecret(record.id, 'password'),
      hasSavedPassphrase: this.hasSecret(record.id, 'passphrase'),
      ...(record.lastUsedAt ? { lastUsedAt: record.lastUsedAt } : {})
    }
  }

  private serialize(): PersistedConfig {
    const secrets: Record<string, PersistedSecretBlobs> = {}
    for (const [profileId, blobs] of this.secrets) {
      if (!this.profiles.has(profileId)) continue
      if (blobs.password || blobs.passphrase) secrets[profileId] = { ...blobs }
    }
    return {
      version: CONFIG_VERSION,
      settings: this.cloneSettings(),
      ui: this.cloneUi(),
      profiles: [...this.profiles.values()].map((profile) => ({ ...profile })),
      knownHosts: [...this.knownHosts.values()].map((record) => ({ ...record })),
      secrets
    }
  }

  private async writeNow(): Promise<void> {
    const payload = `${JSON.stringify(this.serialize(), null, 2)}\n`
    const directory = path.dirname(this.filePath)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const tempPath = `${this.filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
    try {
      await writeFile(tempPath, payload, { mode: 0o600 })
      await chmod(tempPath, 0o600)
      await rename(tempPath, this.filePath)
    } catch (error) {
      try {
        await rm(tempPath, { force: true })
      } catch {
        // best effort
      }
      throw error
    }
  }
}

/**
 * Opens (or creates) the persistent config store. The returned store debounces
 * writes; call `flush()` before shutdown. No Electron import is required.
 */
export async function createConfigStore(options: ConfigStoreOptions): Promise<ConfigStore> {
  return ConfigStoreImpl.open(options)
}
