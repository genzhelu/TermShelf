import crypto from 'node:crypto'
import type { LocalSessionRequest, SessionDescriptor, SshConnectRequest } from '@shared/types'
import { AppError } from '../errors'
import type { FileBackend } from '../files/types'
import type { ConfigStore } from '../store/types'
import { LocalSession } from './local'
import { SshSession } from './ssh'
import type { Session, SessionEventSink } from './types'

export class SessionManager {
  private readonly sessions = new Map<string, Session>()

  constructor(
    private readonly store: ConfigStore,
    private readonly emitEvent: SessionEventSink,
    private readonly runtimeRoot: string
  ) {}

  async createLocal(request: LocalSessionRequest): Promise<SessionDescriptor> {
    const id = crypto.randomUUID()
    const session = new LocalSession({
      id,
      request,
      runtimeRoot: this.runtimeRoot,
      emit: this.emitEvent
    })
    const descriptor = await session.start()
    this.sessions.set(id, session)
    return descriptor
  }

  async createSsh(request: SshConnectRequest): Promise<SessionDescriptor> {
    const id = crypto.randomUUID()
    const session = new SshSession({
      id,
      request,
      store: this.store,
      emit: this.emitEvent
    })
    const descriptor = await session.start()
    this.sessions.set(id, session)
    return descriptor
  }

  getBackend(sessionId: string): FileBackend {
    const session = this.sessions.get(sessionId)
    if (!session) throw new AppError('INVALID_ARGUMENT', 'Session not found or already closed')
    return session.backend
  }

  write(sessionId: string, data: string): void {
    this.sessions.get(sessionId)?.write(data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.sessions.get(sessionId)?.resize(cols, rows)
  }

  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.sessions.delete(sessionId)
    await session.dispose()
  }

  async reconnect(sessionId: string): Promise<SessionDescriptor> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new AppError('INVALID_ARGUMENT', 'Session not found or already closed')
    return session.reconnect()
  }

  async disposeAll(): Promise<void> {
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(
      sessions.map(async (session) => {
        try {
          await session.dispose()
        } catch {
          // best effort on shutdown
        }
      })
    )
  }
}
