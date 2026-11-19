import type { LocalSessionRequest, SessionDescriptor } from '@shared/types'
import { errorMessage, getApi, safeCall } from '../lib/api'
import { sanitizeTitle } from '../lib/format'
import { pathsEqual } from '../lib/paths'
import { forgetSessionData } from '../lib/terminalBus'
import { DEFAULT_SETTINGS } from './defaults'
import type { SessionSlice, SliceCreator, TabState } from './types'

let bootstrapInFlight = false

function makeTab(descriptor: SessionDescriptor, followCwd: boolean): TabState {
  return {
    id: descriptor.id,
    kind: descriptor.kind,
    environment: descriptor.environment,
    title:
      sanitizeTitle(descriptor.title) || (descriptor.kind === 'local' ? 'Local terminal' : 'SSH'),
    status: descriptor.status,
    pathStyle: descriptor.pathStyle,
    homePath: descriptor.homePath,
    terminalCwd: null,
    followCwd,
    error: null,
    filesUnavailable: null
  }
}

export const createSessionSlice: SliceCreator<SessionSlice> = (set, get) => {
  const syncActiveTabToTerminal = (): void => {
    const settings = get().config?.settings ?? DEFAULT_SETTINGS
    const active = get().tabs.find((tab) => tab.id === get().activeTabId)
    if (!active || !settings.followCwd || !active.followCwd || !active.terminalCwd) return
    const view = get().fileViews[active.id]
    if (pathsEqual(active.pathStyle, view?.path ?? null, active.terminalCwd)) return
    void get().navigateTo(active.id, active.terminalCwd, { history: false })
  }

  return {
    tabs: [],
    activeTabId: null,
    bootStatus: 'booting',
    localBootError: null,

    bootstrap: async (): Promise<void> => {
      if (bootstrapInFlight) return
      bootstrapInFlight = true
      try {
        await get().loadConfig()
        void get().loadTransfers()
        await get().createLocalTab()
      } finally {
        bootstrapInFlight = false
        set({ bootStatus: 'ready' })
      }
    },

    retryLocalSession: async (): Promise<void> => {
      set({ localBootError: null })
      await get().createLocalTab()
    },

    estimateTerminalSize: () => {
      const { sidebarWidth, sidebarVisible, drawerOpen, drawerHeight } = get()
      const fontSize = get().config?.settings.fontSize ?? DEFAULT_SETTINGS.fontSize
      const viewportWidth = typeof window === 'undefined' ? 1280 : window.innerWidth
      const viewportHeight = typeof window === 'undefined' ? 800 : window.innerHeight
      const availableWidth = viewportWidth - (sidebarVisible ? sidebarWidth : 0) - 48
      const availableHeight = viewportHeight - 38 - (drawerOpen ? drawerHeight : 32) - 28
      const cols = Math.floor(availableWidth / (fontSize * 0.62))
      const rows = Math.floor(availableHeight / (fontSize * 1.22))
      return {
        cols: Math.max(40, Math.min(400, cols)),
        rows: Math.max(10, Math.min(200, rows))
      }
    },

    createLocalTab: async (options): Promise<string | null> => {
      const { cols, rows } = get().estimateTerminalSize()
      const settings = get().config?.settings ?? DEFAULT_SETTINGS
      const request: LocalSessionRequest = {
        cols,
        rows,
        terminal: settings.localTerminal,
        wslDistro: settings.wslDistro
      }
      const shellPath = settings.shellPath?.trim()
      if (shellPath) request.shellPath = shellPath
      if (options?.cwd) request.cwd = options.cwd

      const result = await safeCall(() => getApi().sessions.createLocal(request))
      if (!result.ok) {
        const wasFirstTab = get().tabs.length === 0
        if (wasFirstTab) set({ localBootError: result.error })
        if (!wasFirstTab) {
          get().pushToast('error', `Could not start terminal — ${errorMessage(result.error)}`)
        }
        return null
      }

      set({ localBootError: null })
      const descriptor = result.data
      const tab = get().addSessionTab(descriptor)
      return tab.id
    },

    addSessionTab: (descriptor: SessionDescriptor): TabState => {
      const settings = get().config?.settings ?? DEFAULT_SETTINGS
      const tab = makeTab(descriptor, settings.followCwd)
      set((state) => ({
        tabs: [...state.tabs, tab],
        activeTabId: tab.id
      }))
      get().ensureFileView(tab.id)
      if (descriptor.homePath) {
        void get().navigateTo(tab.id, descriptor.homePath)
      } else {
        set((state) => ({
          fileViews: {
            ...state.fileViews,
            [tab.id]: {
              ...state.fileViews[tab.id]!,
              error: {
                code: 'UNKNOWN',
                message: 'The session did not report a home directory.'
              }
            }
          }
        }))
      }
      syncActiveTabToTerminal()
      return tab
    },

    selectTab: (sessionId: string): void => {
      const tab = get().tabs.find((candidate) => candidate.id === sessionId)
      if (!tab) return
      if (get().activeTabId === sessionId) return
      set({ activeTabId: sessionId })
      syncActiveTabToTerminal()
      const view = get().fileViews[sessionId]
      if (
        !view?.path &&
        !view?.loading &&
        !view?.error &&
        tab.status === 'connected' &&
        tab.homePath
      ) {
        void get().navigateTo(sessionId, tab.homePath)
      }
    },

    closeTab: async (sessionId: string): Promise<void> => {
      const tabs = get().tabs
      const tab = tabs.find((candidate) => candidate.id === sessionId)
      if (!tab) return
      const remaining = tabs.filter((candidate) => candidate.id !== sessionId)
      const activeTabId = get().activeTabId
      const nextActiveId =
        activeTabId === sessionId
          ? remaining.length > 0
            ? remaining[remaining.length - 1]!.id
            : null
          : activeTabId

      set((state) => {
        const fileViews = { ...state.fileViews }
        delete fileViews[sessionId]
        return {
          tabs: remaining,
          activeTabId: nextActiveId,
          fileViews
        }
      })
      forgetSessionData(sessionId)

      const result = await safeCall(() => getApi().sessions.close(sessionId))
      if (!result.ok) {
        get().pushToast('warn', `Session may still be running — ${errorMessage(result.error)}`)
      }
      syncActiveTabToTerminal()
    },

    reconnectTab: async (sessionId: string): Promise<void> => {
      const tab = get().tabs.find((candidate) => candidate.id === sessionId)
      if (!tab) return
      if (tab.status === 'connecting') return
      const previousStatus = tab.status
      set((state) => ({
        tabs: state.tabs.map((candidate) =>
          candidate.id === sessionId
            ? { ...candidate, status: 'connecting', error: null }
            : candidate
        )
      }))
      const result = await safeCall(() => getApi().sessions.reconnect(sessionId))
      if (!result.ok) {
        set((state) => ({
          tabs: state.tabs.map((candidate) =>
            candidate.id === sessionId
              ? {
                  ...candidate,
                  status: previousStatus === 'ended' ? 'ended' : 'disconnected',
                  error: result.error
                }
              : candidate
          )
        }))
        get().pushToast('error', `Reconnect failed — ${errorMessage(result.error)}`)
        return
      }
      const descriptor = result.data
      set((state) => ({
        tabs: state.tabs.map((candidate) =>
          candidate.id === sessionId
            ? {
                ...candidate,
                status: descriptor.status,
                title: sanitizeTitle(descriptor.title) || candidate.title,
                error: null,
                filesUnavailable: null
              }
            : candidate
        )
      }))
      get().pushToast('success', `Reconnected to ${tab.title}`)
      await get().refreshFiles(sessionId)
    },

    handleSessionState: (event): void => {
      const tab = get().tabs.find((candidate) => candidate.id === event.sessionId)
      if (!tab) return
      const nextTitle = event.title ? sanitizeTitle(event.title) : ''
      set((state) => ({
        tabs: state.tabs.map((candidate) => {
          if (candidate.id !== event.sessionId) return candidate
          const updated: TabState = {
            ...candidate,
            status: event.status,
            error: event.status === 'connected' ? null : (event.error ?? candidate.error)
          }
          if (nextTitle) updated.title = nextTitle
          if (event.status === 'connected') updated.filesUnavailable = null
          return updated
        })
      }))
      if (event.status === 'error' && event.error) {
        get().pushToast('error', `${tab.title}: ${errorMessage(event.error)}`)
      }
      if (event.status === 'disconnected' && tab.kind === 'ssh') {
        get().pushToast('warn', `Connection to ${tab.title} was lost`)
      }
      if (event.status === 'connected' && get().fileViews[event.sessionId]?.path) {
        void get().refreshFiles(event.sessionId, { silent: true })
      }
      if (event.status === 'connected') syncActiveTabToTerminal()
    },

    setTabTitle: (sessionId: string, title: string): void => {
      const clean = sanitizeTitle(title)
      if (!clean) return
      const tab = get().tabs.find((candidate) => candidate.id === sessionId)
      if (!tab || tab.title === clean) return
      set((state) => ({
        tabs: state.tabs.map((candidate) =>
          candidate.id === sessionId ? { ...candidate, title: clean } : candidate
        )
      }))
    },

    handleTerminalCwd: (sessionId: string, path: string): void => {
      const tab = get().tabs.find((candidate) => candidate.id === sessionId)
      if (!tab) return
      if (!pathsEqual(tab.pathStyle, tab.terminalCwd, path)) {
        set((state) => ({
          tabs: state.tabs.map((candidate) =>
            candidate.id === sessionId ? { ...candidate, terminalCwd: path } : candidate
          )
        }))
      }
      const settings = get().config?.settings ?? DEFAULT_SETTINGS
      if (!tab.followCwd || !settings.followCwd) return
      if (get().activeTabId !== sessionId) return
      const view = get().fileViews[sessionId]
      if (pathsEqual(tab.pathStyle, view?.path ?? null, path)) return
      void get().navigateTo(sessionId, path, { history: false })
    },

    setFollowCwd: (sessionId: string, follow: boolean): void => {
      set((state) => ({
        tabs: state.tabs.map((candidate) =>
          candidate.id === sessionId ? { ...candidate, followCwd: follow } : candidate
        )
      }))
      if (follow) {
        const tab = get().tabs.find((candidate) => candidate.id === sessionId)
        const settings = get().config?.settings ?? DEFAULT_SETTINGS
        if (!settings.followCwd) {
          void get().saveSettings({ followCwd: true }, { silent: true })
        }
        if (tab && get().activeTabId === sessionId && tab.terminalCwd) {
          const view = get().fileViews[sessionId]
          if (!pathsEqual(tab.pathStyle, view?.path ?? null, tab.terminalCwd)) {
            void get().navigateTo(sessionId, tab.terminalCwd, { history: false })
          }
        }
      }
    },

    toggleFollowCwd: (sessionId: string): void => {
      const tab = get().tabs.find((candidate) => candidate.id === sessionId)
      if (!tab) return
      const settings = get().config?.settings ?? DEFAULT_SETTINGS
      if (!settings.followCwd) {
        void get().saveSettings({ followCwd: true }, { silent: true })
        set((state) => ({
          tabs: state.tabs.map((candidate) =>
            candidate.id === sessionId ? { ...candidate, followCwd: true } : candidate
          )
        }))
        get().pushToast('info', 'File browser now follows the terminal folder')
        return
      }
      const follow = !tab.followCwd
      get().setFollowCwd(sessionId, follow)
      get().pushToast(
        'info',
        follow ? 'File browser follows the terminal folder' : 'File browser is in manual mode'
      )
    },

    setTabFilesUnavailable: (sessionId: string, message: string | null): void => {
      set((state) => ({
        tabs: state.tabs.map((candidate) =>
          candidate.id === sessionId ? { ...candidate, filesUnavailable: message } : candidate
        )
      }))
    }
  }
}
