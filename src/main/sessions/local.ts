import os from 'node:os'
import path from 'node:path'
import * as pty from '@homebridge/node-pty-prebuilt-multiarch'
import type { IPty } from '@homebridge/node-pty-prebuilt-multiarch'
import type {
  LocalSessionRequest,
  SessionDescriptor,
  SessionKind,
  SessionStatus
} from '@shared/types'
import { AppError } from '../errors'
import { LocalBackend } from '../files/local-backend'
import type { FileBackend } from '../files/types'
import { prepareLocalShellLaunch, type LocalShellLaunch } from '../shell/integration'
import { DataBatcher } from '../util/batcher'
import { resolveDefaultShell, type ResolvedShell } from '../util/executable'
import type { Session, SessionEventSink } from './types'

export interface LocalSessionOptions {
  id: string
  request: LocalSessionRequest
  runtimeRoot: string
  emit: SessionEventSink
}

export class LocalSession implements Session {
  readonly id: string
  readonly kind: SessionKind = 'local'
  readonly backend: FileBackend = new LocalBackend()

  private readonly request: LocalSessionRequest
  private readonly runtimeRoot: string
  private readonly emit: SessionEventSink
  private shellProcess: IPty | null = null
  private shellLaunch: LocalShellLaunch | null = null
  private batcher: DataBatcher | null = null
  private status: SessionStatus = 'connecting'
  private cols: number
  private rows: number
  private disposed = false
  private shellLabel = 'Local'
  private generation = 0

  constructor(options: LocalSessionOptions) {
    this.id = options.id
    this.request = options.request
    this.runtimeRoot = options.runtimeRoot
    this.emit = options.emit
    this.cols = options.request.cols
    this.rows = options.request.rows
  }

  descriptor(): SessionDescriptor {
    return {
      id: this.id,
      kind: this.kind,
      title: this.shellLabel,
      status: this.status,
      pathStyle: this.backend.pathStyle,
      homePath: os.homedir()
    }
  }

  async start(): Promise<SessionDescriptor> {
    this.status = 'connecting'
    this.emitState()
    try {
      await this.spawnShell(this.request.shellPath)
      this.status = 'connected'
      this.emitState()
      return this.descriptor()
    } catch (error) {
      this.status = 'error'
      this.emitState(error)
      throw error
    }
  }

  private emitState(error?: unknown): void {
    this.emit({
      type: 'session:state',
      sessionId: this.id,
      status: this.status,
      title: this.shellLabel,
      ...(error
        ? {
            error:
              error instanceof AppError
                ? error.toPayload()
                : { code: 'SHELL_SPAWN_FAILED', message: (error as Error).message }
          }
        : {})
    })
  }

  private async spawnShell(requestedShell?: string): Promise<void> {
    const attempts: ResolvedShell[] = []
    const primary = resolveDefaultShell(
      process.platform as 'win32' | 'darwin' | 'linux',
      requestedShell
    )
    attempts.push(primary)
    if (requestedShell) {
      attempts.push(resolveDefaultShell(process.platform as 'win32' | 'darwin' | 'linux', null))
    }

    let lastError: unknown = null
    for (const shell of attempts) {
      try {
        await this.spawnWithShell(shell)
        return
      } catch (error) {
        lastError = error
        await this.disposeChild()
      }
    }
    throw new AppError(
      'SHELL_SPAWN_FAILED',
      `Could not start a shell: ${(lastError as Error)?.message ?? 'unknown error'}`
    )
  }

  private async spawnWithShell(shell: ResolvedShell): Promise<void> {
    const runtimeRoot = this.runtimeRoot
    const launch = await prepareLocalShellLaunch({
      shellPath: shell.path,
      kind: shell.integration ? shell.kind : 'other',
      runtimeRoot,
      sessionId: this.id
    })

    const cwd = this.pickCwd()
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === 'string') env[key] = value
    }
    Object.assign(env, {
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'TermShelf',
      ...launch.env
    })

    const child = pty.spawn(shell.path, launch.args, {
      name: 'xterm-256color',
      cols: Math.max(20, this.cols),
      rows: Math.max(5, this.rows),
      cwd,
      env
    })

    const generation = ++this.generation
    this.shellProcess = child
    this.shellLaunch = launch
    this.shellLabel = `Local · ${path.basename(shell.path)}`
    this.batcher?.dispose()
    const batcher = new DataBatcher((data) => {
      this.emit({ type: 'session:data', sessionId: this.id, data })
    })
    this.batcher = batcher

    child.onData((data) => {
      if (generation === this.generation) batcher.push(data)
    })
    child.onExit(() => {
      if (generation !== this.generation) return
      batcher.flush()
      this.shellProcess = null
      void this.cleanupLaunch()
      if (!this.disposed) {
        this.status = 'ended'
        this.emitState()
      }
    })
  }

  private pickCwd(): string {
    const requested = this.request.cwd
    if (requested) {
      try {
        if (path.isAbsolute(requested)) return requested
      } catch {
        // fall through to home
      }
    }
    return os.homedir()
  }

  write(data: string): void {
    if (this.disposed || this.status !== 'connected' || !this.shellProcess) return
    this.shellProcess.write(data)
  }

  resize(cols: number, rows: number): void {
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 2 || rows < 2) return
    this.cols = Math.trunc(cols)
    this.rows = Math.trunc(rows)
    if (this.shellProcess) {
      try {
        this.shellProcess.resize(this.cols, this.rows)
      } catch {
        // ignore resize races
      }
    }
  }

  async reconnect(): Promise<SessionDescriptor> {
    this.disposed = false
    this.status = 'connecting'
    this.emitState()
    await this.disposeChild()
    try {
      await this.spawnShell(this.request.shellPath ?? undefined)
      this.status = 'connected'
      this.emitState()
      return this.descriptor()
    } catch (error) {
      this.status = 'error'
      this.emitState(error)
      throw error
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.disposeChild()
    this.status = 'ended'
  }

  private async disposeChild(): Promise<void> {
    this.generation += 1
    this.batcher?.dispose()
    this.batcher = null
    const child = this.shellProcess
    this.shellProcess = null
    if (child) {
      try {
        child.kill()
      } catch {
        // already dead
      }
    }
    await this.cleanupLaunch()
  }

  private async cleanupLaunch(): Promise<void> {
    const launch = this.shellLaunch
    this.shellLaunch = null
    if (launch) {
      try {
        await launch.cleanup()
      } catch {
        // best effort
      }
    }
  }
}
