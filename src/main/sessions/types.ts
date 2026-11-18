import type { AppErrorPayload, AppEvent, SessionDescriptor, SessionKind } from '@shared/types'
import type { FileBackend } from '../files/types'

export type SessionEventSink = (event: AppEvent) => void

export interface Session {
  readonly id: string
  readonly kind: SessionKind
  readonly backend: FileBackend
  descriptor(): SessionDescriptor
  write(data: string): void
  resize(cols: number, rows: number): void
  reconnect(): Promise<SessionDescriptor>
  dispose(): Promise<void>
}

export interface SessionManagerOptions {
  emit: SessionEventSink
}

export function emitState(
  emit: SessionEventSink,
  descriptor: SessionDescriptor,
  extra?: { title?: string; error?: AppErrorPayload }
): void {
  emit({
    type: 'session:state',
    sessionId: descriptor.id,
    status: descriptor.status,
    ...(extra?.title ? { title: extra.title } : {}),
    ...(extra?.error ? { error: extra.error } : {})
  })
}
