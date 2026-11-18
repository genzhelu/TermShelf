export type Platform = 'win32' | 'darwin' | 'linux'

/** How paths are represented for a given session's file backend. */
export type PathStyle = 'posix' | 'win32'

export type SessionKind = 'local' | 'ssh'

export type SessionStatus = 'connecting' | 'connected' | 'disconnected' | 'error' | 'ended'

export type EntryKind = 'file' | 'dir' | 'symlink' | 'other'

export type AuthMethod = 'password' | 'privateKey' | 'agent'

export type ConflictPolicy = 'ask' | 'overwrite' | 'skip' | 'keepBoth' | 'cancel'

export type TransferDirection = 'upload' | 'download'

export type TransferJobState = 'scanning' | 'running' | 'completed' | 'failed' | 'cancelled'

export type SortKey = 'name' | 'size' | 'mtime'

export type SortDir = 'asc' | 'desc'

export type ToastLevel = 'info' | 'success' | 'warn' | 'error'

export type AppErrorCode =
  | 'SSH_AUTH_FAILED'
  | 'SSH_AUTH_REQUIRED'
  | 'SSH_HOST_KEY_UNKNOWN'
  | 'SSH_HOST_KEY_MISMATCH'
  | 'SSH_CONNECT_FAILED'
  | 'SSH_SFTP_UNAVAILABLE'
  | 'SSH_DISCONNECTED'
  | 'SSH_KEYBOARD_INTERACTIVE_UNSUPPORTED'
  | 'SHELL_SPAWN_FAILED'
  | 'FS_NOT_FOUND'
  | 'FS_PERMISSION_DENIED'
  | 'FS_EXISTS'
  | 'FS_INVALID_PATH'
  | 'TRANSFER_CONFLICT'
  | 'TRANSFER_CANCELLED'
  | 'TRANSFER_FAILED'
  | 'INVALID_ARGUMENT'
  | 'NOT_SUPPORTED'
  | 'UNKNOWN'

export interface AppErrorPayload {
  code: AppErrorCode
  message: string
  details?: Record<string, unknown>
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: AppErrorPayload }

export interface Breadcrumb {
  name: string
  path: string
}

export interface FileEntry {
  /** Absolute path in the backend's path style. */
  path: string
  name: string
  kind: EntryKind
  size: number
  mtimeMs: number
  /** POSIX permission bits when the backend exposes them. */
  mode?: number
  symlinkTarget?: string
}

export interface DirListing {
  path: string
  parentPath: string | null
  breadcrumbs: Breadcrumb[]
  entries: FileEntry[]
  truncated: boolean
}

export interface SessionDescriptor {
  id: string
  kind: SessionKind
  title: string
  status: SessionStatus
  pathStyle: PathStyle
  homePath: string | null
}

export interface LocalSessionRequest {
  cols: number
  rows: number
  shellPath?: string
  cwd?: string
}

export interface SshProfile {
  id?: string
  name: string
  host: string
  port: number
  username: string
  authMethod: AuthMethod
  privateKeyPath?: string
  saveProfile: boolean
  saveSecret: boolean
}

export interface SshConnectRequest {
  profile: SshProfile
  password?: string
  passphrase?: string
  cols: number
  rows: number
}

export interface SshProfileSummary {
  id: string
  name: string
  host: string
  port: number
  username: string
  authMethod: AuthMethod
  privateKeyPath?: string
  hasSavedPassword: boolean
  hasSavedPassphrase: boolean
  lastUsedAt?: string
}

export interface HostKeyInfo {
  host: string
  port: number
  algorithm: string
  fingerprint: string
}

export interface HostKeyRecord extends HostKeyInfo {
  addedAt: string
}

export interface Settings {
  defaultDownloadDir: string
  lastDownloadDir: string
  followCwd: boolean
  showHiddenFiles: boolean
  fontSize: number
  shellPath: string | null
  confirmDelete: boolean
}

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface UiState {
  sidebarWidth: number
  transferDrawerHeight: number
  sortKey: SortKey
  sortDir: SortDir
  windowBounds: WindowBounds | null
}

export interface PublicConfig {
  platform: Platform
  version: string
  encryptionAvailable: boolean
  settings: Settings
  ui: UiState
  profiles: SshProfileSummary[]
  knownHosts: HostKeyRecord[]
}

export interface ConfigPatch {
  settings?: Partial<Settings>
  ui?: Partial<Pick<UiState, 'sidebarWidth' | 'transferDrawerHeight' | 'sortKey' | 'sortDir'>>
}

export interface TransferConflict {
  name: string
  destinationPath: string
  kind: EntryKind
}

export interface TransferRequest {
  sessionId: string
  direction: TransferDirection
  /** Local absolute paths for uploads, backend absolute paths for downloads. */
  sources: string[]
  /** Destination directory: backend path for uploads, local path for downloads. */
  destDir: string
  conflictPolicy: ConflictPolicy
}

export interface TransferJob {
  id: string
  sessionId: string
  direction: TransferDirection
  label: string
  state: TransferJobState
  destDir: string
  bytesDone: number
  bytesTotal: number
  filesDone: number
  filesTotal: number
  currentFile: string | null
  startedAt: number
  finishedAt: number | null
  error?: AppErrorPayload
}

export type TransferStartResult =
  | { status: 'started'; job: TransferJob }
  | { status: 'conflicts'; conflicts: TransferConflict[] }
  | { status: 'invalid'; message: string }

export interface SessionStateEvent {
  type: 'session:state'
  sessionId: string
  status: SessionStatus
  title?: string
  error?: AppErrorPayload
}

export interface SessionDataEvent {
  type: 'session:data'
  sessionId: string
  data: string
}

export interface TransferUpdateEvent {
  type: 'transfer:update'
  job: TransferJob
}

export interface ToastEvent {
  type: 'toast'
  level: ToastLevel
  message: string
}

export type AppEvent = SessionStateEvent | SessionDataEvent | TransferUpdateEvent | ToastEvent

export interface FileListRequest {
  sessionId: string
  path: string
}

export interface FileMkdirRequest {
  sessionId: string
  parentPath: string
  name: string
}

export interface FileRenameRequest {
  sessionId: string
  path: string
  newName: string
}

export interface FileDeleteRequest {
  sessionId: string
  paths: string[]
}

export interface TransferCancelRequest {
  jobId: string
}

export interface DialogPickFolderRequest {
  startPath?: string
}
