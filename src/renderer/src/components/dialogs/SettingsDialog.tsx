import { useEffect, useState } from 'react'
import type { Settings, WslInfo } from '@shared/types'
import { errorMessage, getApi, safeCall } from '../../lib/api'
import { useAppStore } from '../../state/appStore'
import { DEFAULT_SETTINGS, clampFontSize } from '../../state/defaults'
import { Icon } from '../Icon'
import { Modal } from '../ui/Modal'

const PLATFORM_LABELS: Record<string, string> = {
  darwin: 'macOS',
  win32: 'Windows',
  linux: 'Linux'
}

export function SettingsDialog(): React.JSX.Element {
  const closeDialog = useAppStore((state) => state.closeDialog)
  const saveSettings = useAppStore((state) => state.saveSettings)
  const config = useAppStore((state) => state.config)
  const platform = useAppStore((state) => state.platform)
  const version = useAppStore((state) => state.version)
  const pushToast = useAppStore((state) => state.pushToast)

  const shortcut = (keys: string): string =>
    platform === 'darwin' ? keys.replace('Ctrl', '⌘') : keys
  const [draft, setDraft] = useState<Settings>(() => ({
    ...DEFAULT_SETTINGS,
    ...(config?.settings ?? {})
  }))
  const [busy, setBusy] = useState(false)
  const [wslInfo, setWslInfo] = useState<WslInfo | null>(null)
  const [wslLoading, setWslLoading] = useState(platform === 'win32')
  const [wslError, setWslError] = useState<string | null>(null)

  useEffect(() => {
    if (platform !== 'win32') return
    let cancelled = false
    setWslLoading(true)
    void safeCall(() => getApi().wsl.info()).then((result) => {
      if (cancelled) return
      setWslLoading(false)
      if (result.ok) {
        setWslInfo(result.data)
        setWslError(null)
      } else {
        setWslError(errorMessage(result.error))
      }
    })
    return () => {
      cancelled = true
    }
  }, [platform])

  const wslAvailable = wslInfo?.available ?? false
  const missingDistro =
    draft.wslDistro && wslInfo && !wslInfo.distros.includes(draft.wslDistro)
      ? draft.wslDistro
      : null

  const update = <K extends keyof Settings>(key: K, value: Settings[K]): void => {
    setDraft((current) => ({ ...current, [key]: value }))
  }

  const browseDownloadDir = async (): Promise<void> => {
    const result = await safeCall(() =>
      getApi().dialogs.pickFolder({ startPath: draft.defaultDownloadDir || undefined })
    )
    if (!result.ok) {
      pushToast('error', `Could not open folder picker — ${errorMessage(result.error)}`)
      return
    }
    if (result.data) update('defaultDownloadDir', result.data)
  }

  const openLogs = async (): Promise<void> => {
    const result = await safeCall(() => getApi().app.openLogs())
    if (!result.ok) pushToast('error', `Could not open logs — ${errorMessage(result.error)}`)
  }

  const save = async (): Promise<void> => {
    setBusy(true)
    const ok = await saveSettings({
      ...draft,
      fontSize: clampFontSize(draft.fontSize)
    })
    setBusy(false)
    if (ok) {
      pushToast('success', 'Settings saved')
      closeDialog()
    }
  }

  const encryptionAvailable = config?.encryptionAvailable ?? false

  return (
    <Modal
      title="Settings"
      icon="settings"
      width={600}
      testId="settings-dialog"
      onClose={closeDialog}
      busy={busy}
      footer={
        <>
          <button type="button" className="btn" onClick={closeDialog} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void save()}
            disabled={busy}
            data-testid="settings-save-button"
          >
            {busy ? (
              <Icon name="loader" size={14} className="spin" />
            ) : (
              <Icon name="check" size={14} />
            )}
            Save settings
          </button>
        </>
      }
    >
      <div className="settings-sections">
        <section className="settings-section">
          <h3 className="settings-section__title">Files</h3>
          <div className="field">
            <label className="field__label" htmlFor="settings-download-dir">
              Default download folder
            </label>
            <div className="field__row">
              <input
                id="settings-download-dir"
                className="input"
                value={draft.defaultDownloadDir}
                placeholder="Operating system Downloads folder"
                spellCheck={false}
                onChange={(event) => update('defaultDownloadDir', event.target.value)}
                data-autofocus
              />
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => void browseDownloadDir()}
              >
                Browse…
              </button>
            </div>
            <span className="field__hint">
              Leave empty to use the operating system Downloads folder.{' '}
              {draft.defaultDownloadDir ? (
                <button
                  type="button"
                  className="link-button"
                  onClick={() => update('defaultDownloadDir', '')}
                >
                  Use OS default
                </button>
              ) : null}
            </span>
          </div>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={draft.followCwd}
              onChange={(event) => update('followCwd', event.target.checked)}
            />
            <span>
              <span className="checkbox__label">Follow terminal folder (OSC 7)</span>
              <span className="checkbox__hint">
                Keep the file browser in sync with the shell&apos;s current directory.
              </span>
            </span>
          </label>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={draft.showHiddenFiles}
              onChange={(event) => update('showHiddenFiles', event.target.checked)}
            />
            <span>
              <span className="checkbox__label">Show hidden files</span>
              <span className="checkbox__hint">Include dotfiles in the file browser.</span>
            </span>
          </label>
        </section>

        <section className="settings-section">
          <h3 className="settings-section__title">Terminal</h3>
          <div className="field">
            <label className="field__label" htmlFor="settings-font-size">
              Font size <span className="field__value">{draft.fontSize}px</span>
            </label>
            <div className="field__row">
              <input
                id="settings-font-size"
                type="range"
                className="range"
                min={8}
                max={32}
                step={1}
                value={draft.fontSize}
                onChange={(event) => update('fontSize', clampFontSize(Number(event.target.value)))}
              />
              <input
                type="number"
                className="input input--number"
                min={8}
                max={32}
                value={draft.fontSize}
                aria-label="Terminal font size"
                onChange={(event) =>
                  update('fontSize', clampFontSize(Number(event.target.value) || 13))
                }
              />
            </div>
            <span className="field__hint">8–32 px. Applied to all open terminals.</span>
          </div>

          <div className="field">
            <label className="field__label" htmlFor="settings-local-terminal">
              Default local terminal
            </label>
            <select
              id="settings-local-terminal"
              className="input select"
              data-testid="settings-local-terminal"
              value={draft.localTerminal}
              disabled={busy}
              onChange={(event) => {
                const next = event.target.value as Settings['localTerminal']
                update('localTerminal', next)
                if (next === 'native') update('wslDistro', null)
              }}
            >
              <option value="auto">
                {platform === 'win32' ? 'Auto (WSL when available)' : 'Auto (native shell)'}
              </option>
              <option value="native">Native shell</option>
              {platform === 'win32' ? (
                <option value="wsl" disabled={!wslAvailable}>
                  WSL
                </option>
              ) : null}
            </select>
            <span className="field__hint">
              Applies to new local terminals. In a WSL tab, `ssh -Y` works through WSLg, but the
              sidebar shows WSL files — use a separate SSH session for remote SFTP.
            </span>
            {platform === 'win32' ? (
              wslLoading ? (
                <span className="field__hint">
                  <Icon name="loader" size={11} className="spin" /> Detecting WSL…
                </span>
              ) : wslError ? (
                <span className="field__hint">WSL unavailable: {wslError}</span>
              ) : wslInfo && !wslInfo.available ? (
                <span className="field__hint">
                  WSL unavailable: {wslInfo.error ?? 'no distributions found'}
                </span>
              ) : null
            ) : null}
          </div>

          {platform === 'win32' &&
          (wslAvailable || missingDistro) &&
          draft.localTerminal !== 'native' ? (
            <div className="field">
              <label className="field__label" htmlFor="settings-wsl-distro">
                WSL distribution
              </label>
              <select
                id="settings-wsl-distro"
                className="input select"
                data-testid="settings-wsl-distro"
                value={draft.wslDistro ?? ''}
                disabled={busy || !wslAvailable}
                onChange={(event) => update('wslDistro', event.target.value || null)}
              >
                <option value="">
                  Default{wslInfo?.defaultDistro ? ` (${wslInfo.defaultDistro})` : ''}
                </option>
                {missingDistro ? (
                  <option value={missingDistro}>{missingDistro} (not installed)</option>
                ) : null}
                {(wslInfo?.distros ?? []).map((distro) => (
                  <option key={distro} value={distro}>
                    {distro}
                  </option>
                ))}
              </select>
              <span className="field__hint">Used for new WSL terminal tabs.</span>
              {missingDistro ? (
                <span className="field__hint">
                  “{missingDistro}” is no longer installed. New tabs will fall back to the native
                  shell.{' '}
                  <button
                    type="button"
                    className="btn btn--sm btn--ghost"
                    onClick={() => update('wslDistro', null)}
                  >
                    Use default distribution
                  </button>
                </span>
              ) : null}
            </div>
          ) : null}

          <div className="field">
            <label className="field__label" htmlFor="settings-shell">
              Shell override
            </label>
            <input
              id="settings-shell"
              className="input"
              value={draft.shellPath ?? ''}
              placeholder="Auto-detect ($SHELL, PowerShell or cmd.exe)"
              spellCheck={false}
              onChange={(event) =>
                update('shellPath', event.target.value.trim() ? event.target.value : null)
              }
            />
            <span className="field__hint">
              Applies to new native terminals only (Auto with a shell override/or Native). Leave
              empty to use the system default.
            </span>
          </div>
        </section>

        <section className="settings-section">
          <h3 className="settings-section__title">Behaviour</h3>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={draft.confirmDelete}
              onChange={(event) => update('confirmDelete', event.target.checked)}
            />
            <span>
              <span className="checkbox__label">Confirm before deleting files</span>
              <span className="checkbox__hint">Deleting is permanent and cannot be undone.</span>
            </span>
          </label>
        </section>

        <section className="settings-section">
          <h3 className="settings-section__title">Keyboard shortcuts</h3>
          <div className="shortcut-grid">
            <kbd>{shortcut('Ctrl+T')}</kbd>
            <span>New local terminal</span>
            <kbd>{shortcut('Ctrl+Shift+T')}</kbd>
            <span>New SSH session</span>
            <kbd>{shortcut('Ctrl+W')}</kbd>
            <span>Close active tab</span>
            <kbd>{shortcut('Ctrl+B')}</kbd>
            <span>Toggle file browser</span>
            <kbd>{shortcut('Ctrl+,')}</kbd>
            <span>Open settings</span>
            <kbd>F5</kbd>
            <span>Refresh file browser</span>
            <kbd>{platform === 'darwin' ? '⌘C' : 'Ctrl+Shift+C'}</kbd>
            <span>Copy terminal selection</span>
            <kbd>{platform === 'darwin' ? '⌘V' : 'Ctrl+Shift+V'}</kbd>
            <span>Paste into terminal</span>
            <kbd>Enter / Backspace</kbd>
            <span>Open folder / go to parent</span>
            <kbd>F2 / Del</kbd>
            <span>Rename / delete selected files</span>
          </div>
        </section>

        <section className="settings-section settings-section--about">
          <h3 className="settings-section__title">About</h3>
          <div className="about-grid">
            <span>TermShelf</span>
            <span>{version}</span>
            <span>Platform</span>
            <span>{PLATFORM_LABELS[platform] ?? platform}</span>
            <span>Credential storage</span>
            <span className={encryptionAvailable ? 'about-status is-ok' : 'about-status is-warn'}>
              {encryptionAvailable
                ? 'OS encryption available'
                : 'OS encryption unavailable — secrets are not saved'}
            </span>
          </div>
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => void openLogs()}>
            <Icon name="external-link" size={13} />
            Open log folder
          </button>
        </section>
      </div>
    </Modal>
  )
}
