import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Writable } from 'node:stream'
import type {
  ConflictPolicy,
  FileEntry,
  TransferConflict,
  TransferJob,
  TransferRequest,
  TransferStartResult
} from '@shared/types'
import { AppError, toErrorPayload } from '../errors'
import type { FileBackend } from '../files/types'
import type { SessionEventSink } from '../sessions/types'
import {
  basenamePath,
  dirnamePath,
  joinPath,
  nextAvailableName,
  sanitizeLocalFilename,
  splitNameExtension
} from '../util/paths'

interface PlanEntry {
  sourcePath: string
  destinationPath: string
  kind: 'dir' | 'file'
  size: number
  mtimeMs: number
  mode?: number
}

interface PlannedTopItem {
  sourceName: string
  sourcePath: string
  destinationPath: string
  kind: 'dir' | 'file'
  entries: PlanEntry[]
}

interface Plan {
  topItems: PlannedTopItem[]
  bytesTotal: number
  filesTotal: number
}

interface MutableJob extends TransferJob {
  cancelled: boolean
  lastEmit: number
  failures: string[]
  abort: AbortController
}

type LocalPlatform = 'win32' | 'darwin' | 'linux'

const MAX_PLAN_ENTRIES = 50_000
const PROGRESS_INTERVAL_MS = 120
const MAX_RETAINED_JOBS = 60

export interface TransferEngineOptions {
  getBackend: (sessionId: string) => FileBackend
  emit: SessionEventSink
}

