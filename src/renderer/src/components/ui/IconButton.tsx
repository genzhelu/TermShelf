import type { MouseEvent } from 'react'
import { Icon, type IconName } from '../Icon'

export type IconButtonVariant = 'ghost' | 'accent' | 'danger' | 'subtle'

export interface IconButtonProps {
  icon: IconName
  label: string
  shortcut?: string
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void
  disabled?: boolean
  active?: boolean
  size?: number
  variant?: IconButtonVariant
  className?: string
  type?: 'button' | 'submit'
  testId?: string
}

export function IconButton({
  icon,
  label,
  shortcut,
  onClick,
  disabled = false,
  active = false,
  size = 15,
  variant = 'ghost',
  className,
  type = 'button',
  testId
}: IconButtonProps): React.JSX.Element {
  const classes = [
    'icon-button',
    `icon-button--${variant}`,
    active ? 'is-active' : '',
    className ?? ''
  ]
    .filter(Boolean)
    .join(' ')
  const title = shortcut ? `${label} (${shortcut})` : label
  return (
    <button
      type={type}
      className={classes}
      title={title}
      aria-label={label}
      aria-pressed={active || undefined}
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
    >
      <Icon name={icon} size={size} />
    </button>
  )
}
