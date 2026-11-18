import type { ToastLevel } from '@shared/types'
import type { SliceCreator, ToastItem, UiSlice } from './types'

let toastCounter = 0
const toastTimers = new Map<string, number>()

export const createUiSlice: SliceCreator<UiSlice> = (set, get) => ({
  toasts: [],
  dialog: null,

  pushToast: (level: ToastLevel, message: string, options): void => {
    const id = `toast-${Date.now().toString(36)}-${++toastCounter}`
    const ttl = options?.ttl ?? (level === 'error' ? 8000 : level === 'warn' ? 6000 : 4500)
    const toast: ToastItem = { id, level, message, ttl, createdAt: Date.now() }
    set((state) => ({ toasts: [...state.toasts.slice(-4), toast] }))
    const timer = window.setTimeout(() => {
      toastTimers.delete(id)
      get().dismissToast(id)
    }, ttl)
    toastTimers.set(id, timer)
  },

  dismissToast: (id: string): void => {
    const timer = toastTimers.get(id)
    if (timer !== undefined) {
      window.clearTimeout(timer)
      toastTimers.delete(id)
    }
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }))
  },

  openDialog: (dialog): void => {
    set({ dialog })
  },

  closeDialog: (): void => {
    set({ dialog: null })
  },

  showSshDialog: (seed): void => {
    set({ dialog: { kind: 'ssh', seed: seed ?? {} } })
  },

  showSettingsDialog: (): void => {
    set({ dialog: { kind: 'settings' } })
  },

  showConfirm: (options): void => {
    set({ dialog: { kind: 'confirm', options } })
  },

  showPrompt: (options): void => {
    set({ dialog: { kind: 'prompt', options } })
  }
})
