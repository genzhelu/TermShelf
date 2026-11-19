import type { TransferJob, TransferRequest, TransferStartResult } from '@shared/types'
import { errorMessage, getApi, safeCall } from '../lib/api'
import { clampDrawerHeight, DEFAULT_UI } from './defaults'
import type { SliceCreator, TransferSlice } from './types'

const ACTIVE_STATES = new Set<TransferJob['state']>(['scanning', 'running'])

export function isJobActive(job: TransferJob): boolean {
  return ACTIVE_STATES.has(job.state)
}

export const createTransferSlice: SliceCreator<TransferSlice> = (set, get) => ({
  jobs: [],
  drawerOpen: false,
  drawerHeight: DEFAULT_UI.transferDrawerHeight,

  loadTransfers: async (): Promise<void> => {
    const result = await safeCall(() => getApi().transfers.list())
    if (!result.ok) return
    const jobs = [...result.data].sort((a, b) => b.startedAt - a.startedAt)
    set({ jobs })
    if (jobs.some((job) => ACTIVE_STATES.has(job.state))) set({ drawerOpen: true })
  },

  startTransfer: async (request: TransferRequest): Promise<TransferStartResult | null> => {
    const result = await safeCall(() => getApi().transfers.start(request))
    if (!result.ok) {
      get().pushToast('error', `Could not start transfer — ${errorMessage(result.error)}`)
      return null
    }
    const value = result.data
    if (value.status === 'invalid') {
      get().pushToast('error', `Transfer not started — ${value.message}`)
      return value
    }
    if (value.status === 'conflicts') {
      get().openDialog({ kind: 'conflict', request, conflicts: value.conflicts })
      return value
    }
    get().handleTransferUpdate(value.job)
    get().setDrawerOpen(true)
    if (value.job.state === 'scanning' || value.job.state === 'running') {
      const verb = request.direction === 'upload' ? 'Upload started' : 'Download started'
      get().pushToast('success', `${verb} — ${value.job.label}`)
    }
    return value
  },

  resolveConflict: async (policy): Promise<void> => {
    const dialog = get().dialog
    if (!dialog || dialog.kind !== 'conflict') return
    get().closeDialog()
    if (policy === 'cancel') {
      get().pushToast('info', 'Transfer cancelled')
      return
    }
    await get().startTransfer({ ...dialog.request, conflictPolicy: policy })
  },

  cancelJob: async (jobId: string): Promise<void> => {
    const job = get().jobs.find((candidate) => candidate.id === jobId)
    const result = await safeCall(() => getApi().transfers.cancel({ jobId }))
    if (!result.ok) {
      get().pushToast('error', `Could not cancel transfer — ${errorMessage(result.error)}`)
      return
    }
    get().pushToast('info', `Cancelling ${job?.label ?? 'transfer'}…`)
  },

  cancelActiveJobs: async (): Promise<void> => {
    const active = get().jobs.filter((job) => ACTIVE_STATES.has(job.state))
    if (active.length === 0) return
    await Promise.all(
      active.map((job) => safeCall(() => getApi().transfers.cancel({ jobId: job.id })))
    )
    get().pushToast(
      'info',
      `Cancelling ${active.length} transfer${active.length === 1 ? '' : 's'}…`
    )
  },

  clearCompleted: (): void => {
    set((state) => ({ jobs: state.jobs.filter((job) => ACTIVE_STATES.has(job.state)) }))
  },

  setDrawerOpen: (open: boolean): void => {
    set({ drawerOpen: open })
  },

  toggleDrawer: (): void => {
    set((state) => ({ drawerOpen: !state.drawerOpen }))
  },

  setDrawerHeight: (height: number): void => {
    const next = clampDrawerHeight(height)
    set({ drawerHeight: next })
    get().updateUi({ transferDrawerHeight: next })
  },

  handleTransferUpdate: (job: TransferJob): void => {
    const existing = get().jobs.find((candidate) => candidate.id === job.id)
    set((state) => {
      const index = state.jobs.findIndex((candidate) => candidate.id === job.id)
      if (index === -1) return { jobs: [job, ...state.jobs] }
      const jobs = [...state.jobs]
      jobs[index] = job
      return { jobs }
    })

    if (!existing && ACTIVE_STATES.has(job.state)) set({ drawerOpen: true })
    if (existing?.state === job.state) return
    if (job.state === 'completed') {
      get().pushToast('success', `Transfer complete — ${job.label}`)
      // Refresh the affected explorer so new files appear without a manual F5.
      // Uploads live in the session's file view; downloads land on the local
      // filesystem, so any local tab showing that folder should refresh too.
      if (job.direction === 'upload') {
        void get().refreshFiles(job.sessionId, { silent: true })
      } else {
        for (const tab of get().tabs) {
          // Downloads land on the Windows/macOS filesystem; WSL views use a
          // different path space and must not be refreshed with a local path.
          if (
            tab.kind === 'local' &&
            tab.environment === 'native' &&
            get().fileViews[tab.id]?.path
          ) {
            void get().refreshFiles(tab.id, { silent: true })
          }
        }
      }
    } else if (job.state === 'failed') {
      const detail = job.error ? errorMessage(job.error) : 'Unknown error'
      get().pushToast('error', `Transfer failed — ${detail}`)
    }
  }
})
