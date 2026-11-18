import { useEffect, useId, useRef, useState } from 'react'
import { useAppStore } from '../../state/appStore'
import type { PromptDialogOptions } from '../../state/types'
import { Modal } from '../ui/Modal'

export function PromptDialog({ options }: { options: PromptDialogOptions }): React.JSX.Element {
  const closeDialog = useAppStore((state) => state.closeDialog)
  const [value, setValue] = useState(options.initialValue ?? '')
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const formId = useId()

  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    const current = options.initialValue ?? ''
    input.focus()
    if (options.selectStem && current) {
      const dot = current.lastIndexOf('.')
      const end = dot > 0 ? dot : current.length
      input.setSelectionRange(0, end)
    } else {
      input.select()
    }
    // Only when the dialog opens.
  }, [])

  const submit = (event: React.FormEvent): void => {
    event.preventDefault()
    const trimmed = value.trim()
    const validation =
      options.validate?.(trimmed) ?? (trimmed.length === 0 ? 'A value is required' : null)
    if (validation) {
      setError(validation)
      inputRef.current?.focus()
      return
    }
    closeDialog()
    options.action(trimmed)
  }

  return (
    <Modal
      title={options.title}
      icon={options.initialValue ? 'pencil' : 'folder-plus'}
      testId="prompt-dialog"
      onClose={closeDialog}
      footer={
        <>
          <button type="button" className="btn" onClick={closeDialog}>
            Cancel
          </button>
          <button
            type="submit"
            form={formId}
            className="btn btn--primary"
            data-testid="prompt-confirm-button"
          >
            {options.confirmLabel ?? 'OK'}
          </button>
        </>
      }
    >
      <form id={formId} className="dialog-form" onSubmit={submit}>
        <label className="field">
          <span className="field__label">{options.label}</span>
          <input
            ref={inputRef}
            className={error ? 'input input--invalid' : 'input'}
            data-testid="prompt-input"
            value={value}
            placeholder={options.placeholder}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => {
              setValue(event.target.value)
              setError(null)
            }}
            aria-invalid={error ? true : undefined}
          />
          <span className={error ? 'field__hint field__hint--error' : 'field__hint'}>
            {error ?? options.hint ?? 'Enter to confirm · Esc to cancel'}
          </span>
        </label>
      </form>
    </Modal>
  )
}
