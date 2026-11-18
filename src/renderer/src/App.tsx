import { useEffect } from 'react'
import { DialogHost } from './components/DialogHost'
import { SidebarResizer } from './components/Resizer'
import { TabBar } from './components/TabBar'
import { TerminalStack } from './components/TerminalStack'
import { ToastHost } from './components/ToastHost'
import { TransferDrawer } from './components/TransferDrawer'
import { Icon } from './components/Icon'
import { Sidebar } from './components/sidebar/Sidebar'
import { hasBridge } from './lib/api'
import { dispatchSessionData } from './lib/terminalBus'
import { useAppStore } from './state/appStore'

export function App(): React.JSX.Element {
  const bridgeAvailable = hasBridge()
  const sidebarVisible = useAppStore((state) => state.sidebarVisible)
  const activeTitle = useAppStore(
    (state) =>
      state.tabs.find((tab) => tab.id === state.activeTabId)?.title ??
      (state.bootStatus === 'booting' ? 'Starting…' : null)
  )

  useEffect(() => {
    document.title = activeTitle ? `${activeTitle} — TermShelf` : 'TermShelf'
  }, [activeTitle])

  // Boot: load config, subscribe to main-process events, start one local shell.
  useEffect(() => {
    if (!bridgeAvailable) return
    void useAppStore.getState().bootstrap()

    const unsubscribe = window.termshelf.onEvent((event) => {
      if (event.type === 'session:data') {
        dispatchSessionData(event.sessionId, event.data)
        return
      }
      useAppStore.getState().handleEvent(event)
    })

    // Never let a stray OS drop navigate the window away from the app.
    const preventWindowDrop = (event: DragEvent): void => {
      event.preventDefault()
    }
    window.addEventListener('dragover', preventWindowDrop)
    window.addEventListener('drop', preventWindowDrop)

    return () => {
      unsubscribe()
      window.removeEventListener('dragover', preventWindowDrop)
      window.removeEventListener('drop', preventWindowDrop)
    }
  }, [bridgeAvailable])

  // Global keyboard shortcuts. Captured before xterm so they always win.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return
      const store = useAppStore.getState()

      if (event.key === 'F5') {
        event.preventDefault()
        if (store.activeTabId) void store.refreshFiles(store.activeTabId)
        return
      }

      const modifier = event.metaKey || event.ctrlKey
      if (!modifier || event.altKey) return
      const key = event.key.toLowerCase()

      // While a dialog is open, only swallow the tab-close shortcut.
      if (store.dialog) {
        if (key === 'w' || key === 't') event.preventDefault()
        return
      }

      switch (key) {
        case 't':
          event.preventDefault()
          if (event.shiftKey) store.showSshDialog()
          else void store.createLocalTab()
          break
        case 'w':
          event.preventDefault()
          if (store.activeTabId) void store.closeTab(store.activeTabId)
          break
        case ',':
          event.preventDefault()
          store.showSettingsDialog()
          break
        case 'b':
          event.preventDefault()
          store.toggleSidebar()
          break
        default:
          break
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [])

  if (!bridgeAvailable) {
    return (
      <div className="fatal-error" data-testid="bridge-error">
        <span className="fatal-error__icon">
          <Icon name="terminal" size={30} />
        </span>
        <h1>TermShelf could not start</h1>
        <p>
          The preload bridge (<code>window.termshelf</code>) is unavailable, so the interface cannot
          talk to the main process.
        </p>
        <p className="fatal-error__hint">
          This usually means the preload script failed to load. Restart TermShelf, or check the
          application logs from the main process.
        </p>
        <button type="button" className="btn btn--primary" onClick={() => window.location.reload()}>
          Reload interface
        </button>
      </div>
    )
  }

  return (
    <div className="app-shell" data-testid="app-shell">
      <TabBar />
      <div className="workspace" data-testid="workspace">
        <Sidebar />
        {sidebarVisible ? <SidebarResizer /> : null}
        <main className="terminal-area" data-testid="terminal-area">
          <TerminalStack />
        </main>
      </div>
      <TransferDrawer />
      <ToastHost />
      <DialogHost />
    </div>
  )
}
