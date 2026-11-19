import crypto from 'node:crypto'
import type { LocalSessionRequest, SessionDescriptor, SshConnectRequest } from '@shared/types'
import { AppError } from '../errors'
import type { FileBackend } from '../files/types'
import { WslBackend } from '../files/wsl-backend'
import type { ConfigStore } from '../store/types'
import { prepareWslShellLaunch } from '../wsl/launch'
import type { WslService } from '../wsl/service'
import { LocalSession } from './local'
import { SshSession } from './ssh'
import type { Session, SessionEventSink } from './types'

export class SessionManager {
  private readonly sessions = new Map<string, Session>()
  private wslFallbackNotified = false

  constructor(
    private readonly store: ConfigStore,
    private readonly emitEvent: SessionEventSink,
    private readonly runtimeRoot: string,
    private readonly wsl: WslService,
    private readonly platform: NodeJS.Platform = process.platform
  ) {}

  async createLocal(request: LocalSessionRequest): Promise<SessionDescriptor> {
    const settings = this.store.getSettings()
    const mode = request.terminal ?? settings.localTerminal
    const distro = request.wslDistro !== undefined ? request.wslDistro : settings.wslDistro
    const shellPath = request.shellPath ?? settings.shellPath ?? undefined

    // Auto honours an explicitly configured native shell; WSL is only attempted
    // on Windows. Explicit WSL still falls back to native (with a warning) so a
    // broken/stopped WSL installation never leaves the app without a terminal.
    const wantsWsl =
      this.platform === 'win32' && (mode === 'wsl' || (mode === 'auto' && !shellPath))

    if (wantsWsl) {
      const info = await this.wsl.info()
      if (info.available) {
        try {
          return await this.createWslSession(request, distro ?? null)
        } catch (error) {
          this.notifyWslFallback(
            `WSL terminal unavailable (${messageOf(error)}); using the native shell instead.`
          )
        }
      } else if (mode === 'wsl') {
        this.notifyWslFallback(
          `WSL is unavailable (${info.error ?? 'no distributions found'}); using the native shell instead.`
        )
      }
    }

    return this.createNativeSession(request)
  }

  private notifyWslFallback(message: string): void {
    if (this.wslFallbackNotified) return
    this.wslFallbackNotified = true
    this.emitEvent({ type: 'toast', level: 'warn', message })
  }

  private async createNativeSession(request: LocalSessionRequest): Promise<SessionDescriptor> {
    const id = crypto.randomUUID()
    const session = new LocalSession({
      id,
      request,
      runtimeRoot: this.runtimeRoot,
      emit: this.emitEvent,
      label: 'Local'
    })
    const descriptor = await session.start()
    this.sessions.set(id, session)
    return descriptor
  }

  private async createWslSession(
    request: LocalSessionRequest,
    distro: string | null
  ): Promise<SessionDescriptor> {
    const id = crypto.randomUUID()
    const context = await this.wsl.resolveContext(distro)
    const session = new LocalSession({
      id,
      request,
      runtimeRoot: this.runtimeRoot,
      emit: this.emitEvent,
      environment: 'wsl',
      backend: new WslBackend(context.uncRoot, context.homePath),
      homePath: context.homePath,
      label: `WSL · ${context.distro}`,
      launch: () => prepareWslShellLaunch({ service: this.wsl, context, sessionId: id })
    })
    try {
      const descriptor = await session.start()
      this.sessions.set(id, session)
      return descriptor
    } catch (error) {
      await session.dispose()
      throw error
    }
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

function messageOf(error: unknown): string {
  if (error instanceof AppError) return error.message
  if (error instanceof Error) return error.message
  return 'unknown error'
}
