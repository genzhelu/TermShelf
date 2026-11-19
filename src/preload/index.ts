import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC, type TermshelfApi } from '@shared/ipc-contract'
import type { AppEvent, Platform } from '@shared/types'
import { APP_VERSION } from '@shared/constants'

const api: TermshelfApi = {
  platform: process.platform as Platform,
  version: APP_VERSION,
  getPathForFile(file: File): string {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
  onEvent(callback: (event: AppEvent) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, payload: AppEvent): void => {
      callback(payload)
    }
    ipcRenderer.on(IPC.event, listener)
    return () => {
      ipcRenderer.removeListener(IPC.event, listener)
    }
  },
  sessions: {
    createLocal: (request) => ipcRenderer.invoke(IPC.sessionCreateLocal, request),
    createSsh: (request) => ipcRenderer.invoke(IPC.sessionCreateSsh, request),
    write: (sessionId, data) => ipcRenderer.send(IPC.sessionWrite, { sessionId, data }),
    resize: (sessionId, cols, rows) =>
      ipcRenderer.send(IPC.sessionResize, { sessionId, cols, rows }),
    close: (sessionId) => ipcRenderer.invoke(IPC.sessionClose, { sessionId }),
    reconnect: (sessionId) => ipcRenderer.invoke(IPC.sessionReconnect, { sessionId })
  },
  files: {
    list: (request) => ipcRenderer.invoke(IPC.filesList, request),
    mkdir: (request) => ipcRenderer.invoke(IPC.filesMkdir, request),
    rename: (request) => ipcRenderer.invoke(IPC.filesRename, request),
    delete: (request) => ipcRenderer.invoke(IPC.filesDelete, request)
  },
  transfers: {
    start: (request) => ipcRenderer.invoke(IPC.transfersStart, request),
    cancel: (request) => ipcRenderer.invoke(IPC.transfersCancel, request),
    list: () => ipcRenderer.invoke(IPC.transfersList)
  },
  ssh: {
    trustHostKey: (record) => ipcRenderer.invoke(IPC.sshTrustHostKey, record),
    forgetHostKey: (host, port) => ipcRenderer.invoke(IPC.sshForgetHostKey, { host, port })
  },
  profiles: {
    list: () => ipcRenderer.invoke(IPC.profilesList),
    delete: (profileId) => ipcRenderer.invoke(IPC.profilesDelete, { profileId })
  },
  config: {
    get: () => ipcRenderer.invoke(IPC.configGet),
    update: (patch) => ipcRenderer.invoke(IPC.configUpdate, patch)
  },
  dialogs: {
    pickFolder: (request) => ipcRenderer.invoke(IPC.dialogPickFolder, request ?? {}),
    pickFiles: () => ipcRenderer.invoke(IPC.dialogPickFiles),
    pickFolderToUpload: () => ipcRenderer.invoke(IPC.dialogPickFolderToUpload),
    pickKey: () => ipcRenderer.invoke(IPC.dialogPickKey)
  },
  app: {
    openExternal: (url) => ipcRenderer.invoke(IPC.appOpenExternal, { url }),
    showItemInFolder: (path) => ipcRenderer.invoke(IPC.appShowItemInFolder, { path }),
    openLogs: () => ipcRenderer.invoke(IPC.appOpenLogs)
  },
  clipboard: {
    readText: () => ipcRenderer.invoke(IPC.clipboardRead),
    writeText: (text) => ipcRenderer.invoke(IPC.clipboardWrite, { text })
  },
  wsl: {
    info: () => ipcRenderer.invoke(IPC.wslInfo)
  }
}

contextBridge.exposeInMainWorld('termshelf', api)
