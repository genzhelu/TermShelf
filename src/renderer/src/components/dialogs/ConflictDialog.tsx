import type { TransferConflict, TransferRequest } from '@shared/types'
import { pluralize } from '../../lib/format'
import { useAppStore } from '../../state/appStore'
import { Icon } from '../Icon'
import { Modal } from '../ui/Modal'

export interface ConflictDialogProps {
  request: TransferRequest
  conflicts: TransferConflict[]
}

export function ConflictDialog({ request, conflicts }: ConflictDialogProps): React.JSX.Element {
  const resolveConflict = useAppStore((state) => state.resolveConflict)
  const direction = request.direction === 'upload' ? 'upload' : 'download'
  const destinationLabel = request.direction === 'upload' ? 'the remote folder' : 'the local folder'

  return (
    <Modal
      title="Files already exist"
      subtitle={`${conflicts.length} ${pluralize(conflicts.length, 'conflict')} in ${destinationLabel}`}
      icon="alert-triangle"
      width={620}
      testId="conflict-dialog"
      onClose={() => void resolveConflict('cancel')}
      footer={
        <>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => void resolveConflict('cancel')}
            data-testid="conflict-cancel"
          >
            Cancel transfer
          </button>
          <span className="modal__footer-spacer" />
          <button
            type="button"
            className="btn"
            onClick={() => void resolveConflict('skip')}
            data-testid="conflict-skip"
          >
            Skip existing
          </button>
          <button
            type="button"
            className="btn btn--danger"
            onClick={() => void resolveConflict('overwrite')}
            data-testid="conflict-overwrite"
          >
            Overwrite
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void resolveConflict('keepBoth')}
            data-autofocus
            data-testid="conflict-keepboth"
          >
            Keep both
          </button>
        </>
      }
    >
      <p className="dialog-text">
        The {direction} contains {conflicts.length} {pluralize(conflicts.length, 'file')} that
        already exist at <code className="inline-code">{request.destDir}</code>. Choose how to
        resolve them before the transfer continues.
      </p>
      <ul className="conflict-list" aria-label="Conflicting files">
        {conflicts.map((conflict) => (
          <li key={conflict.destinationPath} className="conflict-list__item">
            <Icon name={conflict.kind === 'dir' ? 'folder' : 'file'} size={14} />
            <span className="conflict-list__name">{conflict.name}</span>
            <span className="conflict-list__path" title={conflict.destinationPath}>
              {conflict.destinationPath}
            </span>
          </li>
        ))}
      </ul>
      <div className="choice-hints">
        <p>
          <strong>Overwrite</strong> replaces the existing files.
        </p>
        <p>
          <strong>Skip existing</strong> transfers only new files.
        </p>
        <p>
          <strong>Keep both</strong> renames incoming files with a numbered suffix.
        </p>
      </div>
    </Modal>
  )
}
