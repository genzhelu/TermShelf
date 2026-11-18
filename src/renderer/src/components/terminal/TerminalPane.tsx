import { useEffect, useRef, useState } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import '@xterm/xterm/css/xterm.css'
import { TERMINAL_SCROLLBACK } from '@shared/constants'
import { getApi, safeCall } from '../../lib/api'
import { parseOsc7Path } from '../../lib/osc7'
import { subscribeSessionData } from '../../lib/terminalBus'
import { useAppStore } from '../../state/appStore'
import type { TabState } from '../../state/types'
import { ContextMenu, type MenuItem } from '../ContextMenu'
import { Icon } from '../Icon'

export const TERMINAL_FONT_FAMILY =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace'

const TERMINAL_THEME: ITheme = {
  background: '#0f1115',
  foreground: '#d6deeb',
  cursor: '#7dd3fc',
  cursorAccent: '#0f1115',
  selectionBackground: 'rgba(96, 165, 250, 0.32)',
  selectionForeground: undefined,
  black: '#1b212b',
  red: '#f0616d',
  green: '#8ce99a',
  yellow: '#f5c04a',
  blue: '#6aa9ff',
  magenta: '#c792ea',
  cyan: '#7dd3fc',
  white: '#d6deeb',
  brightBlack: '#5d6a7c',
  brightRed: '#ff8a94',
  brightGreen: '#a9f0b5',
  brightYellow: '#ffd479',
  brightBlue: '#8fc1ff',
  brightMagenta: '#e2b9ff',
  brightCyan: '#a5e8ff',
  brightWhite: '#f4f8ff'
}

interface TerminalMenuState {
  x: number
  y: number
  items: MenuItem[]
}

export interface TerminalPaneProps {
  tab: TabState
  active: boolean
}

