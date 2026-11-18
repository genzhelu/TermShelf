import { memo, type CSSProperties, type MouseEvent } from 'react'
import type { FileEntry } from '@shared/types'
import { formatBytes, formatDate, formatDateTime } from '../../lib/format'
import { Icon, type IconName } from '../Icon'

export interface FileRowProps {
  entry: FileEntry
  index: number
  selected: boolean
  dropTarget: boolean
  style: CSSProperties
  onClick: (event: MouseEvent<HTMLDivElement>) => void
  onDoubleClick: () => void
  onContextMenu: (event: MouseEvent<HTMLDivElement>) => void
}

function iconFor(entry: FileEntry): IconName {
  if (entry.kind === 'dir') return 'folder'
  if (entry.kind === 'symlink') return 'link'
  return 'file'
}

function FileRowInner({
  entry,
  index,
  selected,
  dropTarget,
  style,
  onClick,
  onDoubleClick,
  onContextMenu
}: FileRowProps): React.JSX.Element {
  const isDir = entry.kind === 'dir'
  const classes = [
    'file-row',
    `file-row--${entry.kind}`,
    selected ? 'is-selected' : '',
    dropTarget ? 'is-drop-target' : '',
    entry.kind === 'dir' ? 'is-dir' : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      className={classes}
      style={style}
      role="row"
      aria-rowindex={index + 1}
      aria-selected={selected}
      data-drop-dir={isDir ? entry.path : undefined}
      data-testid="file-row"
      data-name={entry.name}
      data-kind={entry.kind}
      title={entry.symlinkTarget ? `${entry.path} → ${entry.symlinkTarget}` : entry.path}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
      <div className="file-row__name" role="gridcell">
        <span className={isDir ? 'file-row__icon is-dir' : 'file-row__icon'}>
          <Icon name={iconFor(entry)} size={14} />
        </span>
        <span className="file-row__label">{entry.name}</span>
        {entry.symlinkTarget ? (
          <span className="file-row__symlink-target">→ {entry.symlinkTarget}</span>
        ) : null}
      </div>
      <div className="file-row__size" role="gridcell">
        {isDir ? '—' : formatBytes(entry.size)}
      </div>
      <div className="file-row__mtime" role="gridcell" title={formatDateTime(entry.mtimeMs)}>
        {formatDate(entry.mtimeMs)}
      </div>
    </div>
  )
}

export const FileRow = memo(FileRowInner)
