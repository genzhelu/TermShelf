import type { StateCreator } from 'zustand'
import type {
  AppErrorPayload,
  AppEvent,
  DirListing,
  Platform,
  PublicConfig,
  SessionDescriptor,
  SessionKind,
  SessionStatus,
  Settings,
  SortDir,
  SortKey,
  SshProfileSummary,
  ToastLevel,
  TransferConflict,
  TransferJob,
  TransferRequest,
  TransferStartResult,
  UiState
} from '@shared/types'

export type UiPatch = Partial<
  Pick<UiState, 'sidebarWidth' | 'transferDrawerHeight' | 'sortKey' | 'sortDir'>
>

export type TerminalFollowMode = 'sync' | 'manual'

/** Runtime state for one open terminal tab. */
export interface TabState {
  id: string
  kind: SessionKind
  title: string
  status: SessionStatus
  pathStyle: 'posix' | 'win32'
  homePath: string | null
  /** Last CWD reported by the shell via OSC 7. */
  terminalCwd: string | null
  /** When false the file sidebar is in manual mode for this tab. */
  followCwd: boolean
  error: AppErrorPayload | null
  /** Non-null when the session connected without a usable SFTP subsystem. */
  filesUnavailable: string | null
}

export interface FileViewState {
  path: string | null
  listing: DirListing | null
  loading: boolean
  error: AppErrorPayload | null
  selected: string[]
  anchor: string | null
  history: string[]
  /** Monotonic counter used to discard out-of-order listings. */
  requestSeq: number
}

export interface ToastItem {
  id: string
  level: ToastLevel
  message: string
  ttl: number
  createdAt: number
}

export interface ConfirmDialogOptions {
  title: string
  message: string
  detail?: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  action: () => void | Promise<void>
}

export interface PromptDialogOptions {
  title: string
  label: string
  initialValue?: string
  placeholder?: string
  confirmLabel?: string
  hint?: string
  /** Selects the file extension instead of the basename when prefilled. */
  selectStem?: boolean
  validate?: (value: string) => string | null
  action: (value: string) => void
}

export interface SshDialogSeed {
  profile?: SshProfileSummary
  mode?: 'new' | 'edit'
}

export type DialogState =
  | { kind: 'ssh'; seed: SshDialogSeed }
  | { kind: 'settings' }
  | { kind: 'conflict'; request: TransferRequest; conflicts: TransferConflict[] }
  | { kind: 'confirm'; options: ConfirmDialogOptions }
  | { kind: 'prompt'; options: PromptDialogOptions }
  | null

export interface ConfigSlice {
  platform: Platform
  version: string
  config: PublicConfig | null
  configLoading: boolean
  configError: AppErrorPayload | null
  sidebarWidth: number
  sidebarVisible: boolean
  sortKey: SortKey
  sortDir: SortDir
  loadConfig: () => Promise<void>
  refreshConfig: () => Promise<void>
  saveSettings: (patch: Partial<Settings>, options?: { silent?: boolean }) => Promise<boolean>
  updateUi: (patch: UiPatch, options?: { persist?: boolean }) => void
  persistUi: () => void
  setSidebarWidth: (width: number) => void
  setSidebarVisible: (visible: boolean) => void
  toggleSidebar: () => void
  setSort: (key: SortKey, dir?: SortDir) => void
}

export interface SessionSlice {
  tabs: TabState[]
  activeTabId: string | null
  bootStatus: 'booting' | 'ready'
  localBootError: AppErrorPayload | null
  bootstrap: () => Promise<void>
  retryLocalSession: () => Promise<void>
  createLocalTab: (options?: { cwd?: string }) => Promise<string | null>
  addSessionTab: (descriptor: SessionDescriptor) => TabState
  selectTab: (sessionId: string) => void
  closeTab: (sessionId: string) => Promise<void>
  reconnectTab: (sessionId: string) => Promise<void>
  handleSessionState: (event: Extract<AppEvent, { type: 'session:state' }>) => void
  setTabTitle: (sessionId: string, title: string) => void
  handleTerminalCwd: (sessionId: string, path: string) => void
  setFollowCwd: (sessionId: string, follow: boolean) => void
  toggleFollowCwd: (sessionId: string) => void
  setTabFilesUnavailable: (sessionId: string, message: string | null) => void
  estimateTerminalSize: () => { cols: number; rows: number }
}

