import { useAppStore } from '../../state/appStore'
import { useSettings } from '../../state/selectors'
import type { FileViewState, TabState } from '../../state/types'
import { IconButton } from '../ui/IconButton'

export interface SidebarToolbarProps {
  sessionId: string
  tab: TabState
  view: FileViewState | null
}

export function SidebarToolbar({ sessionId, tab, view }: SidebarToolbarProps): React.JSX.Element {
  const settings = useSettings()
  const refreshFiles = useAppStore((state) => state.refreshFiles)
  const uploadFiles = useAppStore((state) => state.uploadFiles)
  const uploadFolder = useAppStore((state) => state.uploadFolder)
  const downloadSelection = useAppStore((state) => state.downloadSelection)
  const promptNewFolder = useAppStore((state) => state.promptNewFolder)
  const saveSettings = useAppStore((state) => state.saveSettings)
  const toggleFollowCwd = useAppStore((state) => state.toggleFollowCwd)

  const connected = tab.status === 'connected' && !tab.filesUnavailable
  const currentPath = view?.path ?? null
  const hasSelection = (view?.selected.length ?? 0) > 0
  const synced = settings.followCwd && tab.followCwd

  return (
    <div className="sidebar__toolbar" role="toolbar" aria-label="File browser actions">
      <IconButton
        icon="refresh"
        label="Refresh"
        shortcut="F5"
        testId="refresh-button"
        onClick={() => void refreshFiles(sessionId)}
        disabled={!currentPath}
        className={view?.loading ? 'is-spinning' : undefined}
      />
      <span className="toolbar-separator" />
      <IconButton
        icon="upload"
        label="Upload files…"
        testId="upload-files-button"
        onClick={() => void uploadFiles(sessionId)}
        disabled={!connected}
      />
      <IconButton
        icon="folder-up"
        label="Upload folder…"
        testId="upload-folder-button"
        onClick={() => void uploadFolder(sessionId)}
        disabled={!connected}
      />
      <IconButton
        icon="folder-plus"
        label="New folder…"
        testId="new-folder-button"
        onClick={() => {
          if (currentPath) promptNewFolder(sessionId, currentPath)
        }}
        disabled={!connected || !currentPath}
      />
      <IconButton
        icon="download"
        label="Download selected…"
        testId="download-button"
        onClick={() => void downloadSelection(sessionId)}
        disabled={!connected || !hasSelection}
      />
      <span className="toolbar-separator" />
      <IconButton
        icon={settings.showHiddenFiles ? 'eye' : 'eye-off'}
        label={settings.showHiddenFiles ? 'Hide hidden files' : 'Show hidden files'}
        testId="hidden-files-toggle"
        active={settings.showHiddenFiles}
        onClick={() =>
          void saveSettings({ showHiddenFiles: !settings.showHiddenFiles }, { silent: true })
        }
      />
      <span className="toolbar-spacer" />
      <IconButton
        icon={synced ? 'locate' : 'pin'}
        label={
          synced
            ? 'Following terminal folder — click for manual mode'
            : 'Manual folder — click to follow the terminal'
        }
        active={synced}
        testId="follow-cwd-toggle"
        onClick={() => toggleFollowCwd(sessionId)}
      />
    </div>
  )
}
