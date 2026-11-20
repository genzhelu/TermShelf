import type {
  HostKeyInfo,
  HostKeyRecord,
  Settings,
  SshProfile,
  SshProfileSummary,
  UiState,
  WindowBounds
} from '@shared/types'

export interface StoredSecret {
  password?: string
  passphrase?: string
}

export interface StoredProfile {
  id: string
  name: string
  host: string
  port: number
  username: string
  authMethod: 'password' | 'privateKey' | 'agent'
  privateKeyPath?: string
  x11: boolean
  hasSavedPassword: boolean
  hasSavedPassphrase: boolean
  lastUsedAt?: string
}

export type UiPatch = Partial<
  Pick<UiState, 'sidebarWidth' | 'transferDrawerHeight' | 'sortKey' | 'sortDir'>
>

/**
 * Persistent application configuration. Secrets are encrypted with Electron
 * safeStorage when available; callers only ever receive plaintext secrets from
 * `getSecret` in the main process.
 */
export interface ConfigStore {
  readonly encryptionAvailable: boolean
  getSettings(): Settings
  getUi(): UiState
  updateSettings(patch: Partial<Settings>): Settings
  updateUi(patch: UiPatch): UiState
  setWindowBounds(bounds: WindowBounds | null): void
  listProfiles(): SshProfileSummary[]
  saveProfile(profile: SshProfile, secrets?: StoredSecret): SshProfileSummary
  deleteProfile(profileId: string): void
  getStoredProfile(profileId: string): StoredProfile | undefined
  getSecret(profileId: string, kind: 'password' | 'passphrase'): string | undefined
  listKnownHosts(): HostKeyRecord[]
  getKnownHost(host: string, port: number): HostKeyRecord | undefined
  trustHostKey(info: HostKeyInfo): void
  forgetHostKey(host: string, port: number): void
  /** Persists pending writes immediately. */
  flush(): Promise<void>
}
