import type {
  AppEvent,
  ConfigPatch,
  DialogPickFolderRequest,
  DirListing,
  FileDeleteRequest,
  FileListRequest,
  FileMkdirRequest,
  FileRenameRequest,
  HostKeyInfo,
  IpcResult,
  LocalSessionRequest,
  Platform,
  PublicConfig,
  SessionDescriptor,
  SshConnectRequest,
  SshProfileSummary,
  TransferCancelRequest,
  TransferJob,
  TransferRequest,
  TransferStartResult,
  WslInfo,
  X11Info
} from './types'

export const IPC = {
  sessionCreateLocal: 'session:create-local',
  sessionCreateSsh: 'session:create-ssh',
  sessionWrite: 'session:write',
  sessionResize: 'session:resize',
  sessionClose: 'session:close',
  sessionReconnect: 'session:reconnect',
  filesList: 'files:list',
  filesMkdir: 'files:mkdir',
  filesRename: 'files:rename',
  filesDelete: 'files:delete',
  transfersStart: 'transfers:start',
  transfersCancel: 'transfers:cancel',
  transfersList: 'transfers:list',
  sshTrustHostKey: 'ssh:trust-host-key',
  sshForgetHostKey: 'ssh:forget-host-key',
  profilesList: 'profiles:list',
  profilesDelete: 'profiles:delete',
  configGet: 'config:get',
  configUpdate: 'config:update',
  dialogPickFolder: 'dialog:pick-folder',
  dialogPickFiles: 'dialog:pick-files',
  dialogPickFolderToUpload: 'dialog:pick-folder-to-upload',
  dialogPickKey: 'dialog:pick-key',
  appOpenExternal: 'app:open-external',
  appShowItemInFolder: 'app:show-item-in-folder',
  appOpenLogs: 'app:open-logs',
  clipboardRead: 'clipboard:read-text',
  clipboardWrite: 'clipboard:write-text',
  wslInfo: 'wsl:info',
  x11Info: 'x11:info',
  event: 'app:event'
} as const

export interface TermshelfApi {
  readonly platform: Platform
  readonly version: string
  /** Electron webUtils path resolution; must be called from the preload context. */
  getPathForFile(file: File): string
  onEvent(callback: (event: AppEvent) => void): () => void
  sessions: {
    createLocal(request: LocalSessionRequest): Promise<IpcResult<SessionDescriptor>>
    createSsh(request: SshConnectRequest): Promise<IpcResult<SessionDescriptor>>
    write(sessionId: string, data: string): void
    resize(sessionId: string, cols: number, rows: number): void
    close(sessionId: string): Promise<IpcResult<null>>
    reconnect(sessionId: string): Promise<IpcResult<SessionDescriptor>>
  }
  files: {
    list(request: FileListRequest): Promise<IpcResult<DirListing>>
    mkdir(request: FileMkdirRequest): Promise<IpcResult<null>>
    rename(request: FileRenameRequest): Promise<IpcResult<null>>
    delete(request: FileDeleteRequest): Promise<IpcResult<null>>
  }
  transfers: {
    start(request: TransferRequest): Promise<IpcResult<TransferStartResult>>
    cancel(request: TransferCancelRequest): Promise<IpcResult<null>>
    list(): Promise<IpcResult<TransferJob[]>>
  }
  ssh: {
    trustHostKey(record: HostKeyInfo): Promise<IpcResult<null>>
    forgetHostKey(host: string, port: number): Promise<IpcResult<null>>
  }
  profiles: {
    list(): Promise<IpcResult<SshProfileSummary[]>>
    delete(profileId: string): Promise<IpcResult<null>>
  }
  config: {
    get(): Promise<IpcResult<PublicConfig>>
    update(patch: ConfigPatch): Promise<IpcResult<PublicConfig>>
  }
  dialogs: {
    pickFolder(request?: DialogPickFolderRequest): Promise<IpcResult<string | null>>
    pickFiles(): Promise<IpcResult<string[]>>
    pickFolderToUpload(): Promise<IpcResult<string | null>>
    pickKey(): Promise<IpcResult<string | null>>
  }
  app: {
    openExternal(url: string): Promise<IpcResult<null>>
    showItemInFolder(path: string): Promise<IpcResult<null>>
    openLogs(): Promise<IpcResult<null>>
  }
  clipboard: {
    readText(): Promise<IpcResult<string>>
    writeText(text: string): Promise<IpcResult<null>>
  }
  wsl: {
    info(): Promise<IpcResult<WslInfo>>
  }
  x11: {
    info(): Promise<IpcResult<X11Info>>
  }
}
