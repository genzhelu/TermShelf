import { useMemo, useRef, useState } from 'react'
import type { FileEntry } from '@shared/types'
import { errorMessage } from '../../lib/api'
import { formatCount, isHiddenName, pluralize } from '../../lib/format'
import { useAppStore } from '../../state/appStore'
import { useActiveFileView, useActiveTab, useSettings } from '../../state/selectors'
import { Icon } from '../Icon'
import { DropOverlay } from './DropOverlay'
import { FileList } from './FileList'
import { SidebarHeader } from './SidebarHeader'
import { SidebarToolbar } from './SidebarToolbar'

function sortEntries(
  entries: FileEntry[],
  sortKey: 'name' | 'size' | 'mtime',
  sortDir: 'asc' | 'desc',
  showHidden: boolean
): FileEntry[] {
  const filtered = showHidden ? entries : entries.filter((entry) => !isHiddenName(entry.name))
  return [...filtered].sort((left, right) => {
    const leftDir = left.kind === 'dir' ? 0 : 1
    const rightDir = right.kind === 'dir' ? 0 : 1
    if (leftDir !== rightDir) return leftDir - rightDir
    let result = 0
    if (sortKey === 'name') {
      result = left.name.localeCompare(right.name, undefined, {
        sensitivity: 'base',
        numeric: true
      })
    } else if (sortKey === 'size') {
      result = left.size - right.size
    } else {
      result = left.mtimeMs - right.mtimeMs
    }
    if (result === 0) result = left.name.localeCompare(right.name)
    return sortDir === 'asc' ? result : -result
  })
}

