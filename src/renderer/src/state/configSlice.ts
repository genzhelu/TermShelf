import type { PublicConfig, Settings } from '@shared/types'
import { errorMessage, getApi, safeCall } from '../lib/api'
import {
  DEFAULT_UI,
  SIDEBAR_PERSIST_DEBOUNCE_MS,
  clampDrawerHeight,
  clampSidebarWidth
} from './defaults'
import { SORT_DIRECTIONS } from './defaults'
import type { AppStore, ConfigSlice, SliceCreator, UiPatch } from './types'

function readBridge<T>(read: () => T, fallback: T): T {
  try {
    return read()
  } catch {
    return fallback
  }
}

export const createConfigSlice: SliceCreator<ConfigSlice> = (set, get) => {
  let pendingUi: UiPatch = {}
  let persistTimer: ReturnType<typeof setTimeout> | null = null

  const applyConfig = (config: PublicConfig): void => {
    set({
      config,
      configLoading: false,
      configError: null,
      platform: config.platform,
      version: config.version,
      sidebarWidth: clampSidebarWidth(config.ui.sidebarWidth),
      sortKey: config.ui.sortKey,
      sortDir: config.ui.sortDir,
      drawerHeight: clampDrawerHeight(config.ui.transferDrawerHeight)
    })
  }

  const flushUi = (): void => {
    if (persistTimer) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    const patch = pendingUi
    pendingUi = {}
    if (Object.keys(patch).length === 0) return
    void safeCall(() => getApi().config.update({ ui: patch })).then((result) => {
      if (!result.ok) {
        get().pushToast('warn', `Could not save layout: ${errorMessage(result.error)}`)
      }
    })
  }

  const queueUiPersist = (patch: UiPatch): void => {
    pendingUi = { ...pendingUi, ...patch }
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      persistTimer = null
      flushUi()
    }, SIDEBAR_PERSIST_DEBOUNCE_MS)
  }

  const applyFollowSetting = (followCwd: boolean): void => {
    set((state) => ({
      tabs: state.tabs.map((tab) => ({ ...tab, followCwd }))
    }))
    if (!followCwd) return
    const { activeTabId, tabs } = get()
    const active = tabs.find((tab) => tab.id === activeTabId)
    if (active?.terminalCwd) {
      void get().navigateTo(active.id, active.terminalCwd, { history: false })
    }
  }

  return {
    platform: readBridge(() => window.termshelf.platform, 'linux'),
    version: readBridge(() => window.termshelf.version, '0.1.0'),
    config: null,
    configLoading: true,
    configError: null,
    sidebarWidth: DEFAULT_UI.sidebarWidth,
    sidebarVisible: true,
    sortKey: DEFAULT_UI.sortKey,
    sortDir: DEFAULT_UI.sortDir,

    loadConfig: async (): Promise<void> => {
      set({ configLoading: true })
      const result = await safeCall(() => getApi().config.get())
      if (!result.ok) {
        set({ configLoading: false, configError: result.error })
        get().pushToast('warn', `Using default settings — ${errorMessage(result.error)}`)
        return
      }
      applyConfig(result.data)
    },

    refreshConfig: async (): Promise<void> => {
      const result = await safeCall(() => getApi().config.get())
      if (result.ok) applyConfig(result.data)
    },

    saveSettings: async (patch: Partial<Settings>, options): Promise<boolean> => {
      const result = await safeCall(() => getApi().config.update({ settings: patch }))
      if (!result.ok) {
        if (!options?.silent) {
          get().pushToast('error', `Could not save settings — ${errorMessage(result.error)}`)
        }
        return false
      }
      applyConfig(result.data)
      if (patch.followCwd !== undefined) applyFollowSetting(patch.followCwd)
      return true
    },

    updateUi: (patch: UiPatch, options): void => {
      const next: UiPatch = { ...patch }
      if (next.sidebarWidth !== undefined) next.sidebarWidth = clampSidebarWidth(next.sidebarWidth)
      if (next.transferDrawerHeight !== undefined) {
        next.transferDrawerHeight = clampDrawerHeight(next.transferDrawerHeight)
      }
      const statePatch: Partial<AppStore> = {}
      if (next.sidebarWidth !== undefined) statePatch.sidebarWidth = next.sidebarWidth
      if (next.sortKey !== undefined) statePatch.sortKey = next.sortKey
      if (next.sortDir !== undefined) statePatch.sortDir = next.sortDir
      if (next.transferDrawerHeight !== undefined)
        statePatch.drawerHeight = next.transferDrawerHeight
      set(statePatch)
      if (options?.persist === false) return
      queueUiPersist(next)
    },

    persistUi: (): void => {
      flushUi()
    },

    setSidebarWidth: (width: number): void => {
      const next = clampSidebarWidth(width)
      if (get().sidebarWidth === next) return
      set({ sidebarWidth: next })
      queueUiPersist({ sidebarWidth: next })
    },

    setSidebarVisible: (visible: boolean): void => {
      set({ sidebarVisible: visible })
    },

    toggleSidebar: (): void => {
      set((state) => ({ sidebarVisible: !state.sidebarVisible }))
    },

    setSort: (key, dir): void => {
      const currentKey = get().sortKey
      const currentDir = get().sortDir
      const nextDir =
        dir ?? (currentKey === key ? (currentDir === 'asc' ? 'desc' : 'asc') : SORT_DIRECTIONS[key])
      set({ sortKey: key, sortDir: nextDir })
      queueUiPersist({ sortKey: key, sortDir: nextDir })
    }
  }
}
