import { create } from 'zustand'
import { createConfigSlice } from './configSlice'
import { createFileSlice } from './fileSlice'
import { createSessionSlice } from './sessionSlice'
import { createTransferSlice } from './transferSlice'
import { createUiSlice } from './uiSlice'
import type { AppStore } from './types'

export const useAppStore = create<AppStore>()((set, get, api) => ({
  ...createConfigSlice(set, get, api),
  ...createSessionSlice(set, get, api),
  ...createFileSlice(set, get, api),
  ...createTransferSlice(set, get, api),
  ...createUiSlice(set, get, api),

  handleEvent: (event): void => {
    switch (event.type) {
      case 'session:state':
        get().handleSessionState(event)
        break
      case 'transfer:update':
        get().handleTransferUpdate(event.job)
        break
      case 'toast':
        get().pushToast(event.level, event.message)
        break
      case 'session:data':
        // Terminal output is routed directly to xterm by the App event bridge.
        break
      default:
        break
    }
  }
}))

export type { AppStore }