export interface FileSlice {
  fileViews: Record<string, FileViewState>
  ensureFileView: (sessionId: string) => FileViewState
  navigateTo: (
    sessionId: string,
    path: string,
    options?: { history?: boolean; silent?: boolean }
  ) => Promise<void>
  navigateBack: (sessionId: string) => Promise<void>
  navigateUp: (sessionId: string) => Promise<void>
  refreshFiles: (sessionId: string, options?: { silent?: boolean }) => Promise<void>
  selectOnly: (sessionId: string, path: string) => void
  toggleSelected: (sessionId: string, path: string, orderedPaths: string[]) => void
  selectRange: (sessionId: string, path: string, orderedPaths: string[]) => void
  selectAll: (sessionId: string, orderedPaths: string[]) => void
  clearSelection: (sessionId: string) => void
  copyPaths: (paths: string[] | string) => Promise<void>
  openEntry: (sessionId: string, path: string, isDirectory: boolean) => void
  promptNewFolder: (sessionId: string, parentPath: string) => void
  promptRename: (sessionId: string, path: string, currentName: string) => void
  promptDelete: (sessionId: string, paths: string[]) => void
  performMkdir: (sessionId: string, parentPath: string, name: string) => Promise<void>
  performRename: (sessionId: string, path: string, newName: string) => Promise<void>
  performDelete: (sessionId: string, paths: string[]) => Promise<void>
  uploadFiles: (sessionId: string, destDir?: string) => Promise<void>
  uploadFolder: (sessionId: string, destDir?: string) => Promise<void>
  uploadPaths: (
    sessionId: string,
    sources: string[],
    destDir: string
  ) => Promise<TransferStartResult | null>
  downloadSelection: (sessionId: string) => Promise<void>
  downloadPathsTo: (sessionId: string, paths: string[], destDir: string) => Promise<void>
  downloadToLastDir: (sessionId: string, paths: string[]) => Promise<void>
}

export type ConflictResolution = 'overwrite' | 'skip' | 'keepBoth' | 'cancel'

export interface TransferSlice {
  jobs: TransferJob[]
  drawerOpen: boolean
  drawerHeight: number
  loadTransfers: () => Promise<void>
  startTransfer: (request: TransferRequest) => Promise<TransferStartResult | null>
  resolveConflict: (policy: ConflictResolution) => Promise<void>
  cancelJob: (jobId: string) => Promise<void>
  cancelActiveJobs: () => Promise<void>
  clearCompleted: () => void
  setDrawerOpen: (open: boolean) => void
  toggleDrawer: () => void
  setDrawerHeight: (height: number) => void
  handleTransferUpdate: (job: TransferJob) => void
}

export interface UiSlice {
  toasts: ToastItem[]
  dialog: DialogState
  pushToast: (level: ToastLevel, message: string, options?: { ttl?: number }) => void
  dismissToast: (id: string) => void
  openDialog: (dialog: NonNullable<DialogState>) => void
  closeDialog: () => void
  showSshDialog: (seed?: SshDialogSeed) => void
  showSettingsDialog: () => void
  showConfirm: (options: ConfirmDialogOptions) => void
  showPrompt: (options: PromptDialogOptions) => void
}

export interface AppStore extends ConfigSlice, SessionSlice, FileSlice, TransferSlice, UiSlice {
  handleEvent: (event: AppEvent) => void
}

export type SliceCreator<T> = StateCreator<AppStore, [], [], T>
