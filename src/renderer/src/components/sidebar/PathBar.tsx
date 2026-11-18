import { useMemo, useRef, useState } from 'react'
import type { Breadcrumb, DirListing, PathStyle } from '@shared/types'
import { breadcrumbsFromPath, isAbsolutePath } from '../../lib/paths'
import { useAppStore } from '../../state/appStore'
import { Icon } from '../Icon'

export interface PathBarProps {
  sessionId: string
  pathStyle: PathStyle
  path: string | null
  listing: DirListing | null
  loading: boolean
}

const MAX_VISIBLE_CRUMBS = 3

export function PathBar({
  sessionId,
  pathStyle,
  path,
  listing,
  loading
}: PathBarProps): React.JSX.Element {
  const navigateTo = useAppStore((state) => state.navigateTo)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const crumbs = useMemo<Breadcrumb[]>(() => {
    if (listing && listing.breadcrumbs.length > 0) return listing.breadcrumbs
    if (!path) return []
    return breadcrumbsFromPath(pathStyle, path)
  }, [listing, path, pathStyle])

  const visible = useMemo(() => {
    if (crumbs.length <= MAX_VISIBLE_CRUMBS) return { leading: null, trailing: crumbs }
    return {
      leading: crumbs[0] ?? null,
      trailing: crumbs.slice(-(MAX_VISIBLE_CRUMBS - 1))
    }
  }, [crumbs])

  const beginEdit = (): void => {
    setDraft(path ?? '')
    setError(null)
    setEditing(true)
    window.requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
  }

  const cancelEdit = (): void => {
    setEditing(false)
    setError(null)
  }

  const commitEdit = (): void => {
    const value = draft.trim()
    if (!value) {
      setError('Path cannot be empty')
      return
    }
    if (!isAbsolutePath(pathStyle, value)) {
      setError(`Enter an absolute ${pathStyle === 'win32' ? 'Windows' : 'POSIX'} path`)
      return
    }
    setEditing(false)
    setError(null)
    void navigateTo(sessionId, value)
  }

  return (
    <div className={error ? 'pathbar pathbar--error' : 'pathbar'}>
      {editing ? (
        <div className="pathbar__editing">
          <Icon name="folder-open" size={13} className="pathbar__leading-icon" />
          <input
            ref={inputRef}
            className="pathbar__input"
            value={draft}
            spellCheck={false}
            autoComplete="off"
            aria-label="Path"
            data-testid="path-input"
            onChange={(event) => {
              setDraft(event.target.value)
              setError(null)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                commitEdit()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                cancelEdit()
              }
            }}
            onBlur={() => {
              if (editing) cancelEdit()
            }}
          />
          {loading ? <Icon name="loader" size={13} className="spin pathbar__spinner" /> : null}
          <span className="pathbar__error-text" role="alert">
            {error ?? ''}
          </span>
        </div>
      ) : (
        <>
          <div className="pathbar__crumbs" onDoubleClick={beginEdit} title={path ?? ''}>
            {loading ? <Icon name="loader" size={12} className="spin pathbar__spinner" /> : null}
            {visible.leading ? (
              <>
                <button
                  type="button"
                  className="pathbar__crumb pathbar__crumb--first"
                  onClick={() => void navigateTo(sessionId, visible.leading?.path ?? '')}
                  title={visible.leading.path}
                >
                  {visible.leading.name}
                </button>
                <span className="pathbar__sep" aria-hidden="true">
                  <Icon name="chevron-right" size={11} />
                </span>
                <button
                  type="button"
                  className="pathbar__ellipsis"
                  onClick={beginEdit}
                  title={path ?? 'Edit path'}
                  aria-label="Edit full path"
                >
                  …
                </button>
                <span className="pathbar__sep" aria-hidden="true">
                  <Icon name="chevron-right" size={11} />
                </span>
              </>
            ) : null}
            {visible.trailing.map((crumb, index) => {
              const isCurrent = index === visible.trailing.length - 1
              return (
                <span key={crumb.path} className="pathbar__segment">
                  <button
                    type="button"
                    className={isCurrent ? 'pathbar__crumb is-current' : 'pathbar__crumb'}
                    onClick={() => void navigateTo(sessionId, crumb.path)}
                    aria-current={isCurrent ? 'page' : undefined}
                    title={crumb.path}
                  >
                    {crumb.name}
                  </button>
                  {isCurrent ? null : (
                    <span className="pathbar__sep" aria-hidden="true">
                      <Icon name="chevron-right" size={11} />
                    </span>
                  )}
                </span>
              )
            })}
          </div>
          <button
            type="button"
            className="pathbar__edit"
            onClick={beginEdit}
            title="Edit path (double-click the path bar)"
            aria-label="Edit path"
          >
            <Icon name="pencil" size={11} />
          </button>
        </>
      )}
    </div>
  )
}
