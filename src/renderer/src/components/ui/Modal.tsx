import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon, type IconName } from '../Icon'
import { IconButton } from './IconButton'

export interface ModalProps {
  title: string
  subtitle?: string
  icon?: IconName
  width?: number
  className?: string
  bodyClassName?: string
  children: ReactNode
  footer?: ReactNode
  onClose: () => void
  /** While busy, Escape/backdrop do not close the dialog. */
  busy?: boolean
  hideClose?: boolean
  testId?: string
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Stack of currently mounted modals. Only the top-most dialog reacts to
 * Escape / Tab so nested prompts (e.g. a host-key confirmation over the SSH
 * dialog) do not close their parent by accident.
 */
const modalStack: symbol[] = []

function trapFocus(event: KeyboardEvent, container: HTMLElement | null): void {
  if (!container) return
  const nodes = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (node) => node.offsetParent !== null || node === document.activeElement
  )
  if (nodes.length === 0) return
  const first = nodes[0]
  const last = nodes[nodes.length - 1]
  if (!first || !last) return
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

export function Modal({
  title,
  subtitle,
  icon,
  width,
  className,
  bodyClassName,
  children,
  footer,
  onClose,
  busy = false,
  hideClose = false,
  testId
}: ModalProps): React.JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null)
  const tokenRef = useRef<symbol>(Symbol('modal'))
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const busyRef = useRef(busy)
  busyRef.current = busy

  useEffect(() => {
    const token = tokenRef.current
    modalStack.push(token)
    return () => {
      const index = modalStack.lastIndexOf(token)
      if (index !== -1) modalStack.splice(index, 1)
    }
  }, [])

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const timer = window.setTimeout(() => {
      const container = panelRef.current
      if (!container) return
      const preferred = container.querySelector<HTMLElement>('[data-autofocus]')
      const fallback = container.querySelector<HTMLElement>(FOCUSABLE)
      ;(preferred ?? fallback)?.focus()
    }, 20)
    return () => {
      window.clearTimeout(timer)
      if (previous && document.contains(previous)) previous.focus()
    }
  }, [])

  useEffect(() => {
    const handleKey = (event: KeyboardEvent): void => {
      if (modalStack[modalStack.length - 1] !== tokenRef.current) return
      if (event.key === 'Escape' && !busyRef.current) {
        event.preventDefault()
        event.stopPropagation()
        onCloseRef.current()
        return
      }
      if (event.key === 'Tab') trapFocus(event, panelRef.current)
    }
    document.addEventListener('keydown', handleKey, true)
    return () => document.removeEventListener('keydown', handleKey, true)
  }, [])

  const content = (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <div
        ref={panelRef}
        className={['modal', className ?? ''].filter(Boolean).join(' ')}
        style={width ? { width } : undefined}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid={testId}
      >
        <header className="modal__header">
          {icon ? (
            <span className="modal__icon">
              <Icon name={icon} size={17} />
            </span>
          ) : null}
          <div className="modal__titles">
            <h2 className="modal__title">{title}</h2>
            {subtitle ? <p className="modal__subtitle">{subtitle}</p> : null}
          </div>
          {hideClose ? null : (
            <IconButton
              icon="x"
              label="Close dialog"
              shortcut="Esc"
              disabled={busy}
              onClick={() => onClose()}
              className="modal__close"
              testId="modal-close"
            />
          )}
        </header>
        <div className={['modal__body', bodyClassName ?? ''].filter(Boolean).join(' ')}>
          {children}
        </div>
        {footer ? <footer className="modal__footer">{footer}</footer> : null}
      </div>
    </div>
  )

  return createPortal(content, document.body)
}
