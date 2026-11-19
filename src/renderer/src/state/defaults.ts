import type { Settings, SortDir, SortKey, UiState } from '@shared/types'
import type { FileViewState } from './types'

export const DEFAULT_SETTINGS: Settings = {
  defaultDownloadDir: '',
  lastDownloadDir: '',
  followCwd: true,
  showHiddenFiles: false,
  fontSize: 13,
  shellPath: null,
  localTerminal: 'auto',
  wslDistro: null,
  confirmDelete: true
}

export const DEFAULT_UI: Pick<
  UiState,
  'sidebarWidth' | 'transferDrawerHeight' | 'sortKey' | 'sortDir'
> = {
  sidebarWidth: 320,
  transferDrawerHeight: 170,
  sortKey: 'name',
  sortDir: 'asc'
}

export const MIN_SIDEBAR_WIDTH = 240
export const MAX_SIDEBAR_WIDTH = 640
export const MIN_DRAWER_HEIGHT = 120
export const MAX_DRAWER_HEIGHT = 520
export const SIDEBAR_PERSIST_DEBOUNCE_MS = 400

export function clampSidebarWidth(width: number): number {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)))
}

export function clampDrawerHeight(height: number): number {
  return Math.min(MAX_DRAWER_HEIGHT, Math.max(MIN_DRAWER_HEIGHT, Math.round(height)))
}

export function clampFontSize(size: number): number {
  return Math.min(32, Math.max(8, Math.round(size)))
}

export function createFileView(): FileViewState {
  return {
    path: null,
    listing: null,
    loading: false,
    error: null,
    selected: [],
    anchor: null,
    history: [],
    requestSeq: 0
  }
}

export const SORT_DIRECTIONS: Record<SortKey, SortDir> = {
  name: 'asc',
  size: 'desc',
  mtime: 'desc'
}
