import type { DirListing, PathStyle } from '@shared/types'
import { parentPathFor } from '../../lib/paths'
import { useAppStore } from '../../state/appStore'
import { useActiveFileView } from '../../state/selectors'
import { IconButton } from '../ui/IconButton'
import { PathBar } from './PathBar'

export interface SidebarHeaderProps {
  sessionId: string
  pathStyle: PathStyle
  path: string | null
  listing: DirListing | null
  loading: boolean
}

export function SidebarHeader({
  sessionId,
  pathStyle,
  path,
  listing,
  loading
}: SidebarHeaderProps): React.JSX.Element {
  const navigateBack = useAppStore((state) => state.navigateBack)
  const navigateUp = useAppStore((state) => state.navigateUp)
  const navigateTo = useAppStore((state) => state.navigateTo)
  const historyLength = useActiveFileView()?.history.length ?? 0
  const homePath = useAppStore((state) =>
    state.activeTabId
      ? (state.tabs.find((tab) => tab.id === state.activeTabId)?.homePath ?? null)
      : null
  )

  const parentPath = listing?.parentPath ?? (path ? parentPathFor(pathStyle, path) : null)

  return (
    <header className="sidebar__header">
      <div className="sidebar__nav">
        <IconButton
          icon="chevron-left"
          label="Back"
          testId="back-button"
          onClick={() => void navigateBack(sessionId)}
          disabled={historyLength === 0}
          size={16}
        />
        <IconButton
          icon="arrow-up"
          label="Parent folder"
          shortcut="Backspace"
          testId="up-button"
          onClick={() => void navigateUp(sessionId)}
          disabled={!parentPath}
          size={16}
        />
        <IconButton
          icon="home"
          label="Home folder"
          testId="home-button"
          onClick={() => {
            if (homePath) void navigateTo(sessionId, homePath)
          }}
          disabled={!homePath}
          size={15}
        />
        <PathBar
          sessionId={sessionId}
          pathStyle={pathStyle}
          path={path}
          listing={listing}
          loading={loading}
        />
      </div>
    </header>
  )
}
