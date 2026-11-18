import { Icon } from '../Icon'
import type { HostKeyPrompt } from '../../lib/hostKey'
import { Modal } from '../ui/Modal'

export interface HostKeyDialogProps {
  prompt: HostKeyPrompt
  busy: boolean
  onTrust: () => void
  onCancel: () => void
}

export function HostKeyDialog({
  prompt,
  busy,
  onTrust,
  onCancel
}: HostKeyDialogProps): React.JSX.Element {
  const { hostKey, mismatch, expectedFingerprint } = prompt
  return (
    <Modal
      title={mismatch ? 'Host key has changed' : 'Unknown host key'}
      subtitle={`${hostKey.host}:${hostKey.port}`}
      icon="key"
      width={580}
      className="modal--hostkey"
      testId="hostkey-dialog"
      busy={busy}
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn" onClick={onCancel} disabled={busy} data-autofocus>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--danger"
            onClick={onTrust}
            disabled={busy}
            data-testid="hostkey-trust-button"
          >
            {busy ? (
              <Icon name="loader" size={14} className="spin" />
            ) : (
              <Icon name="check" size={14} />
            )}
            Trust &amp; connect
          </button>
        </>
      }
    >
      <div className={mismatch ? 'notice notice--danger' : 'notice notice--warn'}>
        <Icon name="alert-triangle" size={17} />
        <div>
          <p className="notice__title">
            {mismatch
              ? 'The server presented a different host key than the one saved on this computer.'
              : 'This is the first time connecting to this server.'}
          </p>
          <p className="notice__body">
            {mismatch
              ? 'This can happen after a server reinstall, but it can also indicate a man-in-the-middle attack. Only continue if you trust this machine and verified the new fingerprint out of band.'
              : 'Verify the fingerprint with the server administrator before trusting it. Once trusted, TermShelf will remember it for future connections.'}
          </p>
        </div>
      </div>

      <dl className="key-details">
        <div className="key-details__row">
          <dt>Algorithm</dt>
          <dd>{hostKey.algorithm}</dd>
        </div>
        <div className="key-details__row">
          <dt>Fingerprint</dt>
          <dd>
            <code className="code-block">{hostKey.fingerprint}</code>
          </dd>
        </div>
        {mismatch && expectedFingerprint ? (
          <div className="key-details__row">
            <dt>Previously trusted</dt>
            <dd>
              <code className="code-block code-block--dim">{expectedFingerprint}</code>
            </dd>
          </div>
        ) : null}
      </dl>
    </Modal>
  )
}
