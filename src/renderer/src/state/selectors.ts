import type { Settings } from '@shared/types'
import { useAppStore } from './appStore'
import { DEFAULT_SETTINGS } from './defaults'
import type { FileViewState, TabState } from './types'

export function useActiveTab(): TabState | null {
  return useAppStore((state) =>
    state.activeTabId ? (state.tabs.find((tab) => tab.id === state.activeTabId) ?? null) : null
  )
}

export function useActiveFileView(): FileViewState | null {
  return useAppStore((state) =>
    state.activeTabId ? (state.fileViews[state.activeTabId] ?? null) : null
  )
}

export function useSettings(): Settings {
  return useAppStore((state) => state.config?.settings ?? DEFAULT_SETTINGS)
}

export function useFontSize(): number {
  return useAppStore((state) => state.config?.settings.fontSize ?? DEFAULT_SETTINGS.fontSize)
}

export function useIsMac(): boolean {
  return useAppStore((state) => state.platform === 'darwin')
}

export function useTabById(sessionId: string | null): TabState | null {
  return useAppStore((state) =>
    sessionId ? (state.tabs.find((tab) => tab.id === sessionId) ?? null) : null
  )
}

export function getActiveTab(): TabState | null {
  const state = useAppStore.getState()
  return state.activeTabId ? (state.tabs.find((tab) => tab.id === state.activeTabId) ?? null) : null
}

export function getActiveFileView(): FileViewState | null {
  const state = useAppStore.getState()
  return state.activeTabId ? (state.fileViews[state.activeTabId] ?? null) : null
}

export function getSettings(): Settings {
  return useAppStore.getState().config?.settings ?? DEFAULT_SETTINGS
}
