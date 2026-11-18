import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app, clipboard, dialog, ipcMain, shell } from 'electron'
import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import { z, type ZodType } from 'zod'
import { IPC } from '@shared/ipc-contract'
import { APP_VERSION } from '@shared/constants'
import type { AppEvent, HostKeyInfo, PublicConfig, TransferRequest } from '@shared/types'
import {
  clipboardWriteSchema,
  configPatchSchema,
  filesDeleteSchema,
  filesListSchema,
  filesMkdirSchema,
  filesRenameSchema,
  hostKeyForgetSchema,
  hostKeyInfoSchema,
  localSessionRequestSchema,
  openExternalSchema,
  pickFolderSchema,
  profileDeleteSchema,
  sessionIdSchema,
  showItemSchema,
  sshConnectRequestSchema,
  transferCancelSchema,
  transferRequestSchema
} from '@shared/schemas'
import { AppError, fail, ok } from './errors'
import type { SessionManager } from './sessions/manager'
import type { ConfigStore } from './store/types'
import type { TransferEngine } from './transfers/engine'
import type { Logger } from './util/logger'

export interface IpcContext {
  getWindow: () => BrowserWindow | null
  sessions: SessionManager
  transfers: TransferEngine
  store: ConfigStore
  logger: Logger
  emit: (event: AppEvent) => void
}

const sessionOnlySchema = z.object({ sessionId: sessionIdSchema })
const writeSchema = z.object({ sessionId: sessionIdSchema, data: z.string().max(2_000_000) })
const resizeSchema = z.object({
  sessionId: sessionIdSchema,
  cols: z.number().int().min(1).max(2000),
  rows: z.number().int().min(1).max(2000)
})

