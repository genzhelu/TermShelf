import { useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { FileEntry } from '@shared/types'
import { truncateMiddle } from '../../lib/format'
import { fileNameFor } from '../../lib/paths'
import { useAppStore } from '../../state/appStore'
import { useSettings } from '../../state/selectors'
import type { FileViewState, TabState } from '../../state/types'
import { ContextMenu, type MenuItem } from '../ContextMenu'
import { FileRow } from './FileRow'

export interface FileListProps {
  sessionId: string
  tab: TabState
  view: FileViewState
  entries: FileEntry[]
  dropTarget: string | null
}

interface MenuState {
  x: number
  y: number
  items: MenuItem[]
}

export function FileList({
  sessionId,
  tab,
  view,
  entries,
  dropTarget
}: FileListProps): React.JSX.Element {
  const settings = useSettings()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)

  const navigateTo = useAppStore((state) => state.navigateTo)
  const navigateUp = useAppStore((state) => state.navigateUp)
  const refreshFiles = useAppStore((state) => state.refreshFiles)
  const selectOnly = useAppStore((state) => state.selectOnly)
  const toggleSelected = useAppStore((state) => state.toggleSelected)
  const selectRange = useAppStore((state) => state.selectRange)
  const selectAll = useAppStore((state) => state.selectAll)
  const clearSelection = useAppStore((state) => state.clearSelection)
  const promptNewFolder = useAppStore((state) => state.promptNewFolder)
  const promptRename = useAppStore((state) => state.promptRename)
  const promptDelete = useAppStore((state) => state.promptDelete)
  const copyPaths = useAppStore((state) => state.copyPaths)
  const downloadSelection = useAppStore((state) => state.downloadSelection)
  const downloadToLastDir = useAppStore((state) => state.downloadToLastDir)
  const uploadFiles = useAppStore((state) => state.uploadFiles)
  const uploadFolder = useAppStore((state) => state.uploadFolder)
  const saveSettings = useAppStore((state) => state.saveSettings)

  const connected = tab.status === 'connected' && !tab.filesUnavailable
  const selectedSet = useMemo(() => new Set(view.selected), [view.selected])
  const orderedPaths = useMemo(() => entries.map((entry) => entry.path), [entries])

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 26,
    overscan: 12,
    getItemKey: (index) => entries[index]?.path ?? index
  })

  const lastDownloadLabel = settings.lastDownloadDir
    ? truncateMiddle(fileNameFor(settings.lastDownloadDir, tab.pathStyle), 22)
    : null

  const buildRowMenu = (entry: FileEntry, selection: string[]): MenuItem[] => {
    const single =
      selection.length === 1
        ? (entries.find((candidate) => candidate.path === selection[0]) ?? entry)
        : null
    const folderForNew = entry.kind === 'dir' ? entry.path : (view.path ?? null)
    const items: MenuItem[] = [
      {
        id: 'open',
        label: 'Open',
        icon: 'folder-open',
        disabled: entry.kind !== 'dir',
        onSelect: () => void navigateTo(sessionId, entry.path)
      },
      {
        id: 'download',
        label: 'Download…',
        icon: 'download',
        disabled: !connected,
        onSelect: () => void downloadSelection(sessionId)
      }
    ]
    if (lastDownloadLabel) {
      items.push({
        id: 'download-last',
        label: `Download to ${lastDownloadLabel}`,
        icon: 'download',
        disabled: !connected,
        onSelect: () => void downloadToLastDir(sessionId, selection)
      })
    }
    items.push(
      { id: 'sep-1', separator: true },
      {
        id: 'new-folder',
        label: 'New folder…',
        icon: 'folder-plus',
        disabled: !connected || !folderForNew,
        onSelect: () => {
          if (folderForNew) promptNewFolder(sessionId, folderForNew)
        }
      },
      {
        id: 'rename',
        label: 'Rename…',
        icon: 'pencil',
        shortcut: 'F2',
        disabled: !connected || !single,
        onSelect: () => {
          if (single) promptRename(sessionId, single.path, single.name)
        }
      },
      {
        id: 'delete',
        label: selection.length > 1 ? `Delete ${selection.length} items…` : 'Delete…',
        icon: 'trash',
        danger: true,
        shortcut: 'Del',
        disabled: !connected || selection.length === 0,
        onSelect: () => promptDelete(sessionId, selection)
      },
      { id: 'sep-2', separator: true },
      {
        id: 'copy-path',
        label: selection.length > 1 ? 'Copy paths' : 'Copy path',
        icon: 'copy',
        onSelect: () => void copyPaths(selection)
      },
      {
        id: 'refresh',
        label: 'Refresh',
        icon: 'refresh',
        shortcut: 'F5',
        onSelect: () => void refreshFiles(sessionId)
      }
    )
    return items
  }

  const buildBackgroundMenu = (): MenuItem[] => [
    {
      id: 'new-folder',
      label: 'New folder…',
      icon: 'folder-plus',
      disabled: !connected || !view.path,
      onSelect: () => {
        if (view.path) promptNewFolder(sessionId, view.path)
      }
    },
    {
      id: 'upload-files',
      label: 'Upload files…',
      icon: 'upload',
      disabled: !connected,
      onSelect: () => void uploadFiles(sessionId)
    },
    {
      id: 'upload-folder',
      label: 'Upload folder…',
      icon: 'folder-up',
      disabled: !connected,
      onSelect: () => void uploadFolder(sessionId)
    },
    { id: 'sep-1', separator: true },
    {
      id: 'refresh',
      label: 'Refresh',
      icon: 'refresh',
      shortcut: 'F5',
      onSelect: () => void refreshFiles(sessionId)
    },
    {
      id: 'hidden',
      label: settings.showHiddenFiles ? 'Hide hidden files' : 'Show hidden files',
      icon: settings.showHiddenFiles ? 'eye-off' : 'eye',
      onSelect: () =>
        void saveSettings({ showHiddenFiles: !settings.showHiddenFiles }, { silent: true })
    }
  ]

  const openRowMenu = (event: React.MouseEvent, entry: FileEntry): void => {
    event.preventDefault()
    event.stopPropagation()
    scrollRef.current?.focus({ preventScroll: true })
    const selection = selectedSet.has(entry.path) ? view.selected : [entry.path]
    if (!selectedSet.has(entry.path)) selectOnly(sessionId, entry.path)
    setMenu({ x: event.clientX, y: event.clientY, items: buildRowMenu(entry, selection) })
  }

  const openBackgroundMenu = (event: React.MouseEvent): void => {
    event.preventDefault()
    setMenu({ x: event.clientX, y: event.clientY, items: buildBackgroundMenu() })
  }

  const handleRowClick = (event: React.MouseEvent<HTMLDivElement>, entry: FileEntry): void => {
    scrollRef.current?.focus({ preventScroll: true })
    if (event.shiftKey) {
      selectRange(sessionId, entry.path, orderedPaths)
    } else if (event.metaKey || event.ctrlKey) {
      toggleSelected(sessionId, entry.path, orderedPaths)
    } else {
      selectOnly(sessionId, entry.path)
    }
  }

  const handleRowDoubleClick = (entry: FileEntry): void => {
    if (entry.kind === 'dir') void navigateTo(sessionId, entry.path)
  }

  const cursorIndex = useMemo(() => {
    if (view.anchor) {
      const anchored = entries.findIndex((entry) => entry.path === view.anchor)
      if (anchored !== -1) return anchored
    }
    if (view.selected.length > 0) {
      return entries.findIndex((entry) => entry.path === view.selected[view.selected.length - 1])
    }
    return -1
  }, [entries, view.anchor, view.selected])

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const withModifier = event.metaKey || event.ctrlKey
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        event.preventDefault()
        if (entries.length === 0) return
        const delta = event.key === 'ArrowDown' ? 1 : -1
        const next = Math.max(0, Math.min(entries.length - 1, cursorIndex + delta))
        const entry = entries[next]
        if (!entry) return
        if (event.shiftKey && view.anchor) selectRange(sessionId, entry.path, orderedPaths)
        else selectOnly(sessionId, entry.path)
        virtualizer.scrollToIndex(next, { align: 'auto' })
        return
      }
      case 'Home':
      case 'End': {
        event.preventDefault()
        if (entries.length === 0) return
        const next = event.key === 'Home' ? 0 : entries.length - 1
        const entry = entries[next]
        if (!entry) return
        if (event.shiftKey && view.anchor) selectRange(sessionId, entry.path, orderedPaths)
        else selectOnly(sessionId, entry.path)
        virtualizer.scrollToIndex(next, { align: 'auto' })
        return
      }
      case 'Enter': {
        if (withModifier) return
        event.preventDefault()
        const selectedEntries = entries.filter((entry) => selectedSet.has(entry.path))
        const target =
          selectedEntries.find((entry) => entry.kind === 'dir') ??
          (cursorIndex >= 0 ? entries[cursorIndex] : undefined)
        if (!target) return
        if (target.kind === 'dir') void navigateTo(sessionId, target.path)
        return
      }
      case 'Backspace': {
        event.preventDefault()
        void navigateUp(sessionId)
        return
      }
      case 'Delete': {
        if (view.selected.length === 0) return
        event.preventDefault()
        promptDelete(sessionId, view.selected)
        return
      }
      case 'F2': {
        if (withModifier) return
        event.preventDefault()
        if (view.selected.length !== 1) return
        const entry = entries.find((candidate) => candidate.path === view.selected[0])
        if (entry) promptRename(sessionId, entry.path, entry.name)
        return
      }
      case ' ': {
        event.preventDefault()
        const entry = cursorIndex >= 0 ? entries[cursorIndex] : undefined
        if (entry) toggleSelected(sessionId, entry.path, orderedPaths)
        return
      }
      case 'Escape': {
        event.preventDefault()
        clearSelection(sessionId)
        return
      }
      default:
        break
    }
    if (withModifier && event.key.toLowerCase() === 'a') {
      event.preventDefault()
      selectAll(sessionId, orderedPaths)
    }
  }

  return (
    <div
      ref={scrollRef}
      className="file-list"
      data-testid="file-list"
      tabIndex={0}
      role="grid"
      aria-label="Files"
      aria-rowcount={entries.length}
      onKeyDown={handleKeyDown}
      onClick={(event) => {
        const target = event.target as HTMLElement
        if (target.closest('.file-row')) return
        clearSelection(sessionId)
      }}
      onContextMenu={openBackgroundMenu}
    >
      <div className="file-list__inner" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const entry = entries[virtualRow.index]
          if (!entry) return null
          return (
            <FileRow
              key={entry.path}
              entry={entry}
              index={virtualRow.index}
              selected={selectedSet.has(entry.path)}
              dropTarget={dropTarget === entry.path}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: virtualRow.size,
                transform: `translateY(${virtualRow.start}px)`
              }}
              onClick={(event) => handleRowClick(event, entry)}
              onDoubleClick={() => handleRowDoubleClick(entry)}
              onContextMenu={(event) => openRowMenu(event, entry)}
            />
          )
        })}
      </div>
      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menu.items}
          onClose={() => setMenu(null)}
          minWidth={214}
        />
      ) : null}
    </div>
  )
}
