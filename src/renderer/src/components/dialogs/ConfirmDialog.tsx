import { useAppStore } from '../../state/appStore'
import type { ConfirmDialogOptions } from '../../state/types'
import { Modal } from '../ui/Modal'

export function ConfirmDialog({ options }: { options: ConfirmDialogOptions }): React.JSX.Element {
  const closeDialog = useAppStore((state) => state.closeDialog)

  const confirm = (): void => {
    closeDialog()
    Promise.resolve(options.action()).catch(() => {
      // Actions surface their own errors through toasts.
    })
  }

  return (
    <Modal
      title={options.title}
      icon={options.danger ? 'alert-triangle' : 'info'}
      className={options.danger ? 'modal--danger' : undefined}
      testId="confirm-dialog"
      onClose={closeDialog}
      footer={
        <>
          <button
            type="button"
            className="btn"
            onClick={closeDialog}
            data-testid="confirm-cancel-button"
            data-autofocus={options.danger ? true : undefined}
          >
            {options.cancelLabel ?? 'Cancel'}
          </button>
          <button
            type="button"
            className={options.danger ? 'btn btn--danger' : 'btn btn--primary'}
            onClick={confirm}
            data-testid="confirm-button"
            data-autofocus={options.danger ? undefined : true}
          >
            {options.confirmLabel ?? 'Confirm'}
          </button>
        </>
      }
    >
      <p className="dialog-text">{options.message}</p>
      {options.detail ? <p className="dialog-text dialog-text--dim">{options.detail}</p> : null}
    </Modal>
  )
}
