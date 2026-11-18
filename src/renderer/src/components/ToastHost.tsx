import type { ToastLevel } from '@shared/types'
import { useAppStore } from '../state/appStore'
import { Icon, type IconName } from './Icon'

const TOAST_ICONS: Record<ToastLevel, IconName> = {
  info: 'info',
  success: 'check-circle',
  warn: 'alert-triangle',
  error: 'x-circle'
}

export function ToastHost(): React.JSX.Element {
  const toasts = useAppStore((state) => state.toasts)
  const dismissToast = useAppStore((state) => state.dismissToast)
  const drawerOpen = useAppStore((state) => state.drawerOpen)
  const drawerHeight = useAppStore((state) => state.drawerHeight)

  return (
    <div
      className="toast-host"
      style={{ bottom: (drawerOpen ? drawerHeight : 34) + 14 }}
      role="status"
      aria-live="polite"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`toast toast--${toast.level}`}
          data-testid="toast"
          data-level={toast.level}
        >
          <span className="toast__icon">
            <Icon name={TOAST_ICONS[toast.level]} size={15} />
          </span>
          <span className="toast__message">{toast.message}</span>
          <button
            type="button"
            className="toast__close"
            aria-label="Dismiss notification"
            onClick={() => dismissToast(toast.id)}
          >
            <Icon name="x" size={12} />
          </button>
        </div>
      ))}
    </div>
  )
}
