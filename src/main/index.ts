import path from 'node:path'
import { app, BrowserWindow, Menu, nativeTheme, safeStorage, screen, shell } from 'electron'
import { APP_NAME, APP_VERSION } from '@shared/constants'
import type { AppEvent, WindowBounds } from '@shared/types'
import { IPC } from '@shared/ipc-contract'
import { Logger } from './util/logger'
import { createConfigStore } from './store/config-store'
import { SessionManager } from './sessions/manager'
import { TransferEngine } from './transfers/engine'
import { registerIpcHandlers } from './ipc'

let mainWindow: BrowserWindow | null = null
let logger: Logger
let store: Awaited<ReturnType<typeof createConfigStore>> | null = null
let sessions: SessionManager | null = null
let transfers: TransferEngine | null = null
let boundsTimer: NodeJS.Timeout | null = null

function emitEvent(event: AppEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC.event, event)
  }
}

function safeWindowBounds(bounds: WindowBounds | null): WindowBounds | null {
  if (!bounds) return null
  if (!Number.isFinite(bounds.x) || !Number.isFinite(bounds.y)) return null
  if (bounds.width < 900 || bounds.height < 560) return null
  const displays = screen.getAllDisplays()
  const visible = displays.some((display) => {
    const area = display.workArea
    return (
      bounds.x < area.x + area.width &&
      bounds.x + bounds.width > area.x &&
      bounds.y < area.y + area.height &&
      bounds.y + bounds.height > area.y
    )
  })
  return visible ? bounds : null
}

function createWindow(): BrowserWindow {
  const storedBounds = store ? safeWindowBounds(store.getUi().windowBounds) : null
  const window = new BrowserWindow({
    width: storedBounds?.width ?? 1280,
    height: storedBounds?.height ?? 800,
    ...(storedBounds ? { x: storedBounds.x, y: storedBounds.y } : {}),
    minWidth: 900,
    minHeight: 560,
    title: APP_NAME,
    backgroundColor: '#0f1115',
    show: false,
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      webSecurity: true
    }
  })

  window.once('ready-to-show', () => {
    window.show()
  })

  const persistBounds = (): void => {
    if (!store || window.isDestroyed() || window.isMinimized() || window.isFullScreen()) return
    if (boundsTimer) clearTimeout(boundsTimer)
    boundsTimer = setTimeout(() => {
      boundsTimer = null
      if (!store || window.isDestroyed()) return
      const bounds = window.getBounds()
      store.setWindowBounds(bounds)
      void store.flush()
    }, 600)
  }

  window.on('resize', persistBounds)
  window.on('move', persistBounds)

  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event) => {
    event.preventDefault()
  })

  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (rendererUrl) {
    void window.loadURL(rendererUrl)
  } else {
    void window.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  return window
}

function buildApplicationMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: APP_NAME,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const }
            ]
          }
        ]
      : []),
    {
      label: 'File',
      submenu: [...(isMac ? [] : [{ role: 'quit' as const }]), { role: 'close' as const }]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' as const },
        { role: 'redo' as const },
        { type: 'separator' as const },
        { role: 'cut' as const },
        { role: 'copy' as const },
        { role: 'paste' as const },
        { role: 'selectAll' as const }
      ]
    },
    {
      label: 'View',
      submenu: [
        ...(app.isPackaged
          ? []
          : [{ role: 'toggleDevTools' as const }, { type: 'separator' as const }]),
        { role: 'resetZoom' as const },
        { role: 'zoomIn' as const },
        { role: 'zoomOut' as const },
        { type: 'separator' as const },
        { role: 'togglefullscreen' as const }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Open Logs Folder',
          click: (): void => {
            if (logger) void shell.openPath(logger.directory)
          }
        },
        {
          label: `About ${APP_NAME}`,
          click: (): void => {
            app.showAboutPanel()
          }
        }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

async function bootstrap(): Promise<void> {
  // Isolate e2e/dev runs from the real profile when requested.
  const overrideUserData = process.env.TERMSHELF_USER_DATA_DIR
  if (overrideUserData) {
    app.setPath('userData', path.resolve(overrideUserData))
  }
  app.setName(APP_NAME)
  if (process.platform === 'win32') app.setAppUserModelId('com.termshelf.app')
  nativeTheme.themeSource = 'dark'

  const userData = app.getPath('userData')
  const logsDirectory = path.join(userData, 'logs')
  logger = new Logger(logsDirectory)
  const runtimeRoot = path.join(userData, 'runtime')

  store = await createConfigStore({
    filePath: path.join(userData, 'config.json'),
    defaultDownloadDir: app.getPath('downloads'),
    safeStorage: {
      isEncryptionAvailable: () => {
        try {
          return safeStorage.isEncryptionAvailable()
        } catch {
          return false
        }
      },
      encryptString: (value: string) => safeStorage.encryptString(value),
      decryptString: (value: Buffer) => safeStorage.decryptString(value)
    }
  })

  sessions = new SessionManager(store, emitEvent, runtimeRoot)
  transfers = new TransferEngine({
    getBackend: (sessionId) => sessions!.getBackend(sessionId),
    emit: emitEvent
  })

  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: APP_VERSION,
    copyright: 'Copyright © 2026 TermShelf'
  })

  const window = createWindow()
  mainWindow = window

  registerIpcHandlers({
    getWindow: () => mainWindow,
    sessions,
    transfers,
    store,
    logger,
    emit: emitEvent
  })

  buildApplicationMenu()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow()
    }
  })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => {
      event.preventDefault()
    })
  })

  app.on('window-all-closed', () => {
    app.quit()
  })

  let shuttingDown = false
  app.on('before-quit', (event) => {
    if (shuttingDown) return
    event.preventDefault()
    shuttingDown = true
    if (boundsTimer) {
      clearTimeout(boundsTimer)
      boundsTimer = null
    }
    void (async () => {
      try {
        await store?.flush()
        await sessions?.disposeAll()
      } catch (error) {
        logger?.error('Shutdown cleanup failed', error)
      } finally {
        app.quit()
      }
    })()
  })

  process.on('uncaughtException', (error) => {
    logger?.error('uncaughtException', error)
  })
  process.on('unhandledRejection', (reason) => {
    logger?.error('unhandledRejection', reason)
  })

  app
    .whenReady()
    .then(bootstrap)
    .catch((error) => {
      logger?.error('Failed to start TermShelf', error)
      app.quit()
    })
}
