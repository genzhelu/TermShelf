import type { TransferStartResult } from '@shared/types'
import { errorMessage, getApi, safeCall } from '../lib/api'
import { truncateMiddle } from '../lib/format'
import { pathsEqual, parentPathFor } from '../lib/paths'
import { DEFAULT_SETTINGS, createFileView } from './defaults'
import type { FileSlice, FileViewState, SliceCreator, TabState } from './types'

export function validateEntryName(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return 'Name cannot be empty'
  if (/[\\/]/.test(trimmed)) return 'Name cannot contain path separators'
  if (trimmed === '.' || trimmed === '..') return 'That name is reserved'
  if (trimmed.length > 255) return 'Name is too long'
  return null
}

function selectedList(view: FileViewState | undefined): string[] {
  return view?.selected ?? []
}

export const createFileSlice: SliceCreator<FileSlice> = (set, get) => {
  const requireConnectedTab = (sessionId: string): TabState | null => {
    const tab = get().tabs.find((candidate) => candidate.id === sessionId)
    if (!tab) return null
    if (tab.filesUnavailable) {
      get().pushToast('error', tab.filesUnavailable)
      return null
    }
    if (tab.status !== 'connected') {
      get().pushToast('warn', 'The session is not connected. Reconnect to browse files.')
      return null
    }
    return tab
  }

  const setView = (sessionId: string, patch: Partial<FileViewState>): void => {
    set((state) => {
      const current = state.fileViews[sessionId] ?? createFileView()
      return { fileViews: { ...state.fileViews, [sessionId]: { ...current, ...patch } } }
    })
  }

  const ensureFileView = (sessionId: string): FileViewState => {
    const existing = get().fileViews[sessionId]
    if (existing) return existing
    const created = createFileView()
    set((state) => ({ fileViews: { ...state.fileViews, [sessionId]: created } }))
    return created
  }

  const refreshAfterMutation = (sessionId: string): void => {
    void get().refreshFiles(sessionId, { silent: true })
  }

  return {
    fileViews: {},
    ensureFileView,

    navigateTo: async (sessionId, path, options = {}): Promise<void> => {
      const tab = get().tabs.find((candidate) => candidate.id === sessionId)
      const target = path.trim()
      if (!tab || !target) return
      const view = get().fileViews[sessionId] ?? createFileView()
      const previousPath = view.path
      const previousListing = view.listing
      const previousHistory = view.history
      const requestSeq = view.requestSeq + 1
      const pushHistory =
        options.history !== false &&
        previousPath !== null &&
        !pathsEqual(tab.pathStyle, previousPath, target)
      const nextHistory = pushHistory
        ? [...previousHistory, previousPath].slice(-64)
        : previousHistory

      setView(sessionId, {
        path: target,
        loading: true,
        error: null,
        requestSeq,
        history: nextHistory,
        selected: [],
        anchor: null
      })

      const result = await safeCall(() => getApi().files.list({ sessionId, path: target }))
      const current = get().fileViews[sessionId]
      if (!current || current.requestSeq !== requestSeq) return

      if (!result.ok) {
        const keepListing = previousListing !== null
        setView(sessionId, {
          path: keepListing ? previousPath : current.path,
          listing: previousListing,
          loading: false,
          error: keepListing ? null : result.error,
          history: keepListing ? previousHistory : nextHistory,
          selected: [],
          anchor: null
        })
        if (result.error.code === 'SSH_SFTP_UNAVAILABLE') {
          get().setTabFilesUnavailable(
            sessionId,
            `File browsing is unavailable for this session — ${errorMessage(result.error)}`
          )
        }
        if (keepListing) {
          get().pushToast(
            'error',
            `Could not open ${truncateMiddle(target, 60)} — ${errorMessage(result.error)}`
          )
        }
        return
      }

      setView(sessionId, {
        path: result.data.path,
        listing: result.data,
        loading: false,
        error: null
      })
    },

    navigateBack: async (sessionId: string): Promise<void> => {
      const tab = get().tabs.find((candidate) => candidate.id === sessionId)
      const view = get().fileViews[sessionId]
      if (!tab || !view || view.history.length === 0) return
      const target = view.history[view.history.length - 1]
      if (!target) return
      await get().navigateTo(sessionId, target, { history: false })
      const after = get().fileViews[sessionId]
      if (after && pathsEqual(tab.pathStyle, after.path, target)) {
        setView(sessionId, { history: after.history.slice(0, -1) })
      }
    },

    navigateUp: async (sessionId: string): Promise<void> => {
      const tab = get().tabs.find((candidate) => candidate.id === sessionId)
      const view = get().fileViews[sessionId]
      if (!tab || !view) return
      const parent =
        view.listing?.parentPath ?? (view.path ? parentPathFor(tab.pathStyle, view.path) : null)
      if (!parent) return
      await get().navigateTo(sessionId, parent)
    },

    refreshFiles: async (sessionId, options = {}): Promise<void> => {
      const tab = get().tabs.find((candidate) => candidate.id === sessionId)
      const view = get().fileViews[sessionId]
      const currentPath = view?.path ?? null
      if (!tab) return
      if (!currentPath) {
        if (tab.homePath) await get().navigateTo(sessionId, tab.homePath)
        return
      }
      const requestSeq = (view?.requestSeq ?? 0) + 1
      if (!options.silent) setView(sessionId, { loading: true, error: null, requestSeq })
      else setView(sessionId, { requestSeq })
      const result = await safeCall(() => getApi().files.list({ sessionId, path: currentPath }))
      const current = get().fileViews[sessionId]
      if (!current || current.requestSeq !== requestSeq) return
      if (!result.ok) {
        setView(sessionId, {
          loading: false,
          error: current.listing ? null : result.error
        })
        if (current.listing) {
          get().pushToast('error', `Could not refresh — ${errorMessage(result.error)}`)
        }
        return
      }
      const names = new Set(result.data.entries.map((entry) => entry.path))
      setView(sessionId, {
        listing: result.data,
        loading: false,
        error: null,
        selected: current.selected.filter((path) => names.has(path))
      })
    },

    selectOnly: (sessionId, path): void => {
      setView(sessionId, { selected: [path], anchor: path })
    },

    toggleSelected: (sessionId, path, _orderedPaths): void => {
      const view = get().fileViews[sessionId]
      if (!view) return
      const selected = view.selected.includes(path)
        ? view.selected.filter((candidate) => candidate !== path)
        : [...view.selected, path]
      setView(sessionId, { selected, anchor: path })
    },

    selectRange: (sessionId, path, orderedPaths): void => {
      const view = get().fileViews[sessionId]
      if (!view) return
      const anchor = view.anchor ?? path
      const from = orderedPaths.indexOf(anchor)
      const to = orderedPaths.indexOf(path)
      if (from === -1 || to === -1) {
        setView(sessionId, { selected: [path], anchor: path })
        return
      }
      const start = Math.min(from, to)
      const end = Math.max(from, to)
      setView(sessionId, { selected: orderedPaths.slice(start, end + 1) })
    },

    selectAll: (sessionId, orderedPaths): void => {
      setView(sessionId, {
        selected: [...orderedPaths],
        anchor: orderedPaths[0] ?? null
      })
    },

    clearSelection: (sessionId): void => {
      setView(sessionId, { selected: [], anchor: null })
    },

    copyPaths: async (paths): Promise<void> => {
      const list = Array.isArray(paths) ? paths : [paths]
      if (list.length === 0) return
      const result = await safeCall(() => getApi().clipboard.writeText(list.join('\n')))
      if (!result.ok) {
        get().pushToast('error', `Could not copy path — ${errorMessage(result.error)}`)
        return
      }
      get().pushToast('success', list.length === 1 ? 'Path copied' : `${list.length} paths copied`)
    },

    openEntry: (sessionId, path, isDirectory): void => {
      if (!isDirectory) return
      void get().navigateTo(sessionId, path)
    },

    promptNewFolder: (sessionId, parentPath): void => {
      get().showPrompt({
        title: 'New folder',
        label: 'Folder name',
        placeholder: 'untitled folder',
        confirmLabel: 'Create folder',
        validate: validateEntryName,
        action: (name) => {
          void get().performMkdir(sessionId, parentPath, name.trim())
        }
      })
    },

    promptRename: (sessionId, path, currentName): void => {
      get().showPrompt({
        title: 'Rename',
        label: 'New name',
        initialValue: currentName,
        confirmLabel: 'Rename',
        selectStem: true,
        validate: validateEntryName,
        action: (name) => {
          if (name.trim() === currentName) return
          void get().performRename(sessionId, path, name.trim())
        }
      })
    },

    promptDelete: (sessionId, paths): void => {
      if (paths.length === 0) return
      const settings = get().config?.settings ?? DEFAULT_SETTINGS
      const run = (): void => {
        void get().performDelete(sessionId, paths)
      }
      if (!settings.confirmDelete) {
        run()
        return
      }
      const label =
        paths.length === 1 ? truncateMiddle(paths[0] ?? '', 48) : `${paths.length} items`
      get().showConfirm({
        title: paths.length === 1 ? 'Delete item?' : `Delete ${paths.length} items?`,
        message: `Permanently delete ${label}? This cannot be undone.`,
        confirmLabel: 'Delete',
        danger: true,
        action: run
      })
    },

    performMkdir: async (sessionId, parentPath, name): Promise<void> => {
      if (!requireConnectedTab(sessionId)) return
      const result = await safeCall(() => getApi().files.mkdir({ sessionId, parentPath, name }))
      if (!result.ok) {
        get().pushToast('error', `Could not create folder — ${errorMessage(result.error)}`)
        return
      }
      get().pushToast('success', `Created folder “${name}”`)
      refreshAfterMutation(sessionId)
    },

    performRename: async (sessionId, path, newName): Promise<void> => {
      if (!requireConnectedTab(sessionId)) return
      const result = await safeCall(() => getApi().files.rename({ sessionId, path, newName }))
      if (!result.ok) {
        get().pushToast('error', `Could not rename — ${errorMessage(result.error)}`)
        return
      }
      get().pushToast('success', `Renamed to “${newName}”`)
      refreshAfterMutation(sessionId)
    },

    performDelete: async (sessionId, paths): Promise<void> => {
      if (!requireConnectedTab(sessionId)) return
      const result = await safeCall(() => getApi().files.delete({ sessionId, paths }))
      if (!result.ok) {
        get().pushToast('error', `Could not delete — ${errorMessage(result.error)}`)
        return
      }
      get().pushToast(
        'success',
        `Deleted ${paths.length === 1 ? '1 item' : `${paths.length} items`}`
      )
      setView(sessionId, { selected: [], anchor: null })
      refreshAfterMutation(sessionId)
    },

    uploadFiles: async (sessionId, destDir): Promise<void> => {
      const tab = requireConnectedTab(sessionId)
      if (!tab) return
      const view = get().fileViews[sessionId]
      const target = destDir ?? view?.path
      if (!target) return
      const result = await safeCall(() => getApi().dialogs.pickFiles())
      if (!result.ok) {
        get().pushToast('error', `Could not open file picker — ${errorMessage(result.error)}`)
        return
      }
      if (result.data.length === 0) return
      await get().uploadPaths(sessionId, result.data, target)
    },

    uploadFolder: async (sessionId, destDir): Promise<void> => {
      const tab = requireConnectedTab(sessionId)
      if (!tab) return
      const view = get().fileViews[sessionId]
      const target = destDir ?? view?.path
      if (!target) return
      const result = await safeCall(() => getApi().dialogs.pickFolderToUpload())
      if (!result.ok) {
        get().pushToast('error', `Could not open folder picker — ${errorMessage(result.error)}`)
        return
      }
      if (!result.data) return
      await get().uploadPaths(sessionId, [result.data], target)
    },

    uploadPaths: async (sessionId, sources, destDir): Promise<TransferStartResult | null> => {
      const tab = requireConnectedTab(sessionId)
      if (!tab) return null
      if (sources.length === 0 || !destDir) return null
      const result = await get().startTransfer({
        sessionId,
        direction: 'upload',
        sources,
        destDir,
        conflictPolicy: 'ask'
      })
      return result
    },

    downloadSelection: async (sessionId): Promise<void> => {
      const tab = requireConnectedTab(sessionId)
      if (!tab) return
      const view = get().fileViews[sessionId]
      const selected = selectedList(view)
      if (selected.length === 0) {
        get().pushToast('info', 'Select files to download first')
        return
      }
      const settings = get().config?.settings ?? DEFAULT_SETTINGS
      const startPath = settings.lastDownloadDir || settings.defaultDownloadDir || undefined
      const result = await safeCall(() => getApi().dialogs.pickFolder({ startPath }))
      if (!result.ok) {
        get().pushToast('error', `Could not open folder picker — ${errorMessage(result.error)}`)
        return
      }
      if (!result.data) return
      await get().downloadPathsTo(sessionId, selected, result.data)
    },

    downloadPathsTo: async (sessionId, paths, destDir): Promise<void> => {
      const tab = requireConnectedTab(sessionId)
      if (!tab) return
      if (paths.length === 0) {
        get().pushToast('info', 'Select files to download first')
        return
      }
      const settings = get().config?.settings ?? DEFAULT_SETTINGS
      const started = await get().startTransfer({
        sessionId,
        direction: 'download',
        sources: paths,
        destDir,
        conflictPolicy: 'ask'
      })
      if (started && started.status !== 'invalid') {
        if (settings.lastDownloadDir !== destDir) {
          void get().saveSettings({ lastDownloadDir: destDir }, { silent: true })
        }
      }
    },

    downloadToLastDir: async (sessionId, paths): Promise<void> => {
      const tab = requireConnectedTab(sessionId)
      if (!tab) return
      const settings = get().config?.settings ?? DEFAULT_SETTINGS
      const dir = settings.lastDownloadDir || settings.defaultDownloadDir
      if (!dir) {
        await get().downloadSelection(sessionId)
        return
      }
      await get().downloadPathsTo(sessionId, paths, dir)
    }
  }
}
