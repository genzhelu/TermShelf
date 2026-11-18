import { errorMessage } from '../lib/api'
import { useAppStore } from '../state/appStore'
import { Icon } from './Icon'
import { TerminalPane } from './terminal/TerminalPane'

export function TerminalStack(): React.JSX.Element {
  const tabs = useAppStore((state) => state.tabs)
  const activeTabId = useAppStore((state) => state.activeTabId)
  const bootStatus = useAppStore((state) => state.bootStatus)
  const localBootError = useAppStore((state) => state.localBootError)
  const retryLocalSession = useAppStore((state) => state.retryLocalSession)
  const createLocalTab = useAppStore((state) => state.createLocalTab)
  const showSshDialog = useAppStore((state) => state.showSshDialog)

  if (tabs.length === 0) {
    if (localBootError) {
      return (
        <div className="workspace-state" data-testid="boot-error">
          <span className="workspace-state__icon workspace-state__icon--danger">
            <Icon name="terminal" size={28} />
          </span>
          <h1>Could not start the local terminal</h1>
          <p className="workspace-state__message">{errorMessage(localBootError)}</p>
          <code className="workspace-state__code">{localBootError.code}</code>
          <div className="workspace-state__actions">
            <button
              type="button"
              className="btn btn--primary"
              data-testid="boot-retry-button"
              onClick={() => void retryLocalSession()}
            >
              <Icon name="refresh" size={14} /> Retry
            </button>
            <button type="button" className="btn" onClick={() => showSshDialog()}>
              <Icon name="server" size={14} /> Connect to a server
            </button>
          </div>
          <p className="workspace-state__hint">
            Check that your shell is available, or set a shell override in Settings.
          </p>
        </div>
      )
    }

    if (bootStatus === 'booting') {
      return (
        <div className="boot-splash" data-testid="boot-splash">
          <span className="boot-splash__logo">
            <Icon name="terminal" size={30} />
          </span>
          <h1>TermShelf</h1>
          <p>Starting your terminal…</p>
          <span className="boot-splash__spinner">
            <Icon name="loader" size={17} className="spin" />
          </span>
        </div>
      )
    }

    return (
      <div className="workspace-state" data-testid="empty-workspace">
        <span className="workspace-state__icon">
          <Icon name="terminal" size={30} />
        </span>
        <h1>No open terminals</h1>
        <p className="workspace-state__message">
          Open a local shell or connect to a server to get started.
        </p>
        <div className="workspace-state__actions">
          <button
            type="button"
            className="btn btn--primary"
            data-testid="empty-new-tab-button"
            onClick={() => void createLocalTab()}
          >
            <Icon name="terminal" size={14} /> New local terminal
          </button>
          <button type="button" className="btn" onClick={() => showSshDialog()}>
            <Icon name="server" size={14} /> New SSH session
          </button>
        </div>
        <div className="shortcut-hints">
          <span>
            <kbd>Ctrl</kbd>+<kbd>T</kbd> new terminal
          </span>
          <span>
            <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd> new SSH session
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className="terminal-stack">
      {tabs.map((tab) => (
        <TerminalPane key={tab.id} tab={tab} active={tab.id === activeTabId} />
      ))}
    </div>
  )
}