export function TerminalPane({ tab, active }: TerminalPaneProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const [menu, setMenu] = useState<TerminalMenuState | null>(null)
  const tabId = tab.id

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const state = useAppStore.getState()
    const term = new Terminal({
      scrollback: TERMINAL_SCROLLBACK,
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: state.config?.settings.fontSize ?? 13,
      lineHeight: 1.22,
      letterSpacing: 0,
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorInactiveStyle: 'outline',
      allowProposedApi: true,
      macOptionIsMeta: true,
      rightClickSelectsWord: false,
      minimumContrastRatio: 1,
      theme: TERMINAL_THEME
    })
    const fitAddon = new FitAddon()
    const unicodeAddon = new Unicode11Addon()
    term.loadAddon(fitAddon)
    term.loadAddon(unicodeAddon)
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        event.preventDefault()
        if (/^https?:\/\//i.test(uri)) {
          void safeCall(() => getApi().app.openExternal(uri))
        }
      })
    )
    term.unicode.activeVersion = '11'
    term.open(container)

    terminalRef.current = term
    fitRef.current = fitAddon

    const write = (data: string): void => {
      try {
        const result = getApi().sessions.write(tabId, data)
        void result
      } catch {
        // Session closed between event and write; ignore.
      }
    }

    const dataDisposable = term.onData(write)
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      try {
        getApi().sessions.resize(tabId, cols, rows)
      } catch {
        // ignore transient bridge errors
      }
    })
    const titleDisposable = term.onTitleChange((title) => {
      useAppStore.getState().setTabTitle(tabId, title)
    })
    const osc7Disposable = term.parser.registerOscHandler(7, (data) => {
      const current = useAppStore.getState().tabs.find((candidate) => candidate.id === tabId)
      const style = current?.pathStyle ?? 'posix'
      const parsed = parseOsc7Path(data, style)
      if (parsed) useAppStore.getState().handleTerminalCwd(tabId, parsed)
      return true
    })

    const copySelection = async (): Promise<void> => {
      const selection = term.getSelection()
      if (!selection) return
      const result = await safeCall(() => getApi().clipboard.writeText(selection))
      if (!result.ok) useAppStore.getState().pushToast('error', 'Could not copy the selection')
    }

    const pasteFromClipboard = async (): Promise<void> => {
      const result = await safeCall(() => getApi().clipboard.readText())
      if (!result.ok) {
        useAppStore.getState().pushToast('error', 'Could not read the clipboard')
        return
      }
      if (result.data) term.paste(result.data)
    }

    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true
      const isMac = useAppStore.getState().platform === 'darwin'
      const key = event.key.toLowerCase()
      if (isMac) {
        if (event.metaKey && !event.ctrlKey && !event.altKey) {
          if (key === 'c' && term.hasSelection()) {
            event.preventDefault()
            void copySelection()
            return false
          }
          if (key === 'v') {
            event.preventDefault()
            void pasteFromClipboard()
            return false
          }
          if (key === 'a') {
            event.preventDefault()
            term.selectAll()
            return false
          }
        }
        return true
      }
      if (event.ctrlKey && event.shiftKey) {
        if (key === 'c' && term.hasSelection()) {
          event.preventDefault()
          void copySelection()
          return false
        }
        if (key === 'v') {
          event.preventDefault()
          void pasteFromClipboard()
          return false
        }
      }
      // Plain Ctrl+C must always reach the PTY (SIGINT), even with a selection.
      return true
    })

    const handleContextMenu = (event: MouseEvent): void => {
      event.preventDefault()
      const store = useAppStore.getState()
      const hasSelection = term.hasSelection()
      setMenu({
        x: event.clientX,
        y: event.clientY,
        items: [
          {
            id: 'copy',
            label: 'Copy',
            icon: 'copy',
            shortcut: store.platform === 'darwin' ? '⌘C' : 'Ctrl+Shift+C',
            disabled: !hasSelection,
            onSelect: () => void copySelection()
          },
          {
            id: 'paste',
            label: 'Paste',
            icon: 'clipboard',
            shortcut: store.platform === 'darwin' ? '⌘V' : 'Ctrl+Shift+V',
            onSelect: () => void pasteFromClipboard()
          },
          {
            id: 'select-all',
            label: 'Select all',
            icon: 'check',
            onSelect: () => term.selectAll()
          },
          { id: 'sep-1', separator: true },
          {
            id: 'clear',
            label: 'Clear terminal',
            icon: 'x-circle',
            onSelect: () => term.clear()
          },
          { id: 'sep-2', separator: true },
          {
            id: 'new-local',
            label: 'New local terminal',
            icon: 'terminal',
            shortcut: 'Ctrl+T',
            onSelect: () => void useAppStore.getState().createLocalTab()
          },
          {
            id: 'new-ssh',
            label: 'New SSH session…',
            icon: 'server',
            shortcut: 'Ctrl+Shift+T',
            onSelect: () => useAppStore.getState().showSshDialog()
          }
        ]
      })
    }

    container.addEventListener('contextmenu', handleContextMenu)

    const fit = (): void => {
      const element = containerRef.current
      if (!element) return
      const rect = element.getBoundingClientRect()
      if (rect.width < 2 || rect.height < 2) return
      try {
        fitAddon.fit()
      } catch {
        // Ignore fit during teardown.
      }
    }

    const frame = window.requestAnimationFrame(() => {
      fit()
      term.focus()
    })

    const unsubscribeData = subscribeSessionData(tabId, (data) => term.write(data))
    const resizeObserver = new ResizeObserver(() => fit())
    resizeObserver.observe(container)

    return () => {
      window.cancelAnimationFrame(frame)
      unsubscribeData()
      resizeObserver.disconnect()
      container.removeEventListener('contextmenu', handleContextMenu)
      dataDisposable.dispose()
      resizeDisposable.dispose()
      titleDisposable.dispose()
      osc7Disposable.dispose()
      fitRef.current = null
      terminalRef.current = null
      term.dispose()
    }
  }, [tabId])

  const fontSize = useAppStore((state) => state.config?.settings.fontSize ?? 13)

  useEffect(() => {
    const term = terminalRef.current
    if (!term) return
    if (term.options.fontSize === fontSize) return
    term.options.fontSize = fontSize
    const frame = window.requestAnimationFrame(() => {
      try {
        fitRef.current?.fit()
      } catch {
        // ignore
      }
    })
    return () => window.cancelAnimationFrame(frame)
  }, [fontSize])

  useEffect(() => {
    if (!active) return
    const frame = window.requestAnimationFrame(() => {
      const term = terminalRef.current
      if (!term) return
      try {
        fitRef.current?.fit()
      } catch {
        // ignore
      }
      term.focus()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [active])

  const reconnectTab = useAppStore((state) => state.reconnectTab)
  const closeTab = useAppStore((state) => state.closeTab)
  const createLocalTab = useAppStore((state) => state.createLocalTab)

  const restartSession = async (): Promise<void> => {
    if (tab.kind === 'ssh') {
      await reconnectTab(tab.id)
      return
    }
    await closeTab(tab.id)
    await createLocalTab()
  }

  const statusMessage =
    tab.status === 'disconnected'
      ? 'The connection was lost. Your terminal history is preserved.'
      : tab.status === 'error'
        ? (tab.error?.message ?? 'The session encountered an error.')
        : tab.status === 'connecting'
          ? 'Attempting to reconnect…'
          : ''

  return (
    <div
      className={active ? 'terminal-pane is-active' : 'terminal-pane'}
      data-testid="terminal"
      data-session-id={tab.id}
      aria-hidden={active ? undefined : true}
    >
      <div ref={containerRef} className="terminal-pane__xterm" />

      {active &&
      (tab.status === 'disconnected' || tab.status === 'error' || tab.status === 'connecting') ? (
        <div
          className={[
            'terminal-banner',
            tab.status === 'connecting' ? 'is-connecting' : '',
            tab.status === 'error' ? 'is-error' : ''
          ]
            .filter(Boolean)
            .join(' ')}
          role="status"
        >
          <Icon
            name={tab.status === 'connecting' ? 'loader' : 'alert-triangle'}
            size={15}
            className={tab.status === 'connecting' ? 'spin' : undefined}
          />
          <div className="terminal-banner__text">
            <strong>
              {tab.status === 'connecting'
                ? 'Reconnecting…'
                : tab.status === 'error'
                  ? 'Session error'
                  : 'Disconnected'}
            </strong>
            <span>{statusMessage}</span>
          </div>
          {tab.status === 'connecting' ? null : (
            <button
              type="button"
              className="btn btn--sm btn--primary"
              onClick={() => void reconnectTab(tab.id)}
            >
              <Icon name="refresh" size={13} /> Reconnect
            </button>
          )}
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={() => void closeTab(tab.id)}
          >
            Close tab
          </button>
        </div>
      ) : null}

      {active && tab.status === 'ended' ? (
        <div className="terminal-ended">
          <div className="terminal-ended__card">
            <span className="terminal-ended__icon">
              <Icon name={tab.kind === 'ssh' ? 'server' : 'terminal'} size={28} />
            </span>
            <h2>Session ended</h2>
            <p>
              {tab.kind === 'ssh'
                ? 'The remote shell closed the connection.'
                : 'The shell process exited.'}
            </p>
            <div className="terminal-ended__actions">
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => void restartSession()}
              >
                <Icon name="refresh" size={14} />
                {tab.kind === 'ssh' ? 'Reconnect' : 'Start a new terminal'}
              </button>
              <button type="button" className="btn" onClick={() => void closeTab(tab.id)}>
                Close tab
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menu.items}
          onClose={() => setMenu(null)}
          minWidth={206}
        />
      ) : null}
    </div>
  )
}
