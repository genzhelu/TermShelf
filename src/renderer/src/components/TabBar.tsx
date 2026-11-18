import type { SessionStatus } from '@shared/types'
import { useAppStore } from '../state/appStore'
import { Icon } from './Icon'
import { IconButton } from './ui/IconButton'

const STATUS_LABELS: Record<SessionStatus, string> = {
  connecting: 'Connecting',
  connected: 'Connected',
  disconnected: 'Disconnected',
  error: 'Error',
  ended: 'Ended'
}

export function TabBar(): React.JSX.Element {
  const tabs = useAppStore((state) => state.tabs)
  const activeTabId = useAppStore((state) => state.activeTabId)
  const selectTab = useAppStore((state) => state.selectTab)
  const closeTab = useAppStore((state) => state.closeTab)
  const createLocalTab = useAppStore((state) => state.createLocalTab)
  const showSshDialog = useAppStore((state) => state.showSshDialog)
  const showSettingsDialog = useAppStore((state) => state.showSettingsDialog)
  const toggleSidebar = useAppStore((state) => state.toggleSidebar)
  const sidebarVisible = useAppStore((state) => state.sidebarVisible)
  const platform = useAppStore((state) => state.platform)

  const shortcut = (keys: string): string =>
    platform === 'darwin' ? keys.replace('Ctrl', '⌘') : keys

  return (
    <header className="tabbar" data-testid="tab-bar">
      <div className="tabbar__brand" title="TermShelf">
        <span className="tabbar__logo">
          <Icon name="terminal" size={15} />
        </span>
        <span className="tabbar__name">TermShelf</span>
      </div>

      <div className="tabbar__tabs" role="tablist" aria-label="Terminal sessions">
        {tabs.map((tab) => {
          const active = tab.id === activeTabId
          return (
            <div
              key={tab.id}
              role="tab"
              tabIndex={active ? 0 : -1}
              aria-selected={active}
              className={['tab', active ? 'is-active' : '', `tab--${tab.status}`]
                .filter(Boolean)
                .join(' ')}
              data-testid="tab"
              data-session-id={tab.id}
              data-status={tab.status}
              data-active={active ? 'true' : 'false'}
              title={`${tab.title} — ${STATUS_LABELS[tab.status]}`}
              onClick={() => selectTab(tab.id)}
              onAuxClick={(event) => {
                if (event.button === 1) void closeTab(tab.id)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  selectTab(tab.id)
                }
              }}
            >
              <span
                className={`tab__status status-dot status-dot--${tab.status}`}
                aria-label={STATUS_LABELS[tab.status]}
              />
              <span className="tab__icon">
                <Icon name={tab.kind === 'ssh' ? 'server' : 'terminal'} size={13} />
              </span>
              <span className="tab__label">{tab.title}</span>
              <button
                type="button"
                className="tab__close"
                aria-label={`Close ${tab.title}`}
                title="Close tab"
                data-testid="tab-close"
                onClick={(event) => {
                  event.stopPropagation()
                  void closeTab(tab.id)
                }}
              >
                <Icon name="x" size={11} />
              </button>
            </div>
          )
        })}
        <IconButton
          icon="plus"
          label="New local terminal"
          shortcut={shortcut('Ctrl+T')}
          testId="new-tab-button"
          onClick={() => void createLocalTab()}
          className="tabbar__add"
          size={16}
        />
      </div>

      <div className="tabbar__actions">
        <IconButton
          icon="server"
          label="New SSH session"
          shortcut={shortcut('Ctrl+Shift+T')}
          testId="new-ssh-button"
          onClick={() => showSshDialog()}
        />
        <IconButton
          icon="panel"
          label={sidebarVisible ? 'Hide file browser' : 'Show file browser'}
          shortcut={shortcut('Ctrl+B')}
          testId="sidebar-toggle"
          active={sidebarVisible}
          onClick={() => toggleSidebar()}
        />
        <IconButton
          icon="settings"
          label="Settings"
          shortcut={shortcut('Ctrl+,')}
          testId="settings-button"
          onClick={() => showSettingsDialog()}
        />
      </div>
    </header>
  )
}