function isNotFoundError(error: unknown): boolean {
  if (error instanceof AppError) return error.code === 'FS_NOT_FOUND'
  const code = (error as NodeJS.ErrnoException)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function toTransferMessage(error: unknown): string {
  const payload = toErrorPayload(error, 'TRANSFER_FAILED')
  return payload.message
}

function writeStreamFor(
  direction: 'upload' | 'download',
  backend: FileBackend,
  tempPath: string
): Writable {
  return direction === 'upload'
    ? backend.createWriteStream(tempPath)
    : fs.createWriteStream(tempPath, { highWaterMark: 128 * 1024 })
}

function formatBytesLabel(label: string): string {
  return label.replace(/[\r\n]+/g, ' ').slice(0, 120)
}

export class TransferEngine {
  private readonly jobs = new Map<string, MutableJob>()

  constructor(private readonly options: TransferEngineOptions) {}

  list(): TransferJob[] {
    return [...this.jobs.values()].map((job) => this.snapshot(job))
  }

  async start(request: TransferRequest): Promise<TransferStartResult> {
    if (request.conflictPolicy === 'cancel') {
      return { status: 'invalid', message: 'Transfer cancelled' }
    }
    const backend = this.options.getBackend(request.sessionId)
    const firstName =
      request.direction === 'upload'
        ? path.basename(request.sources[0] ?? '')
        : basenamePath(backend.pathStyle, request.sources[0] ?? '')
    const label = `${request.direction === 'upload' ? 'Upload' : 'Download'} ${firstName}`

    let plan: Plan
    try {
      plan =
        request.direction === 'upload'
          ? await this.planUpload(backend, request)
          : await this.planDownload(backend, request)
    } catch (error) {
      return { status: 'invalid', message: toTransferMessage(error) }
    }

    const conflicts = await this.findConflicts(backend, request, plan)
    if (request.conflictPolicy === 'ask' && conflicts.length > 0) {
      return { status: 'conflicts', conflicts }
    }

    const job: MutableJob = {
      id: crypto.randomUUID(),
      sessionId: request.sessionId,
      direction: request.direction,
      label: formatBytesLabel(
        plan.topItems.length > 1 ? `${label} (+${plan.topItems.length - 1})` : label
      ),
      state: 'running',
      destDir: request.destDir,
      bytesDone: 0,
      bytesTotal: plan.bytesTotal,
      filesDone: 0,
      filesTotal: plan.filesTotal,
      currentFile: null,
      startedAt: Date.now(),
      finishedAt: null,
      cancelled: false,
      lastEmit: 0,
      failures: [],
      abort: new AbortController()
    }

    this.jobs.set(job.id, job)
    this.trimJobs()
    this.emitJob(job, true)
    void this.executeJob(job, backend, request, plan).catch((error) => {
      job.state = 'failed'
      job.error = toErrorPayload(error, 'TRANSFER_FAILED')
      job.finishedAt = Date.now()
      this.emitJob(job, true)
    })

    return { status: 'started', job: this.snapshot(job) }
  }

  async cancel(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId)
    if (!job || job.finishedAt !== null || job.cancelled) return
    job.cancelled = true
    job.abort.abort()
    this.emitJob(job, true)
  }

  async cancelForSession(sessionId: string): Promise<void> {
    for (const job of this.jobs.values()) {
      if (job.sessionId === sessionId && job.finishedAt === null) {
        await this.cancel(job.id)
      }
    }
  }

  private trimJobs(): void {
    if (this.jobs.size <= MAX_RETAINED_JOBS) return
    const finished = [...this.jobs.values()]
      .filter((job) => job.finishedAt !== null)
      .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0))
    while (this.jobs.size > MAX_RETAINED_JOBS && finished.length > 0) {
      const oldest = finished.shift()
      if (oldest) this.jobs.delete(oldest.id)
    }
  }

  private snapshot(job: MutableJob): TransferJob {
    const {
      cancelled: _cancelled,
      lastEmit: _lastEmit,
      failures: _failures,
      abort: _abort,
      ...rest
    } = job
    return { ...rest }
  }

  private emitJob(job: MutableJob, force: boolean): void {
    if (!force && Date.now() - job.lastEmit < PROGRESS_INTERVAL_MS) return
    job.lastEmit = Date.now()
    this.options.emit({ type: 'transfer:update', job: this.snapshot(job) })
  }

  private async planUpload(backend: FileBackend, request: TransferRequest): Promise<Plan> {
    const topItems: PlannedTopItem[] = []
    const visited = new Set<string>()
    const destinations = new Set<string>()

    for (const source of request.sources) {
      const name = path.basename(source)
      const destination = joinPath(backend.pathStyle, request.destDir, name)
      const destinationKey = backend.pathStyle === 'win32' ? destination.toLowerCase() : destination
      if (destinations.has(destinationKey)) {
        throw new AppError(
          'INVALID_ARGUMENT',
          `Multiple selected items are named "${name}". Rename one of them or upload separately.`
        )
      }
      destinations.add(destinationKey)
      if (path.resolve(source) === path.resolve(destination)) {
        throw new AppError(
          'INVALID_ARGUMENT',
          `Source and destination are the same path: ${source}`
        )
      }
      const resolved = await this.resolveLocalSource(source)
      const entries: PlanEntry[] = []
      await this.walkLocal(resolved.path, destination, entries, visited, backend.pathStyle)
      topItems.push({
        sourceName: name,
        sourcePath: source,
        destinationPath: destination,
        kind: resolved.kind,
        entries
      })
    }
    return this.summarize(topItems)
  }

  private async resolveLocalSource(
    source: string
  ): Promise<{ path: string; kind: 'dir' | 'file' }> {
    let stat: fs.Stats
    try {
      stat = await fs.promises.lstat(source)
    } catch {
      throw new AppError('FS_NOT_FOUND', `Source no longer exists: ${source}`)
    }
    if (stat.isSymbolicLink()) {
      const resolved = await fs.promises.realpath(source)
      const resolvedStat = await fs.promises.stat(resolved)
      if (resolvedStat.isDirectory()) return { path: resolved, kind: 'dir' }
      if (resolvedStat.isFile()) return { path: resolved, kind: 'file' }
      throw new AppError('NOT_SUPPORTED', `Unsupported source type: ${source}`)
    }
    if (stat.isDirectory()) return { path: source, kind: 'dir' }
    if (stat.isFile()) return { path: source, kind: 'file' }
    throw new AppError('NOT_SUPPORTED', `Unsupported source type: ${source}`)
  }

  private async walkLocal(
    sourcePath: string,
    destinationPath: string,
    entries: PlanEntry[],
    visited: Set<string>,
    style: 'posix' | 'win32'
  ): Promise<void> {
    if (entries.length > MAX_PLAN_ENTRIES) {
      throw new AppError('TRANSFER_FAILED', 'Too many files in this transfer (limit 50,000)')
    }
    const stat = await fs.promises.lstat(sourcePath)
    if (stat.isSymbolicLink()) {
      const resolved = await fs.promises.realpath(sourcePath)
      return this.walkLocal(resolved, destinationPath, entries, visited, style)
    }
    if (stat.isDirectory()) {
      const real = await fs.promises.realpath(sourcePath)
      if (visited.has(real)) return
      visited.add(real)
      entries.push({
        sourcePath,
        destinationPath,
        kind: 'dir',
        size: 0,
        mtimeMs: stat.mtimeMs,
        mode: stat.mode & 0o777
      })
      const children = await fs.promises.readdir(sourcePath, { withFileTypes: true })
      for (const child of children) {
        await this.walkLocal(
          path.join(sourcePath, child.name),
          joinPath(style, destinationPath, child.name),
          entries,
          visited,
          style
        )
      }
      return
    }
    if (stat.isFile()) {
      entries.push({
        sourcePath,
        destinationPath,
        kind: 'file',
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        mode: stat.mode & 0o777
      })
      return
    }
    // Sockets, FIFOs, devices are skipped intentionally.
  }

  private async planDownload(backend: FileBackend, request: TransferRequest): Promise<Plan> {
    const topItems: PlannedTopItem[] = []
    const visited = new Set<string>()
    const reservedDestinations = new Set<string>()
    const targetPlatform = process.platform as LocalPlatform

    for (const source of request.sources) {
      const sourceName = basenamePath(backend.pathStyle, source)
      const safeName = this.reserveLocalName(
        sanitizeLocalFilename(sourceName, targetPlatform),
        request.destDir,
        reservedDestinations,
        targetPlatform
      )
      const destination = path.join(request.destDir, safeName)
      const resolved = await this.resolveBackendSource(backend, source)
      const entries: PlanEntry[] = []
      await this.walkBackend(
        backend,
        resolved.path,
        destination,
        entries,
        visited,
        reservedDestinations,
        targetPlatform
      )
      topItems.push({
        sourceName,
        sourcePath: source,
        destinationPath: destination,
        kind: resolved.kind,
        entries
      })
    }
    return this.summarize(topItems)
  }

  private reserveLocalName(
    name: string,
    parentDir: string,
    reserved: Set<string>,
    platform: LocalPlatform
  ): string {
    const candidate = nextAvailableName(name, (value) => {
      const key = platform === 'linux' ? value : value.toLowerCase()
      return reserved.has(`${parentDir}\u0000${key}`)
    })
    const key = platform === 'linux' ? candidate : candidate.toLowerCase()
    reserved.add(`${parentDir}\u0000${key}`)
    return candidate
  }

  private async resolveBackendSource(
    backend: FileBackend,
    source: string
  ): Promise<{ path: string; kind: 'dir' | 'file' }> {
    let stat: FileEntry
    try {
      stat = await backend.stat(source)
    } catch {
      throw new AppError('FS_NOT_FOUND', `Source no longer exists: ${source}`)
    }
    if (stat.kind === 'symlink') {
      try {
        const real = await backend.realpath(source)
        const resolved = await backend.stat(real)
        if (resolved.kind === 'dir') return { path: real, kind: 'dir' }
        if (resolved.kind === 'file') return { path: real, kind: 'file' }
      } catch {
        // Fall through to unsupported type error below.
      }
      throw new AppError('NOT_SUPPORTED', `Unsupported symlink target: ${source}`)
    }
    if (stat.kind === 'dir') return { path: source, kind: 'dir' }
    if (stat.kind === 'file') return { path: source, kind: 'file' }
    throw new AppError('NOT_SUPPORTED', `Unsupported source type: ${source}`)
  }

  private async walkBackend(
    backend: FileBackend,
    sourcePath: string,
    destinationPath: string,
    entries: PlanEntry[],
    visited: Set<string>,
    reserved: Set<string>,
    platform: LocalPlatform
  ): Promise<void> {
    if (entries.length > MAX_PLAN_ENTRIES) {
      throw new AppError('TRANSFER_FAILED', 'Too many files in this transfer (limit 50,000)')
    }
    const stat = await backend.stat(sourcePath)
    if (stat.kind === 'symlink') {
      const resolved = await backend.realpath(sourcePath)
      return this.walkBackend(
        backend,
        resolved,
        destinationPath,
        entries,
        visited,
        reserved,
        platform
      )
    }
    if (stat.kind === 'dir') {
      let real: string
      try {
        real = await backend.realpath(sourcePath)
      } catch {
        real = sourcePath
      }
      if (visited.has(real)) return
      visited.add(real)
      entries.push({
        sourcePath,
        destinationPath,
        kind: 'dir',
        size: 0,
        mtimeMs: stat.mtimeMs,
        mode: stat.mode
      })
      const listing = await backend.list(sourcePath)
      for (const child of listing.entries) {
        const safeName = this.reserveLocalName(
          sanitizeLocalFilename(child.name, platform),
          destinationPath,
          reserved,
          platform
        )
        await this.walkBackend(
          backend,
          child.path,
          path.join(destinationPath, safeName),
          entries,
          visited,
          reserved,
          platform
        )
      }
      return
    }
    if (stat.kind === 'file') {
      entries.push({
        sourcePath,
        destinationPath,
        kind: 'file',
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        mode: stat.mode
      })
    }
  }

  private summarize(topItems: PlannedTopItem[]): Plan {
    let bytesTotal = 0
    let filesTotal = 0
    for (const item of topItems) {
      for (const entry of item.entries) {
        if (entry.kind === 'file') {
          bytesTotal += entry.size
          filesTotal += 1
        }
      }
    }
    return { topItems, bytesTotal, filesTotal }
  }

  private async findConflicts(
    backend: FileBackend,
    request: TransferRequest,
    plan: Plan
  ): Promise<TransferConflict[]> {
    const conflicts: TransferConflict[] = []
    for (const item of plan.topItems) {
      const exists =
        request.direction === 'upload'
          ? await this.backendExists(backend, item.destinationPath)
          : await this.localExists(item.destinationPath)
      if (exists) {
        conflicts.push({
          name: item.sourceName,
          destinationPath: item.destinationPath,
          kind: item.kind === 'dir' ? 'dir' : 'file'
        })
      }
    }
    return conflicts
  }

  private async backendExists(backend: FileBackend, target: string): Promise<boolean> {
    try {
      await backend.stat(target)
      return true
    } catch (error) {
      if (isNotFoundError(error)) return false
      throw error
    }
  }

  private async localExists(target: string): Promise<boolean> {
    try {
      await fs.promises.lstat(target)
      return true
    } catch (error) {
      if (isNotFoundError(error)) return false
      throw error
    }
  }

  private async executeJob(
    job: MutableJob,
    backend: FileBackend,
    request: TransferRequest,
    plan: Plan
  ): Promise<void> {
    const policy = request.conflictPolicy
    try {
      for (const topItem of plan.topItems) {
        if (job.cancelled) break
        await this.prepareTopItem(job, backend, request, topItem, policy)
        for (const entry of topItem.entries) {
          if (job.cancelled) break
          if (entry.kind === 'dir') {
            await this.ensureDirectory(backend, request.direction, entry.destinationPath)
            continue
          }
          await this.transferFile(job, backend, request.direction, entry, policy)
        }
      }
      if (job.cancelled) {
        job.state = 'cancelled'
      } else if (job.failures.length > 0) {
        job.state = 'failed'
        job.error = {
          code: 'TRANSFER_FAILED',
          message: `${job.failures.length} item(s) failed. ${job.failures[0]}`
        }
      } else {
        job.state = 'completed'
      }
    } catch (error) {
      if (job.cancelled) {
        job.state = 'cancelled'
      } else {
        job.state = 'failed'
        job.error = toErrorPayload(error, 'TRANSFER_FAILED')
      }
    } finally {
      if (job.finishedAt === null) job.finishedAt = Date.now()
      job.currentFile = null
      this.emitJob(job, true)
      this.options.emit({
        type: 'toast',
        level: job.state === 'completed' ? 'success' : job.state === 'failed' ? 'error' : 'info',
        message:
          job.state === 'completed'
            ? `${job.direction === 'upload' ? 'Upload' : 'Download'} complete: ${job.label}`
            : job.state === 'cancelled'
              ? `Transfer cancelled: ${job.label}`
              : `Transfer failed: ${job.error?.message ?? job.label}`
      })
    }
  }

  /** Applies the conflict policy to a top-level item before walking its children. */
  private async prepareTopItem(
    job: MutableJob,
    backend: FileBackend,
    request: TransferRequest,
    item: PlannedTopItem,
    policy: ConflictPolicy
  ): Promise<void> {
    const exists =
      request.direction === 'upload'
        ? await this.backendExists(backend, item.destinationPath)
        : await this.localExists(item.destinationPath)
    if (!exists) return

    if (policy === 'skip') {
      item.entries = []
      return
    }
    if (policy === 'keepBoth') {
      const renamed = await this.uniqueDestination(backend, request.direction, item.destinationPath)
      const previousPrefix = item.destinationPath
      item.destinationPath = renamed
      for (const entry of item.entries) {
        entry.destinationPath = renamed + entry.destinationPath.slice(previousPrefix.length)
      }
      return
    }
    // overwrite: if a directory is being merged, keep it; if types differ remove first.
    const existingIsDir =
      request.direction === 'upload'
        ? await this.backendEntryIsDirectory(backend, item.destinationPath)
        : await this.localEntryIsDirectory(item.destinationPath)
    if (item.kind === 'dir' && existingIsDir) return
    if (request.direction === 'upload') {
      await backend.remove([item.destinationPath], true)
    } else {
      await this.removeLocal(item.destinationPath)
    }
  }

  private async backendEntryIsDirectory(backend: FileBackend, target: string): Promise<boolean> {
    try {
      return (await backend.stat(target)).kind === 'dir'
    } catch {
      return false
    }
  }

  private async localEntryIsDirectory(target: string): Promise<boolean> {
    try {
      return (await fs.promises.lstat(target)).isDirectory()
    } catch {
      return false
    }
  }

  private async uniqueDestination(
    backend: FileBackend,
    direction: 'upload' | 'download',
    target: string
  ): Promise<string> {
    const style = direction === 'upload' ? backend.pathStyle : null
    const parent = style ? dirnamePath(style, target) : path.dirname(target)
    const name = style ? basenamePath(style, target) : path.basename(target)
    for (let index = 1; index < 10_000; index += 1) {
      const { base, extension } = splitNameExtension(name)
      const candidateName = `${base} (${index})${extension}`
      const candidate = style
        ? joinPath(style, parent, candidateName)
        : path.join(parent, candidateName)
      const exists =
        direction === 'upload'
          ? await this.backendExists(backend, candidate)
          : await this.localExists(candidate)
      if (!exists) return candidate
    }
    return style
      ? joinPath(style, parent, `${name}-${Date.now().toString(36)}`)
      : path.join(parent, `${name}-${Date.now().toString(36)}`)
  }

  private async ensureDirectory(
    backend: FileBackend,
    direction: 'upload' | 'download',
    target: string
  ): Promise<void> {
    if (direction === 'upload') {
      const parent = dirnamePath(backend.pathStyle, target)
      const name = basenamePath(backend.pathStyle, target)
      try {
        await backend.mkdir(parent, name)
      } catch (error) {
        if (error instanceof AppError && error.code === 'FS_EXISTS') return
        if (await this.backendEntryIsDirectory(backend, target)) return
        throw error
      }
    } else {
      await fs.promises.mkdir(target, { recursive: true })
    }
  }

  private async transferFile(
    job: MutableJob,
    backend: FileBackend,
    direction: 'upload' | 'download',
    entry: PlanEntry,
    policy: ConflictPolicy
  ): Promise<void> {
    let destination = entry.destinationPath
    const exists =
      direction === 'upload'
        ? await this.backendExists(backend, destination)
        : await this.localExists(destination)

    if (exists) {
      if (policy === 'skip') return
      if (policy === 'keepBoth') {
        destination = await this.uniqueDestination(backend, direction, destination)
      } else {
        if (direction === 'upload') await backend.remove([destination], true)
        else await this.removeLocal(destination)
      }
    }

    job.currentFile = entry.sourcePath
    this.emitJob(job, false)

    const tempName = `termshelf-${crypto.randomBytes(6).toString('hex')}.part`
    const tempPath =
      direction === 'upload'
        ? joinPath(backend.pathStyle, dirnamePath(backend.pathStyle, destination), tempName)
        : path.join(path.dirname(destination), tempName)

    const bytesAtStart = job.bytesDone
    try {
      const source =
        direction === 'upload'
          ? fs.createReadStream(entry.sourcePath, { highWaterMark: 128 * 1024 })
          : backend.createReadStream(entry.sourcePath)
      const writeStream = writeStreamFor(direction, backend, tempPath)
      source.on('data', (chunk: Buffer | string) => {
        job.bytesDone += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
        this.emitJob(job, false)
      })
      await pipeline(source, writeStream, { signal: job.abort.signal })

      if (job.cancelled) throw new AppError('TRANSFER_CANCELLED', 'Transfer cancelled')

      if (direction === 'upload') {
        if (await this.backendExists(backend, destination)) {
          await backend.remove([destination], true)
        }
        const finalName = basenamePath(backend.pathStyle, destination)
        // rename() resolves relative to the temp file's parent directory.
        await backend.rename(tempPath, finalName)
        try {
          await backend.setTimes(destination, entry.mtimeMs)
        } catch {
          /* metadata is best effort */
        }
      } else {
        if (await this.localExists(destination)) {
          await this.removeLocal(destination)
        }
        await fs.promises.rename(tempPath, destination)
        try {
          await fs.promises.utimes(destination, new Date(entry.mtimeMs), new Date(entry.mtimeMs))
        } catch {
          /* metadata is best effort */
        }
      }

      job.filesDone += 1
      job.currentFile = null
      this.emitJob(job, true)
    } catch (error) {
      await this.cleanupTemp(direction, backend, tempPath)
      if (job.cancelled) return
      job.bytesDone = bytesAtStart
      job.failures.push(`${entry.sourcePath}: ${toTransferMessage(error)}`)
      this.options.emit({
        type: 'toast',
        level: 'warn',
        message: `${basenamePath('posix', entry.sourcePath)} failed: ${toTransferMessage(error)}`
      })
    }
  }

  private async cleanupTemp(
    direction: 'upload' | 'download',
    backend: FileBackend,
    tempPath: string
  ): Promise<void> {
    try {
      if (direction === 'upload') await backend.remove([tempPath], true)
      else await fs.promises.rm(tempPath, { force: true })
    } catch {
      // ignore
    }
  }

  private async removeLocal(target: string): Promise<void> {
    await fs.promises.rm(target, { recursive: true, force: true })
  }
}
