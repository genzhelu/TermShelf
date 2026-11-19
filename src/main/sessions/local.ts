import os from 'node:os'
import path from 'node:path'
import * as pty from '@homebridge/node-pty-prebuilt-multiarch'
import type { IPty } from '@homebridge/node-pty-prebuilt-multiarch'
import type {
  LocalSessionRequest,
  SessionDescriptor,
  SessionEnvironment,
  SessionKind,
  SessionStatus
} from '@shared/types'
import { AppError } from '../errors'
import { LocalBackend } from '../files/local-backend'
import type { FileBackend } from '../files/types'
import { prepareLocalShellLaunch } from '../shell/integration'
import { DataBatcher } from '../util/batcher'
import { resolveDefaultShell, type ResolvedShell } from '../util/executable'
import type { Session, SessionEventSink } from './types'

/** A fully prepared local/WSL shell launch (used by the WSL backend). */
export interface CustomLocalLaunch {
  file: string
  args: string[]
  env?: Record<string, string>
  label: string
  cleanup: () => Promise<void>
}

export interface LocalSessionOptions {
  id: string
  request: LocalSessionRequest
  runtimeRoot: string
  emit: SessionEventSink
  /** When present, uses this launcher instead of the native shell resolver. */
  launch?: () => Promise<CustomLocalLaunch>
  backend?: FileBackend
  homePath?: string
  environment?: SessionEnvironment
  label?: string
  /** How long a custom (WSL) launch must stay alive before it is reported ready. */
  startupGraceMs?: number
}

export class LocalSession implements Session {
  readonly id: string
  readonly kind: SessionKind = 'local'
  private readonly backendInstance: FileBackend
  private readonly homePath: string
  private readonly environment: SessionEnvironment
  private readonly customLaunch: (() => Promise<CustomLocalLaunch>) | undefined

  private readonly request: LocalSessionRequest
  private readonly runtimeRoot: string
  private readonly emit: SessionEventSink
  private shellProcess: IPty | null = null
  private activeCleanup: (() => Promise<void>) | null = null
  private readonly cleanupPromises = new Set<Promise<void>>()
  private startupPending = false
  private startupOutput: string[] = []
  private readonly startupGraceMs: number
  private batcher: DataBatcher | null = null
  private status: SessionStatus = 'connecting'
  private cols: number
  private rows: number
  private disposed = false
  private shellLabel: string
  private generation = 0

  constructor(options: LocalSessionOptions) {
    this.id = options.id
    this.request = options.request
    this.runtimeRoot = options.runtimeRoot
    this.emit = options.emit
    this.cols = options.request.cols
    this.rows = options.request.rows
    this.backendInstance = options.backend ?? new LocalBackend()
    this.homePath = options.homePath ?? os.homedir()
    this.environment = options.environment ?? 'native'
    this.shellLabel = options.label ?? 'Local'
    this.customLaunch = options.launch
    this.startupGraceMs = options.startupGraceMs ?? 1500
  }

  get backend(): FileBackend {
    return this.backendInstance
  }

  descriptor(): SessionDescriptor {
    return {
      id: this.id,
      kind: this.kind,
      environment: this.environment,
      title: this.shellLabel,
      status: this.status,
      pathStyle: this.backendInstance.pathStyle,
      homePath: this.homePath
    }
  }

