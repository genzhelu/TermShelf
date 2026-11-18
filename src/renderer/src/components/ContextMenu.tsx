import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon, type IconName } from './Icon'

export interface MenuItem {
  id: string
  label?: string
  icon?: IconName
  shortcut?: string
  danger?: boolean
  disabled?: boolean
  separator?: boolean
  onSelect?: () => void
}

export interface ContextMenuProps {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
  /** Minimum menu width in pixels. */
  minWidth?: number
}

const VIEWPORT_PADDING = 8

export function ContextMenu({
  x,
  y,
  items,
  onClose,
  minWidth = 200
}: ContextMenuProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: x, top: y })

  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    const rect = node.getBoundingClientRect()
    const maxLeft = window.innerWidth - rect.width - VIEWPORT_PADDING
    const maxTop = window.innerHeight - rect.height - VIEWPORT_PADDING
    setPosition({
      left: Math.max(VIEWPORT_PADDING, Math.min(x, maxLeft)),
      top: Math.max(VIEWPORT_PADDING, Math.min(y, maxTop))
    })
  }, [x, y, items.length])

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent): void => {
      if (!ref.current) return
      if (!ref.current.contains(event.target as Node)) onClose()
    }
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }
    }
    const handleViewportChange = (): void => onClose()
    window.addEventListener('mousedown', handlePointerDown, true)
    window.addEventListener('keydown', handleKey, true)
    window.addEventListener('resize', handleViewportChange)
    window.addEventListener('blur', handleViewportChange)
    window.addEventListener('scroll', handleViewportChange, true)
    return () => {
      window.removeEventListener('mousedown', handlePointerDown, true)
      window.removeEventListener('keydown', handleKey, true)
      window.removeEventListener('resize', handleViewportChange)
      window.removeEventListener('blur', handleViewportChange)
      window.removeEventListener('scroll', handleViewportChange, true)
    }
  }, [onClose])

  return createPortal(
    <div
      ref={ref}
      className="context-menu"
      style={{ left: position.left, top: position.top, minWidth }}
      role="menu"
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item) =>
        item.separator ? (
          <div key={item.id} className="context-menu__separator" role="separator" />
        ) : (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            className={['context-menu__item', item.danger ? 'is-danger' : '']
              .filter(Boolean)
              .join(' ')}
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return
              onClose()
              item.onSelect?.()
            }}
          >
            <span className="context-menu__icon">
              {item.icon ? <Icon name={item.icon} size={14} /> : null}
            </span>
            <span className="context-menu__label">{item.label}</span>
            {item.shortcut ? <span className="context-menu__shortcut">{item.shortcut}</span> : null}
          </button>
        )
      )}
    </div>,
    document.body
  )
}
