import type { TermshelfApi } from '@shared/ipc-contract'

declare global {
  interface Window {
    /** Exposed by the preload script (see src/preload/index.ts). */
    termshelf: TermshelfApi
  }
}

export {}
