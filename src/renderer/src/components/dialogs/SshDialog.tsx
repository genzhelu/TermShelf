import type { FormEvent } from 'react'
import { useRef, useState } from 'react'
import type { AuthMethod, SshConnectRequest, SshProfile, SshProfileSummary } from '@shared/types'
import { errorMessage, getApi, safeCall } from '../../lib/api'
import { hostKeyPromptFromError, type HostKeyPrompt } from '../../lib/hostKey'
import { useAppStore } from '../../state/appStore'
import type { SshDialogSeed } from '../../state/types'
import { Icon } from '../Icon'
import { Modal } from '../ui/Modal'
import { HostKeyDialog } from './HostKeyDialog'

interface SshFormState {
  name: string
  host: string
  port: string
  username: string
  authMethod: AuthMethod
  privateKeyPath: string
  password: string
  passphrase: string
  saveProfile: boolean
  saveSecret: boolean
}

const AUTH_METHODS: Array<{ value: AuthMethod; label: string; hint: string }> = [
  { value: 'password', label: 'Password', hint: 'Authenticate with a password.' },
  {
    value: 'privateKey',
    label: 'Private key',
    hint: 'Authenticate with an OpenSSH private key file.'
  },
  { value: 'agent', label: 'SSH agent', hint: 'Use a running ssh-agent (SSH_AUTH_SOCK).' }
]

function emptyForm(): SshFormState {
  return {
    name: '',
    host: '',
    port: '22',
    username: '',
    authMethod: 'password',
    privateKeyPath: '',
    password: '',
    passphrase: '',
    saveProfile: true,
    saveSecret: false
  }
}

function formFromProfile(profile: SshProfileSummary | null): SshFormState {
  if (!profile) return emptyForm()
  return {
    name: profile.name,
    host: profile.host,
    port: String(profile.port),
    username: profile.username,
    authMethod: profile.authMethod,
    privateKeyPath: profile.privateKeyPath ?? '',
    password: '',
    passphrase: '',
    saveProfile: true,
    saveSecret: profile.hasSavedPassword || profile.hasSavedPassphrase
  }
}

function profileHasSavedSecret(profile: SshProfileSummary): boolean {
  return profile.hasSavedPassword || profile.hasSavedPassphrase
}