export function Sidebar(): React.JSX.Element {
  const sidebarVisible = useAppStore((state) => state.sidebarVisible)
  const sidebarWidth = useAppStore((state) => state.sidebarWidth)
  const tab = useActiveTab()
  const view = useActiveFileView()
  const settings = useSettings()
  const sortKey = useAppStore((state) => state.sortKey)
  const sortDir = useAppStore((state) => state.sortDir)
  const setSort = useAppStore((state) => state.setSort)
  const refreshFiles = useAppStore((state) => state.refreshFiles)
  const navigateTo = useAppStore((state) => state.navigateTo)
  const reconnectTab = useAppStore((state) => state.reconnectTab)
  const toggleFollowCwd = useAppStore((state) => state.toggleFollowCwd)
  const uploadPaths = useAppStore((state) => state.uploadPaths)
  const pushToast = useAppStore((state) => state.pushToast)

  const [dragCount, setDragCount] = useState<number | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const dragDepth = useRef(0)

  const entries = useMemo(() => {
    if (!view?.listing) return []
    return sortEntries(view.listing.entries, sortKey, sortDir, settings.showHiddenFiles)
  }, [view?.listing, sortKey, sortDir, settings.showHiddenFiles])

  if (!sidebarVisible) return <></>

  const connected = tab ? tab.status === 'connected' && !tab.filesUnavailable : false
  const canUpload = connected && (view?.path ?? null) !== null
  const selectedCount = view?.selected.length ?? 0
  const synced = tab ? settings.followCwd && tab.followCwd : false

  const hasFileDrag = (event: React.DragEvent): boolean =>
    Array.from(event.dataTransfer.types).includes('Files')

  const readDroppedPaths = (event: React.DragEvent): string[] => {
    const paths: string[] = []
    for (const file of Array.from(event.dataTransfer.files)) {
      try {
        const path = window.termshelf.getPathForFile(file)
        if (path) paths.push(path)
      } catch {
        // Unsupported drag source; skip.
      }
    }
    return paths
  }

  const resetDrag = (): void => {
    dragDepth.current = 0
    setDragCount(null)
    setDropTarget(null)
  }

  const handleDragEnter = (event: React.DragEvent): void => {
    if (!hasFileDrag(event)) return
    event.preventDefault()
    if (!canUpload) return
    dragDepth.current += 1
    if (dragCount === null) setDragCount(event.dataTransfer.items.length)
  }

  const handleDragOver = (event: React.DragEvent): void => {
    if (!hasFileDrag(event)) return
    event.preventDefault()
    if (!canUpload) {
      event.dataTransfer.dropEffect = 'none'
      return
    }
    event.dataTransfer.dropEffect = 'copy'
    const target = event.target as HTMLElement
    const row = target.closest<HTMLElement>('[data-drop-dir]')
    const nextTarget = row?.dataset.dropDir ?? null
    setDropTarget((current) => (current === nextTarget ? current : nextTarget))
    if (dragCount === null) setDragCount(event.dataTransfer.items.length)
  }

  const handleDragLeave = (event: React.DragEvent): void => {
    if (!hasFileDrag(event)) return
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) {
      setDragCount(null)
      setDropTarget(null)
    }
  }

  const handleDrop = (event: React.DragEvent): void => {
    event.preventDefault()
    event.stopPropagation()
    const destination = dropTarget ?? view?.path ?? null
    resetDrag()
    if (!tab) return
    if (!canUpload) {
      pushToast('warn', 'Reconnect the session before uploading files.')
      return
    }
    const paths = readDroppedPaths(event)
    if (!destination) return
    if (paths.length === 0) {
      pushToast('warn', 'Could not read the dropped items. Try again from a file manager.')
      return
    }
    void uploadPaths(tab.id, paths, destination)
  }

  const targetLabel = dropTarget
    ? (entries.find((entry) => entry.path === dropTarget)?.name ?? null)
    : null

  const renderContent = (): React.JSX.Element => {
    if (!tab) {
      return (
        <div className="sidebar__empty">
          <Icon name="panel" size={26} />
          <p>No active session</p>
          <span>Open a terminal to browse its files.</span>
        </div>
      )
    }
    if (!view) {
      return <SkeletonRows />
    }
    if (!view.listing) {
      if (view.loading) return <SkeletonRows />
      if (view.error) {
        return (
          <div className="sidebar__state">
            <Icon name="alert-triangle" size={24} />
            <p className="sidebar__state-title">Could not list this folder</p>
            <p className="sidebar__state-message">{errorMessage(view.error)}</p>
            <div className="sidebar__state-actions">
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => void refreshFiles(tab.id)}
              >
                <Icon name="refresh" size={13} /> Retry
              </button>
              {tab.homePath ? (
                <button
                  type="button"
                  className="btn btn--sm btn--ghost"
                  onClick={() => void navigateTo(tab.id, tab.homePath ?? '')}
                >
                  <Icon name="home" size={13} /> Home
                </button>
              ) : null}
            </div>
          </div>
        )
      }
      return <SkeletonRows />
    }
    if (entries.length === 0) {
      return (
        <div className="sidebar__state">
          <Icon name={settings.showHiddenFiles ? 'folder-open' : 'folder'} size={26} />
          <p className="sidebar__state-title">This folder is empty</p>
          <p className="sidebar__state-message">
            {connected
              ? 'Drag files or folders here to upload them.'
              : 'Reconnect to interact with this folder.'}
          </p>
          {connected ? (
            <div className="sidebar__state-actions">
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => void useAppStore.getState().uploadFiles(tab.id)}
              >
                <Icon name="upload" size={13} /> Upload files
              </button>
            </div>
          ) : null}
        </div>
      )
    }
    return (
      <FileList
        sessionId={tab.id}
        tab={tab}
        view={view}
        entries={entries}
        dropTarget={dropTarget}
      />
    )
  }

  return (
    <aside
      className="sidebar"
      data-testid="sidebar"
      style={{ width: sidebarWidth }}
      aria-label="File browser"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {tab && view ? (
        <SidebarHeader
          sessionId={tab.id}
          pathStyle={tab.pathStyle}
          path={view.path}
          listing={view.listing}
          loading={view.loading}
        />
      ) : (
        <div className="sidebar__header sidebar__header--placeholder" />
      )}

      {tab && (tab.status !== 'connected' || tab.filesUnavailable) ? (
        <div
          className={[
            'sidebar__notice',
            tab.status === 'connecting' ? 'is-connecting' : 'is-offline'
          ].join(' ')}
          role="status"
        >
          <Icon
            name={tab.status === 'connecting' ? 'loader' : 'alert-triangle'}
            size={13}
            className={tab.status === 'connecting' ? 'spin' : undefined}
          />
          <span>
            {tab.filesUnavailable ??
              (tab.status === 'connecting'
                ? 'Connecting…'
                : tab.status === 'ended'
                  ? 'Session ended'
                  : 'Session disconnected')}
          </span>
          {tab.status !== 'connecting' ? (
            <button type="button" className="link-button" onClick={() => void reconnectTab(tab.id)}>
              Reconnect
            </button>
          ) : null}
        </div>
      ) : null}

      {tab ? <SidebarToolbar sessionId={tab.id} tab={tab} view={view} /> : null}

      <div className="file-list__head" role="row" aria-label="Sort files">
        <SortHeader
          label="Name"
          active={sortKey === 'name'}
          dir={sortDir}
          onClick={() => setSort('name')}
          className="col-name"
        />
        <SortHeader
          label="Size"
          active={sortKey === 'size'}
          dir={sortDir}
          onClick={() => setSort('size')}
          className="col-size"
        />
        <SortHeader
          label="Modified"
          active={sortKey === 'mtime'}
          dir={sortDir}
          onClick={() => setSort('mtime')}
          className="col-mtime"
        />
      </div>

      <div
        className={
          view?.loading && view.listing ? 'file-list-wrap is-refreshing' : 'file-list-wrap'
        }
      >
        {renderContent()}
      </div>

      {tab ? (
        <footer className="sidebar__footer">
          <div className="sidebar__footer-left">
            <span
              className="sidebar__scope"
              title={
                tab.kind === 'ssh'
                  ? 'These are files on the remote host (SFTP)'
                  : tab.environment === 'wsl'
                    ? 'These are files inside the WSL distribution'
                    : 'These are files on this computer. Use New SSH Session to browse a remote host.'
              }
            >
              <Icon name={tab.kind === 'ssh' ? 'server' : 'terminal'} size={11} />
              <span>
                {tab.kind === 'ssh' ? 'SFTP' : tab.environment === 'wsl' ? 'WSL' : 'Local'}
              </span>
            </span>
            <span className="sidebar__count">
              {formatCount(entries.length)} {pluralize(entries.length, 'item')}
            </span>
            {view?.listing?.truncated ? (
              <span className="sidebar__truncated" title="Only the first 5000 entries are shown">
                truncated
              </span>
            ) : null}
            {selectedCount > 0 ? (
              <span className="sidebar__selection">{selectedCount} selected</span>
            ) : null}
          </div>
          <button
            type="button"
            className={synced ? 'follow-badge is-synced' : 'follow-badge'}
            data-testid="follow-status"
            onClick={() => toggleFollowCwd(tab.id)}
            title={
              synced
                ? 'File browser follows the terminal folder. Click to switch to manual mode.'
                : 'Manual folder. Click to follow the terminal folder.'
            }
          >
            <Icon name={synced ? 'locate' : 'pin'} size={11} />
            <span>{synced ? 'Synced to terminal' : 'Manual folder'}</span>
          </button>
        </footer>
      ) : null}

      {dragCount !== null && canUpload ? (
        <DropOverlay count={dragCount} destination={view?.path ?? ''} targetLabel={targetLabel} />
      ) : null}
    </aside>
  )
}

function SortHeader({
  label,
  active,
  dir,
  onClick,
  className
}: {
  label: string
  active: boolean
  dir: 'asc' | 'desc'
  onClick: () => void
  className?: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={['sort-header', active ? 'is-active' : '', className ?? '']
        .filter(Boolean)
        .join(' ')}
      onClick={onClick}
      aria-label={`Sort by ${label}`}
      aria-pressed={active}
    >
      <span>{label}</span>
      <Icon
        name={active && dir === 'asc' ? 'chevron-up' : 'chevron-down'}
        size={11}
        className={active ? 'sort-header__arrow is-active' : 'sort-header__arrow'}
      />
    </button>
  )
}

function SkeletonRows(): React.JSX.Element {
  return (
    <div className="skeleton-list" aria-hidden="true">
      {Array.from({ length: 9 }).map((_, index) => (
        <div key={index} className="skeleton-row">
          <span className="skeleton-block skeleton-block--icon" />
          <span
            className="skeleton-block skeleton-block--name"
            style={{ width: `${45 + ((index * 13) % 40)}%` }}
          />
          <span className="skeleton-block skeleton-block--meta" />
        </div>
      ))}
    </div>
  )
}
