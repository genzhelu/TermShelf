import { Icon } from '../Icon'

export interface DropOverlayProps {
  count: number
  destination: string
  targetLabel: string | null
}

export function DropOverlay({
  count,
  destination,
  targetLabel
}: DropOverlayProps): React.JSX.Element {
  return (
    <div className="drop-overlay" data-testid="drop-overlay" role="status">
      <div className="drop-overlay__card">
        <span className="drop-overlay__icon">
          <Icon name="upload" size={26} />
        </span>
        <strong className="drop-overlay__title">Drop to upload</strong>
        <span className="drop-overlay__destination">
          {targetLabel ? (
            <>
              <Icon name="folder" size={12} /> {targetLabel}
            </>
          ) : (
            <span title={destination}>{destination}</span>
          )}
        </span>
        {count > 0 ? (
          <span className="drop-overlay__count">
            {count} {count === 1 ? 'item' : 'items'}
          </span>
        ) : null}
      </div>
    </div>
  )
}