export function SshDialog({ seed }: { seed: SshDialogSeed }): React.JSX.Element {
  const config = useAppStore((state) => state.config)
  const closeDialog = useAppStore((state) => state.closeDialog)
  const addSessionTab = useAppStore((state) => state.addSessionTab)
  const pushToast = useAppStore((state) => state.pushToast)
  const refreshConfig = useAppStore((state) => state.refreshConfig)
  const estimateTerminalSize = useAppStore((state) => state.estimateTerminalSize)

  const profiles = config?.profiles ?? []
  const encryptionAvailable = config?.encryptionAvailable ?? false
  const [selectedId, setSelectedId] = useState<string | null>(seed.profile?.id ?? null)
  const [form, setForm] = useState<SshFormState>(() => formFromProfile(seed.profile ?? null))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [hostKeyPrompt, setHostKeyPrompt] = useState<HostKeyPrompt | null>(null)
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
  const pendingRequestRef = useRef<SshConnectRequest | null>(null)

  const selectedProfile = profiles.find((profile) => profile.id === selectedId) ?? null

  const patchForm = (patch: Partial<SshFormState>): void => {
    setForm((current) => ({ ...current, ...patch }))
    setError(null)
  }

  const makeProfileBody = (withSavedSecretFlags: boolean): SshProfile | null => {
    const host = form.host.trim()
    const username = form.username.trim()
    const port = Number.parseInt(form.port, 10)
    if (!host) {
      setError('Host is required')
      return null
    }
    if (!username) {
      setError('Username is required')
      return null
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setError('Port must be a number between 1 and 65535')
      return null
    }
    if (form.authMethod === 'privateKey' && !form.privateKeyPath.trim()) {
      setError('Choose a private key file')
      return null
    }
    if (form.authMethod === 'password' && !form.password && !selectedProfile?.hasSavedPassword) {
      setError('Password is required — no saved password for this profile')
      return null
    }
    const profile: SshProfile = {
      name: form.name.trim() || `${username}@${host}`,
      host,
      port,
      username,
      authMethod: form.authMethod,
      saveProfile: form.saveProfile,
      saveSecret: withSavedSecretFlags
    }
    if (selectedProfile?.id) profile.id = selectedProfile.id
    if (form.authMethod === 'privateKey') profile.privateKeyPath = form.privateKeyPath.trim()
    return profile
  }

  const buildRequest = (): SshConnectRequest | null => {
    const profile = makeProfileBody(encryptionAvailable && form.saveSecret)
    if (!profile) return null
    const { cols, rows } = estimateTerminalSize()
    const request: SshConnectRequest = { profile, cols, rows }
    if (form.authMethod === 'password' && form.password) request.password = form.password
    if (form.authMethod === 'privateKey' && form.passphrase) request.passphrase = form.passphrase
    return request
  }

  const connect = async (request: SshConnectRequest): Promise<void> => {
    setBusy(true)
    setError(null)
    const result = await safeCall(() => getApi().sessions.createSsh(request))
    if (!result.ok) {
      setBusy(false)
      const prompt = hostKeyPromptFromError(result.error)
      if (prompt) {
        pendingRequestRef.current = request
        setHostKeyPrompt(prompt)
        return
      }
      setError(errorMessage(result.error))
      return
    }
    setBusy(false)
    addSessionTab(result.data)
    pushToast('success', `Connected to ${result.data.title}`)
    closeDialog()
    void refreshConfig()
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (busy) return
    const request = buildRequest()
    if (request) void connect(request)
  }

  const trustAndConnect = async (): Promise<void> => {
    const prompt = hostKeyPrompt
    const request = pendingRequestRef.current
    if (!prompt || !request) return
    setBusy(true)
    setError(null)
    const trusted = await safeCall(() => getApi().ssh.trustHostKey(prompt.hostKey))
    if (!trusted.ok) {
      setBusy(false)
      setHostKeyPrompt(null)
      setError(`Could not trust host key — ${errorMessage(trusted.error)}`)
      return
    }
    setHostKeyPrompt(null)
    await connect(request)
  }

  const chooseProfile = (profile: SshProfileSummary): void => {
    setSelectedId(profile.id)
    setForm(formFromProfile(profile))
    setError(null)
  }

  const startNewProfile = (): void => {
    setSelectedId(null)
    setForm(emptyForm())
    setError(null)
  }

  const connectSavedProfile = (profile: SshProfileSummary): void => {
    if (profile.authMethod === 'password' && !profile.hasSavedPassword) {
      chooseProfile(profile)
      setError('Enter the password for this profile, then press Connect')
      return
    }
    const { cols, rows } = estimateTerminalSize()
    const body: SshProfile = {
      id: profile.id,
      name: profile.name,
      host: profile.host,
      port: profile.port,
      username: profile.username,
      authMethod: profile.authMethod,
      saveProfile: true,
      saveSecret: encryptionAvailable && profileHasSavedSecret(profile)
    }
    if (profile.privateKeyPath) body.privateKeyPath = profile.privateKeyPath
    setSelectedId(profile.id)
    setForm(formFromProfile(profile))
    setError(null)
    void connect({ profile: body, cols, rows })
  }

  const browsePrivateKey = async (): Promise<void> => {
    const result = await safeCall(() => getApi().dialogs.pickKey())
    if (!result.ok) {
      pushToast('error', `Could not open key picker — ${errorMessage(result.error)}`)
      return
    }
    if (result.data) patchForm({ privateKeyPath: result.data })
  }

  const deleteProfile = async (profile: SshProfileSummary): Promise<void> => {
    setPendingDeleteId(null)
    const result = await safeCall(() => getApi().profiles.delete(profile.id))
    if (!result.ok) {
      pushToast('error', `Could not delete saved session — ${errorMessage(result.error)}`)
      return
    }
    pushToast('success', `Deleted saved session “${profile.name}”`)
    if (selectedId === profile.id) startNewProfile()
    await refreshConfig()
  }

  const authHint = AUTH_METHODS.find((method) => method.value === form.authMethod)?.hint ?? ''

  return (
    <>
      <Modal
        title="New SSH session"
        subtitle="Connect to a remote server over SSH. The file browser uses SFTP."
        icon="globe"
        width={820}
        className="modal--wide"
        testId="ssh-dialog"
        bodyClassName="ssh-dialog"
        busy={busy || hostKeyPrompt !== null}
        onClose={() => {
          if (!busy) closeDialog()
        }}
        footer={
          <>
            <span className="modal__footer-hint">
              {encryptionAvailable
                ? 'Credentials are encrypted with the OS keychain.'
                : 'OS encryption is unavailable; secrets will not be saved.'}
            </span>
            <span className="modal__footer-spacer" />
            <button type="button" className="btn" onClick={closeDialog} disabled={busy}>
              Cancel
            </button>
            <button
              type="submit"
              form="ssh-connect-form"
              className="btn btn--primary"
              disabled={busy}
              data-testid="ssh-connect-button"
            >
              {busy ? (
                <Icon name="loader" size={14} className="spin" />
              ) : (
                <Icon name="globe" size={14} />
              )}
              Connect
            </button>
          </>
        }
      >
        <aside className="saved-sessions" aria-label="Saved sessions">
          <div className="saved-sessions__header">
            <h3>Saved sessions</h3>
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              onClick={startNewProfile}
              title="New connection"
              disabled={busy}
            >
              <Icon name="plus" size={13} />
              New
            </button>
          </div>
          <div className="saved-sessions__list">
            {profiles.length === 0 ? (
              <div className="saved-sessions__empty">
                <Icon name="server" size={20} />
                <p>No saved sessions yet.</p>
                <span>Connections you save will appear here.</span>
              </div>
            ) : (
              profiles.map((profile) => (
                <div
                  key={profile.id}
                  className={[
                    'saved-session',
                    selectedId === profile.id ? 'is-active' : '',
                    pendingDeleteId === profile.id ? 'is-confirming' : ''
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  <button
                    type="button"
                    className="saved-session__main"
                    onClick={() => chooseProfile(profile)}
                    onDoubleClick={() => connectSavedProfile(profile)}
                    title={`${profile.username}@${profile.host}:${profile.port}`}
                    disabled={busy}
                  >
                    <Icon
                      name={profile.authMethod === 'privateKey' ? 'key' : 'server'}
                      size={15}
                      className="saved-session__icon"
                    />
                    <span className="saved-session__text">
                      <span className="saved-session__name">
                        {profile.name}
                        {profileHasSavedSecret(profile) ? (
                          <Icon
                            name="lock"
                            size={11}
                            className="saved-session__lock"
                            title="Saved credentials"
                          />
                        ) : null}
                      </span>
                      <span className="saved-session__meta">
                        {profile.username}@{profile.host}
                        {profile.port === 22 ? '' : `:${profile.port}`}
                      </span>
                    </span>
                  </button>
                  {pendingDeleteId === profile.id ? (
                    <div className="saved-session__confirm">
                      <button
                        type="button"
                        className="btn btn--xs btn--danger"
                        onClick={() => void deleteProfile(profile)}
                      >
                        Delete
                      </button>
                      <button
                        type="button"
                        className="btn btn--xs"
                        onClick={() => setPendingDeleteId(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <div className="saved-session__actions">
                      <button
                        type="button"
                        className="icon-button icon-button--ghost"
                        title="Connect"
                        aria-label={`Connect to ${profile.name}`}
                        disabled={busy}
                        onClick={() => connectSavedProfile(profile)}
                      >
                        <Icon name="arrow-right" size={14} />
                      </button>
                      <button
                        type="button"
                        className="icon-button icon-button--ghost"
                        title="Delete saved session"
                        aria-label={`Delete ${profile.name}`}
                        disabled={busy}
                        onClick={() => setPendingDeleteId(profile.id)}
                      >
                        <Icon name="trash" size={14} />
                      </button>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
          <div className="saved-sessions__footer">
            <p>
              Double-click a session to connect
              {profiles.some(
                (profile) => profile.authMethod === 'password' && profile.hasSavedPassword
              )
                ? ' using saved credentials'
                : ''}
              .
            </p>
          </div>
        </aside>

        <form id="ssh-connect-form" className="ssh-form" onSubmit={submit}>
          {error ? (
            <div className="form-error" role="alert">
              <Icon name="alert-circle" size={15} />
              <span>{error}</span>
            </div>
          ) : null}

          <div className="form-grid form-grid--two">
            <label className="field field--grow">
              <span className="field__label">Name</span>
              <input
                className="input"
                value={form.name}
                placeholder={
                  form.username && form.host ? `${form.username}@${form.host}` : 'My server'
                }
                data-testid="ssh-name-input"
                spellCheck={false}
                onChange={(event) => patchForm({ name: event.target.value })}
                data-autofocus
              />
            </label>
            <label className="field">
              <span className="field__label">Authentication</span>
              <select
                className="input select"
                value={form.authMethod}
                onChange={(event) => patchForm({ authMethod: event.target.value as AuthMethod })}
              >
                {AUTH_METHODS.map((method) => (
                  <option key={method.value} value={method.value}>
                    {method.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="form-grid form-grid--host">
            <label className="field field--grow">
              <span className="field__label">Host</span>
              <input
                className="input"
                value={form.host}
                placeholder="example.com or 10.0.0.5"
                data-testid="ssh-host-input"
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => patchForm({ host: event.target.value })}
              />
            </label>
            <label className="field field--port">
              <span className="field__label">Port</span>
              <input
                className="input"
                type="number"
                min={1}
                max={65535}
                value={form.port}
                data-testid="ssh-port-input"
                onChange={(event) => patchForm({ port: event.target.value })}
              />
            </label>
            <label className="field field--grow">
              <span className="field__label">Username</span>
              <input
                className="input"
                value={form.username}
                placeholder="root"
                data-testid="ssh-username-input"
                spellCheck={false}
                autoComplete="username"
                onChange={(event) => patchForm({ username: event.target.value })}
              />
            </label>
          </div>

          {form.authMethod === 'password' ? (
            <label className="field">
              <span className="field__label">Password</span>
              <input
                className="input"
                type="password"
                value={form.password}
                autoComplete="current-password"
                data-testid="ssh-password-input"
                placeholder={
                  selectedProfile?.hasSavedPassword
                    ? 'Saved password will be used'
                    : 'Password for this server'
                }
                onChange={(event) => patchForm({ password: event.target.value })}
              />
              <span className="field__hint">
                {selectedProfile?.hasSavedPassword
                  ? 'Leave empty to use the password saved for this session.'
                  : authHint}
              </span>
            </label>
          ) : null}

          {form.authMethod === 'privateKey' ? (
            <>
              <div className="field">
                <span className="field__label">Private key file</span>
                <div className="field__row">
                  <input
                    className="input"
                    value={form.privateKeyPath}
                    placeholder="~/.ssh/id_ed25519"
                    data-testid="ssh-key-path-input"
                    spellCheck={false}
                    onChange={(event) => patchForm({ privateKeyPath: event.target.value })}
                  />
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => void browsePrivateKey()}
                  >
                    Browse…
                  </button>
                </div>
                <span className="field__hint">
                  OpenSSH, PEM or PuTTY-format private keys are supported.
                </span>
              </div>
              <label className="field">
                <span className="field__label">Key passphrase</span>
                <input
                  className="input"
                  type="password"
                  value={form.passphrase}
                  autoComplete="off"
                  placeholder={
                    selectedProfile?.hasSavedPassphrase
                      ? 'Saved passphrase will be used'
                      : 'Only needed for encrypted keys'
                  }
                  onChange={(event) => patchForm({ passphrase: event.target.value })}
                />
              </label>
            </>
          ) : null}

          {form.authMethod === 'agent' ? (
            <div className="notice notice--info">
              <Icon name="info" size={15} />
              <p>
                TermShelf will use keys from a running SSH agent (SSH_AUTH_SOCK, or the Windows
                OpenSSH agent service).
              </p>
            </div>
          ) : null}

          <div className="ssh-form__options">
            <label className="checkbox">
              <input
                type="checkbox"
                checked={form.saveProfile}
                onChange={(event) => patchForm({ saveProfile: event.target.checked })}
              />
              <span>
                <span className="checkbox__label">Save this session</span>
                <span className="checkbox__hint">Add it to the saved sessions list.</span>
              </span>
            </label>
            <label className={encryptionAvailable ? 'checkbox' : 'checkbox is-disabled'}>
              <input
                type="checkbox"
                checked={encryptionAvailable && form.saveSecret}
                disabled={!encryptionAvailable || !form.saveProfile}
                onChange={(event) => patchForm({ saveSecret: event.target.checked })}
              />
              <span>
                <span className="checkbox__label">Save password / passphrase</span>
                <span className="checkbox__hint">
                  {encryptionAvailable
                    ? 'Stored encrypted with the operating system keychain.'
                    : 'Unavailable — OS encryption is not available on this system.'}
                </span>
              </span>
            </label>
          </div>

          <p className="ssh-form__keyboard-hint">
            <kbd>Enter</kbd> connect · <kbd>Esc</kbd> close · Host keys are verified before
            connecting.
          </p>
        </form>
      </Modal>

      {hostKeyPrompt ? (
        <HostKeyDialog
          prompt={hostKeyPrompt}
          busy={busy}
          onTrust={() => void trustAndConnect()}
          onCancel={() => {
            if (busy) return
            setHostKeyPrompt(null)
            pendingRequestRef.current = null
          }}
        />
      ) : null}
    </>
  )
}