export function registerIpcHandlers(context: IpcContext): void {
  const { sessions, transfers, store, logger } = context

  const isTrusted = (event: IpcMainInvokeEvent | IpcMainEvent): boolean => {
    const window = context.getWindow()
    return Boolean(window && !window.isDestroyed() && event.sender === window.webContents)
  }

  const buildPublicConfig = (): PublicConfig => ({
    platform: process.platform as PublicConfig['platform'],
    version: APP_VERSION,
    encryptionAvailable: store.encryptionAvailable,
    settings: store.getSettings(),
    ui: store.getUi(),
    profiles: store.listProfiles(),
    knownHosts: store.listKnownHosts()
  })

  function handle<T>(
    channel: string,
    schema: ZodType<T> | null,
    handler: (payload: T, event: IpcMainInvokeEvent) => Promise<unknown> | unknown
  ): void {
    ipcMain.handle(channel, async (event, raw: unknown) => {
      if (!isTrusted(event)) {
        return fail(new AppError('INVALID_ARGUMENT', 'Untrusted IPC sender'))
      }
      let payload = raw as T
      if (schema) {
        const parsed = schema.safeParse(raw)
        if (!parsed.success) {
          return fail(
            new AppError('INVALID_ARGUMENT', 'Invalid request payload', {
              issues: parsed.error.issues.slice(0, 8)
            })
          )
        }
        payload = parsed.data
      }
      try {
        return ok(await handler(payload, event))
      } catch (error) {
        logger.error(`IPC ${channel} failed`, error)
        return fail(error)
      }
    })
  }

  handle(IPC.sessionCreateLocal, localSessionRequestSchema, async (payload) =>
    sessions.createLocal(payload)
  )

  handle(IPC.sessionCreateSsh, sshConnectRequestSchema, async (payload) =>
    sessions.createSsh(payload)
  )

  handle(IPC.sessionClose, sessionOnlySchema, async (payload) => {
    await transfers.cancelForSession(payload.sessionId)
    await sessions.close(payload.sessionId)
    return null
  })

  handle(IPC.sessionReconnect, sessionOnlySchema, async (payload) =>
    sessions.reconnect(payload.sessionId)
  )

  handle(IPC.filesList, filesListSchema, async (payload) =>
    sessions.getBackend(payload.sessionId).list(payload.path)
  )

  handle(IPC.filesMkdir, filesMkdirSchema, async (payload) => {
    await sessions.getBackend(payload.sessionId).mkdir(payload.parentPath, payload.name)
    return null
  })

  handle(IPC.filesRename, filesRenameSchema, async (payload) => {
    await sessions.getBackend(payload.sessionId).rename(payload.path, payload.newName)
    return null
  })

  handle(IPC.filesDelete, filesDeleteSchema, async (payload) => {
    await sessions.getBackend(payload.sessionId).remove(payload.paths, true)
    return null
  })

  handle(IPC.transfersStart, transferRequestSchema, async (payload) =>
    transfers.start(payload as TransferRequest)
  )

  handle(IPC.transfersCancel, transferCancelSchema, async (payload) => {
    await transfers.cancel(payload.jobId)
    return null
  })

  handle(IPC.transfersList, null, async () => transfers.list())

  handle(IPC.sshTrustHostKey, hostKeyInfoSchema, async (payload) => {
    store.trustHostKey(payload as HostKeyInfo)
    await store.flush()
    return null
  })

  handle(IPC.sshForgetHostKey, hostKeyForgetSchema, async (payload) => {
    store.forgetHostKey(payload.host, payload.port)
    await store.flush()
    return null
  })

  handle(IPC.profilesList, null, async () => store.listProfiles())

  handle(IPC.profilesDelete, profileDeleteSchema, async (payload) => {
    store.deleteProfile(payload.profileId)
    await store.flush()
    return null
  })

  handle(IPC.configGet, null, async () => buildPublicConfig())

  handle(IPC.configUpdate, configPatchSchema, async (payload) => {
    if (payload.settings) store.updateSettings(payload.settings)
    if (payload.ui) store.updateUi(payload.ui)
    void store.flush()
    return buildPublicConfig()
  })

  handle(IPC.dialogPickFolder, pickFolderSchema ?? null, async (payload) => {
    const window = context.getWindow()
    if (!window) return null
    const startPath = payload?.startPath ?? store.getSettings().lastDownloadDir
    const result = await dialog.showOpenDialog(window, {
      title: 'Choose download folder',
      defaultPath: startPath || appDownloadsPath(),
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const selected = result.filePaths[0]!
    store.updateSettings({ lastDownloadDir: selected })
    void store.flush()
    return selected
  })

  handle(IPC.dialogPickFiles, null, async () => {
    const window = context.getWindow()
    if (!window) return []
    const result = await dialog.showOpenDialog(window, {
      title: 'Choose files to transfer',
      properties: ['openFile', 'multiSelections']
    })
    return result.canceled ? [] : result.filePaths
  })

  handle(IPC.dialogPickFolderToUpload, null, async () => {
    const window = context.getWindow()
    if (!window) return null
    const result = await dialog.showOpenDialog(window, {
      title: 'Choose folder to transfer',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0] ?? null
  })

  handle(IPC.dialogPickKey, null, async () => {
    const window = context.getWindow()
    if (!window) return null
    const sshDirectory = path.join(os.homedir(), '.ssh')
    let defaultPath: string | undefined
    try {
      if (fs.existsSync(sshDirectory)) defaultPath = sshDirectory
    } catch {
      defaultPath = undefined
    }
    const result = await dialog.showOpenDialog(window, {
      title: 'Choose SSH private key',
      ...(defaultPath ? { defaultPath } : {}),
      properties: ['openFile', 'showHiddenFiles']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0] ?? null
  })

  handle(IPC.appOpenExternal, openExternalSchema, async (payload) => {
    let url: URL
    try {
      url = new URL(payload.url)
    } catch {
      throw new AppError('INVALID_ARGUMENT', 'Invalid URL')
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new AppError('INVALID_ARGUMENT', 'Only http(s) links can be opened')
    }
    await shell.openExternal(url.toString())
    return null
  })

  handle(IPC.appShowItemInFolder, showItemSchema, async (payload) => {
    try {
      const stat = await fs.promises.stat(payload.path)
      if (stat.isDirectory()) await shell.openPath(payload.path)
      else shell.showItemInFolder(payload.path)
    } catch {
      await shell.openPath(path.dirname(payload.path))
    }
    return null
  })

  handle(IPC.appOpenLogs, null, async () => {
    await shell.openPath(logger.directory)
    return null
  })

  handle(IPC.clipboardRead, null, async () => clipboard.readText())

  handle(IPC.clipboardWrite, clipboardWriteSchema, async (payload) => {
    clipboard.writeText(payload.text)
    return null
  })

  ipcMain.on(IPC.sessionWrite, (event, raw: unknown) => {
    if (!isTrusted(event)) return
    const parsed = writeSchema.safeParse(raw)
    if (!parsed.success) return
    sessions.write(parsed.data.sessionId, parsed.data.data)
  })

  ipcMain.on(IPC.sessionResize, (event, raw: unknown) => {
    if (!isTrusted(event)) return
    const parsed = resizeSchema.safeParse(raw)
    if (!parsed.success) return
    sessions.resize(parsed.data.sessionId, parsed.data.cols, parsed.data.rows)
  })
}

function appDownloadsPath(): string {
  try {
    return app.getPath('downloads')
  } catch {
    return os.homedir()
  }
}
