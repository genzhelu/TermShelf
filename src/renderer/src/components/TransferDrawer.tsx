import { useMemo } from 'react'
import type { TransferJob } from '@shared/types'
import { errorMessage, getApi, safeCall } from '../lib/api'
import {
  formatBytes,
  formatDuration,
  formatRate,
  percent,
  pluralize,
  truncateMiddle
} from '../lib/format'
import { useAppStore } from '../state/appStore'
import { Icon } from './Icon'

const STATE_LABELS: Record<TransferJob['state'], string> = {
  scanning: 'Scanning',
  running: 'Transferring',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled'
}

function isActiveJob(job: TransferJob): boolean {
  return job.state === 'scanning' || job.state === 'running'
}

export function TransferDrawer(): React.JSX.Element {
  const jobs = useAppStore((state) => state.jobs)
  const drawerOpen = useAppStore((state) => state.drawerOpen)
  const drawerHeight = useAppStore((state) => state.drawerHeight)
  const toggleDrawer = useAppStore((state) => state.toggleDrawer)
  const setDrawerHeight = useAppStore((state) => state.setDrawerHeight)
  const persistUi = useAppStore((state) => state.persistUi)
  const cancelJob = useAppStore((state) => state.cancelJob)
  const cancelActiveJobs = useAppStore((state) => state.cancelActiveJobs)
  const clearCompleted = useAppStore((state) => state.clearCompleted)
  const pushToast = useAppStore((state) => state.pushToast)

  const activeJobs = useMemo(() => jobs.filter(isActiveJob), [jobs])
  const finishedJobs = useMemo(() => jobs.filter((job) => !isActiveJob(job)), [jobs])

  const totals = useMemo(() => {
    let done = 0
    let total = 0
    for (const job of activeJobs) {
      done += job.bytesDone
      total += job.bytesTotal
    }
    return {
      done,
      total,
      pct: total > 0 ? percent(done, total) : null,
      files: activeJobs.reduce((sum, job) => sum + job.filesTotal, 0)
    }
  }, [activeJobs])

  const startResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!drawerOpen) return
    event.preventDefault()
    const startY = event.clientY
    const startHeight = drawerHeight
    document.body.classList.add('is-resizing')
    const move = (moveEvent: PointerEvent): void => {
      setDrawerHeight(startHeight + (startY - moveEvent.clientY))
    }
    const up = (): void => {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', up)
      document.body.classList.remove('is-resizing')
      persistUi()
    }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', up)
  }

  const showInFolder = async (job: TransferJob): Promise<void> => {
    const result = await safeCall(() => getApi().app.showItemInFolder(job.destDir))
    if (!result.ok) pushToast('error', `Could not open folder — ${errorMessage(result.error)}`)
  }

  return (
    <section
      className={drawerOpen ? 'transfer-drawer is-open' : 'transfer-drawer is-collapsed'}
      style={drawerOpen ? { height: drawerHeight } : undefined}
      data-testid="transfer-drawer"
      aria-label="Transfers"
    >
      {drawerOpen ? (
        <div
          className="transfer-drawer__resizer"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize transfers drawer"
          onPointerDown={startResize}
        />
      ) : null}

      <header className="transfer-drawer__header">
        <button
          type="button"
          className="transfer-drawer__toggle"
          onClick={toggleDrawer}
          aria-expanded={drawerOpen}
          title={drawerOpen ? 'Collapse transfers' : 'Expand transfers'}
        >
          <Icon name={drawerOpen ? 'chevron-down' : 'chevron-up'} size={14} />
          <span className="transfer-drawer__title">Transfers</span>
          {activeJobs.length > 0 ? (
            <span className="badge badge--accent">{activeJobs.length} active</span>
          ) : null}
          {finishedJobs.length > 0 ? (
            <span className="badge">{finishedJobs.length} finished</span>
          ) : null}
        </button>

        <div className="transfer-drawer__summary">
          {activeJobs.length > 0 ? (
            <>
              <span className="transfer-drawer__summary-text">
                {formatBytes(totals.done)} of {formatBytes(totals.total)}
                {totals.files > 0 ? ` · ${totals.files} ${pluralize(totals.files, 'file')}` : ''}
              </span>
              <span className="progress progress--inline" aria-hidden="true">
                <span
                  className={
                    totals.pct === null ? 'progress__bar is-indeterminate' : 'progress__bar'
                  }
                  style={totals.pct === null ? undefined : { width: `${totals.pct}%` }}
                />
              </span>
            </>
          ) : (
            <span className="transfer-drawer__summary-text is-idle">
              {jobs.length === 0 ? 'No transfers yet' : `${jobs.length} finished`}
            </span>
          )}
        </div>

        <div className="transfer-drawer__actions">
          {activeJobs.length > 0 ? (
            <button type="button" className="btn btn--xs" onClick={() => void cancelActiveJobs()}>
              <Icon name="x-circle" size={12} /> Cancel all
            </button>
          ) : null}
          {finishedJobs.length > 0 ? (
            <button type="button" className="btn btn--xs btn--ghost" onClick={clearCompleted}>
              <Icon name="trash" size={12} /> Clear completed
            </button>
          ) : null}
        </div>
      </header>

      {drawerOpen ? (
        <div className="transfer-drawer__body">
          {jobs.length === 0 ? (
            <div className="transfer-empty">
              <Icon name="inbox" size={22} />
              <p>No transfers yet</p>
              <span>
                Upload files by dragging them onto the file browser, or download a selection.
              </span>
            </div>
          ) : (
            <ul className="transfer-list">
              {jobs.map((job) => (
                <TransferJobRow
                  key={job.id}
                  job={job}
                  onCancel={() => void cancelJob(job.id)}
                  onShowInFolder={() => void showInFolder(job)}
                />
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  )
}

function TransferJobRow({
  job,
  onCancel,
  onShowInFolder
}: {
  job: TransferJob
  onCancel: () => void
  onShowInFolder: () => void
}): React.JSX.Element {
  const active = isActiveJob(job)
  const pct = job.bytesTotal > 0 ? percent(job.bytesDone, job.bytesTotal) : null
  const elapsed = (job.finishedAt ?? Date.now()) - job.startedAt

  return (
    <li
      className={`transfer-job transfer-job--${job.state}`}
      data-testid="transfer-job"
      data-state={job.state}
      data-job-id={job.id}
      data-direction={job.direction}
    >
      <span className={`transfer-job__direction transfer-job__direction--${job.direction}`}>
        <Icon name={job.direction === 'upload' ? 'upload' : 'download'} size={14} />
      </span>

      <div className="transfer-job__main">
        <div className="transfer-job__headline">
          <span className="transfer-job__label">{job.label}</span>
          <span className={`transfer-job__state transfer-job__state--${job.state}`}>
            {STATE_LABELS[job.state]}
          </span>
          <span className="transfer-job__time">
            {active
              ? formatRate(job.bytesDone, Math.max(1, Date.now() - job.startedAt))
              : formatDuration(elapsed)}
          </span>
        </div>

        <div className="transfer-job__progress-row">
          <span className="progress">
            <span
              className={[
                'progress__bar',
                pct === null && active ? 'is-indeterminate' : '',
                job.state === 'completed' ? 'is-complete' : '',
                job.state === 'failed' ? 'is-failed' : '',
                job.state === 'cancelled' ? 'is-cancelled' : ''
              ]
                .filter(Boolean)
                .join(' ')}
              style={pct === null ? undefined : { width: `${pct}%` }}
            />
          </span>
          <span className="transfer-job__bytes">
            {formatBytes(job.bytesDone)}
            {job.bytesTotal > 0 ? ` / ${formatBytes(job.bytesTotal)}` : ''}
          </span>
        </div>

        <div className="transfer-job__meta">
          <span className="transfer-job__destination" title={job.destDir}>
            <Icon name="folder" size={11} /> {truncateMiddle(job.destDir, 48)}
          </span>
          <span>
            {job.filesDone}/{job.filesTotal} {pluralize(job.filesTotal, 'file')}
          </span>
          {active && job.currentFile ? (
            <span className="transfer-job__current" title={job.currentFile}>
              {truncateMiddle(job.currentFile, 56)}
            </span>
          ) : null}
          {job.error ? (
            <span className="transfer-job__error" title={job.error.message}>
              <Icon name="alert-circle" size={11} /> {errorMessage(job.error)}
            </span>
          ) : null}
        </div>
      </div>

      <div className="transfer-job__actions">
        {active ? (
          <button
            type="button"
            className="icon-button icon-button--ghost"
            title="Cancel transfer"
            aria-label="Cancel transfer"
            data-testid="cancel-transfer-button"
            onClick={onCancel}
          >
            <Icon name="x-circle" size={14} />
          </button>
        ) : null}
        {!active && job.direction === 'download' ? (
          <button
            type="button"
            className="icon-button icon-button--ghost"
            title="Show destination folder"
            aria-label="Show destination folder"
            onClick={onShowInFolder}
          >
            <Icon name="folder-open" size={14} />
          </button>
        ) : null}
      </div>
    </li>
  )
}