  async start(): Promise<SessionDescriptor> {
    this.status = 'connecting'
    this.emitState()
    try {
      if (this.customLaunch) await this.spawnCustom()
      else await this.spawnShell(this.request.shellPath)
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
    if (this.disposed) {
      await launch.cleanup().catch(() => undefined)
      throw new AppError('SHELL_SPAWN_FAILED', 'Session closed during startup')
    }

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

    let child: IPty
    try {
      child = pty.spawn(shell.path, launch.args, {
        name: 'xterm-256color',
        cols: Math.max(20, this.cols),
        rows: Math.max(5, this.rows),
        cwd,
        env
      })
    } catch (error) {
      try {
        await launch.cleanup()
      } catch {
        // best effort
      }
      throw error
    }
    this.attachChild(child, `Local · ${path.basename(shell.path)}`, launch.cleanup)
  }

  /** Spawns a launch prepared by the WSL backend (wsl.exe + generated init files). */
  private async spawnCustom(): Promise<void> {
    const launcher = this.customLaunch
    if (!launcher) return
    const launch = await launcher()
    if (this.disposed) {
      await launch.cleanup().catch(() => undefined)
      throw new AppError('SHELL_SPAWN_FAILED', 'Session closed during startup')
    }
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === 'string') env[key] = value
    }
    Object.assign(env, {
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'TermShelf',
      ...(launch.env ?? {})
    })
    let child: IPty
    this.startupPending = true
    this.startupOutput = []
    try {
      child = pty.spawn(launch.file, launch.args, {
        name: 'xterm-256color',
        cols: Math.max(20, this.cols),
        rows: Math.max(5, this.rows),
        env
      })
    } catch (error) {
      this.startupPending = false
      this.startupOutput = []
      try {
        await launch.cleanup()
      } catch {
        // best effort
      }
      throw error
    }
    this.attachChild(child, launch.label, launch.cleanup)
    await this.waitForStartup(child)
  }

  /**
   * wsl.exe can start successfully at the process level and then exit before
   * the shell is usable (bad --cd, missing shell, ConPTY failure). Give custom
   * launches a short grace period so those failures reach the native fallback
   * instead of being reported as a connected tab.
   */
  private async waitForStartup(child: IPty): Promise<void> {
    if (this.startupGraceMs > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.startupGraceMs)
        timer.unref?.()
      })
    }
    if (this.disposed) {
      this.discardStartupOutput()
      throw new AppError('SHELL_SPAWN_FAILED', 'Session closed during startup')
    }
    if (this.shellProcess !== child) {
      this.discardStartupOutput()
      throw new AppError('SHELL_SPAWN_FAILED', 'Shell exited during startup')
    }
    this.startupPending = false
    this.flushStartupOutput()
  }

  private flushStartupOutput(): void {
    if (this.startupOutput.length === 0) return
    const data = this.startupOutput.join('')
    this.startupOutput = []
    this.batcher?.push(data)
  }

  private discardStartupOutput(): void {
    this.startupPending = false
    this.startupOutput = []
  }

  private attachChild(child: IPty, label: string, cleanup: () => Promise<void>): void {
    const generation = ++this.generation
    this.shellProcess = child
    this.shellLabel = label
    this.activeCleanup = cleanup
    this.batcher?.dispose()
    const batcher = new DataBatcher((data) => {
      this.emit({ type: 'session:data', sessionId: this.id, data })
    })
    this.batcher = batcher

    child.onData((data) => {
      if (generation !== this.generation) return
      if (this.startupPending) {
        this.startupOutput.push(data)
      } else {
        batcher.push(data)
      }
    })
    child.onExit(() => {
      if (generation !== this.generation) return
      batcher.flush()
      this.shellProcess = null
      void this.cleanupLaunch()
      if (!this.disposed && !this.startupPending) {
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
      if (this.customLaunch) await this.spawnCustom()
      else await this.spawnShell(this.request.shellPath ?? undefined)
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
      // Windows node-pty defers kill() until a first data event. Nudge the
      // process while it is still in startup so a silent child cannot outlive
      // a closed tab.
      if (this.startupPending) {
        try {
          child.write('\x03')
        } catch {
          // best effort
        }
      }
      try {
        child.kill()
      } catch {
        // already dead
      }
    }
    await this.cleanupLaunch()
    if (this.cleanupPromises.size > 0) {
      await Promise.all([...this.cleanupPromises])
    }
  }

  private async cleanupLaunch(): Promise<void> {
    const cleanup = this.activeCleanup
    this.activeCleanup = null
    if (!cleanup) return
    const task = cleanup().catch(() => undefined)
    this.cleanupPromises.add(task)
    void task.finally(() => this.cleanupPromises.delete(task))
    await task
  }
}
