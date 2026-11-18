import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AppEvent, ConflictPolicy, TransferJob, TransferStartResult } from '@shared/types'
import { LocalBackend } from '../../src/main/files/local-backend'
import { TransferEngine } from '../../src/main/transfers/engine'

/** Temporary directory tree shared by one test. */
let workDir: string
let engine: TransferEngine
let events: AppEvent[]

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function writeFixture(filePath: string, content: string | Buffer): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, content)
}

function expectStarted(result: TransferStartResult): TransferJob {
  if (result.status !== 'started') {
    throw new Error(`Expected a started transfer, received status="${result.status}"`)
  }
  return result.job
}

async function waitForJob(jobId: string, timeoutMs = 15_000): Promise<TransferJob> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const job = engine.list().find((candidate) => candidate.id === jobId)
    if (job && job.finishedAt !== null) return job
    if (Date.now() > deadline) {
      throw new Error(`Transfer job ${jobId} did not finish within ${timeoutMs}ms`)
    }
    await sleep(10)
  }
}

function startUpload(
  sources: string[],
  destDir: string,
  conflictPolicy: ConflictPolicy = 'overwrite'
): Promise<TransferStartResult> {
  return engine.start({
    sessionId: 'test-session',
    direction: 'upload',
    sources,
    destDir,
    conflictPolicy
  })
}

function startDownload(
  sources: string[],
  destDir: string,
  conflictPolicy: ConflictPolicy = 'overwrite'
): Promise<TransferStartResult> {
  return engine.start({
    sessionId: 'test-session',
    direction: 'download',
    sources,
    destDir,
    conflictPolicy
  })
}

async function partFiles(directory: string): Promise<string[]> {
  const found: string[] = []
  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name)
      if (entry.isDirectory()) await walk(entryPath)
      else if (entry.name.endsWith('.part')) found.push(entryPath)
    }
  }
  await walk(directory)
  return found
}

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'termshelf-transfer-'))
  events = []
  engine = new TransferEngine({
    getBackend: () => new LocalBackend(),
    emit: (event) => events.push(event)
  })
})

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true })
})

describe('TransferEngine uploads (local sources -> backend destination)', () => {
  it('uploads a single file and reports byte/file totals', async () => {
    const localDir = path.join(workDir, 'local')
    const remoteDir = path.join(workDir, 'remote')
    const source = path.join(localDir, 'hello.txt')
    const content = 'hello termshelf upload\n'
    await writeFixture(source, content)
    await mkdir(remoteDir, { recursive: true })

    const result = await startUpload([source], remoteDir)
    expect(result.status).toBe('started')
    const job = expectStarted(result)
    expect(job.direction).toBe('upload')
    expect(job.state).toBe('running')
    expect(job.bytesTotal).toBe(Buffer.byteLength(content))
    expect(job.filesTotal).toBe(1)
    expect(job.finishedAt).toBeNull()

    const finished = await waitForJob(job.id)
    expect(finished.state).toBe('completed')
    expect(finished.filesDone).toBe(1)
    expect(finished.bytesDone).toBe(Buffer.byteLength(content))
    expect(finished.error).toBeUndefined()
    expect(await readFile(path.join(remoteDir, 'hello.txt'), 'utf8')).toBe(content)

    // Progress and completion events were emitted.
    const updates = events.filter(
      (event): event is Extract<AppEvent, { type: 'transfer:update' }> =>
        event.type === 'transfer:update'
    )
    expect(updates.some((event) => event.job.id === job.id)).toBe(true)
    expect(events.some((event) => event.type === 'toast' && event.level === 'success')).toBe(true)
    expect(engine.list().some((candidate) => candidate.id === job.id)).toBe(true)
  })

  it('uploads a directory recursively, including nested and empty directories', async () => {
    const localDir = path.join(workDir, 'local')
    const sourceDir = path.join(localDir, 'dataset')
    const remoteDir = path.join(workDir, 'remote')
    await mkdir(remoteDir, { recursive: true })
    await writeFixture(path.join(sourceDir, 'a.txt'), 'AAA')
    await writeFixture(path.join(sourceDir, 'sub', 'b.bin'), Buffer.from([1, 2, 3, 4, 5]))
    await mkdir(path.join(sourceDir, 'empty'), { recursive: true })

    const job = expectStarted(await startUpload([sourceDir], remoteDir))
    const finished = await waitForJob(job.id)
    expect(finished.state).toBe('completed')
    expect(finished.filesTotal).toBe(2)
    expect(finished.filesDone).toBe(2)
    expect(finished.bytesTotal).toBe(8)
    expect(finished.bytesDone).toBe(8)

    expect(await readFile(path.join(remoteDir, 'dataset', 'a.txt'), 'utf8')).toBe('AAA')
    expect([...(await readFile(path.join(remoteDir, 'dataset', 'sub', 'b.bin')))]).toEqual([
      1, 2, 3, 4, 5
    ])
    expect((await stat(path.join(remoteDir, 'dataset', 'empty'))).isDirectory()).toBe(true)
  })

  it('overwrites existing destination files with the overwrite policy', async () => {
    const localDir = path.join(workDir, 'local')
    const remoteDir = path.join(workDir, 'remote')
    const source = path.join(localDir, 'report.txt')
    await writeFixture(source, 'new content')
    await writeFixture(path.join(remoteDir, 'report.txt'), 'old content')

    const job = expectStarted(await startUpload([source], remoteDir, 'overwrite'))
    const finished = await waitForJob(job.id)
    expect(finished.state).toBe('completed')
    expect(await readFile(path.join(remoteDir, 'report.txt'), 'utf8')).toBe('new content')
  })

  it('reports conflicts before starting when the policy is ask', async () => {
    const localDir = path.join(workDir, 'local')
    const remoteDir = path.join(workDir, 'remote')
    const source = path.join(localDir, 'report.txt')
    await writeFixture(source, 'new content')
    await writeFixture(path.join(remoteDir, 'report.txt'), 'old content')

    const result = await startUpload([source], remoteDir, 'ask')
    expect(result.status).toBe('conflicts')
    if (result.status !== 'conflicts') throw new Error('unreachable')
    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0]?.name).toBe('report.txt')
    expect(result.conflicts[0]?.destinationPath).toBe(path.join(remoteDir, 'report.txt'))
    expect(result.conflicts[0]?.kind).toBe('file')
    // Nothing was transferred and no job was created.
    expect(engine.list()).toHaveLength(0)
    expect(await readFile(path.join(remoteDir, 'report.txt'), 'utf8')).toBe('old content')
  })

  it('keeps both files using the "name (n).ext" convention', async () => {
    const localDir = path.join(workDir, 'local')
    const remoteDir = path.join(workDir, 'remote')
    const source = path.join(localDir, 'dup.txt')
    await writeFixture(source, 'incoming')
    await writeFixture(path.join(remoteDir, 'dup.txt'), 'existing')

    const job = expectStarted(await startUpload([source], remoteDir, 'keepBoth'))
    const finished = await waitForJob(job.id)
    expect(finished.state).toBe('completed')
    expect(await readFile(path.join(remoteDir, 'dup.txt'), 'utf8')).toBe('existing')
    expect(await readFile(path.join(remoteDir, 'dup (1).txt'), 'utf8')).toBe('incoming')
  })

  it('skips conflicting items with the skip policy', async () => {
    const localDir = path.join(workDir, 'local')
    const remoteDir = path.join(workDir, 'remote')
    const source = path.join(localDir, 'keep.txt')
    await writeFixture(source, 'incoming')
    await writeFixture(path.join(remoteDir, 'keep.txt'), 'existing')

    const job = expectStarted(await startUpload([source], remoteDir, 'skip'))
    const finished = await waitForJob(job.id)
    expect(finished.state).toBe('completed')
    expect(finished.filesDone).toBe(0)
    expect(await readFile(path.join(remoteDir, 'keep.txt'), 'utf8')).toBe('existing')
  })

  it('rejects invalid requests (missing source, cancelled policy, duplicate names)', async () => {
    const remoteDir = path.join(workDir, 'remote')
    await mkdir(remoteDir, { recursive: true })

    const missing = await startUpload([path.join(workDir, 'does-not-exist.txt')], remoteDir)
    expect(missing.status).toBe('invalid')

    const cancelled = await startUpload([path.join(workDir, 'x.txt')], remoteDir, 'cancel')
    expect(cancelled.status).toBe('invalid')

    const first = path.join(workDir, 'one', 'same.txt')
    const second = path.join(workDir, 'two', 'same.txt')
    await writeFixture(first, 'one')
    await writeFixture(second, 'two')
    const duplicate = await startUpload([first, second], remoteDir)
    expect(duplicate.status).toBe('invalid')
  })

  it('cancels a large upload mid-flight, leaving no .part files', async () => {
    const localDir = path.join(workDir, 'local')
    const remoteDir = path.join(workDir, 'remote')
    const source = path.join(localDir, 'large.bin')
    await writeFixture(source, Buffer.alloc(48 * 1024 * 1024, 7))
    await mkdir(remoteDir, { recursive: true })

    const job = expectStarted(await startUpload([source], remoteDir))
    // Wait for at least one chunk to flow so cancel lands mid-transfer.
    const deadline = Date.now() + 5000
    while (
      (engine.list().find((candidate) => candidate.id === job.id)?.bytesDone ?? 0) === 0 &&
      Date.now() < deadline
    ) {
      await sleep(5)
    }
    await engine.cancel(job.id)

    const finished = await waitForJob(job.id)
    expect(finished.state).toBe('cancelled')
    expect(finished.error).toBeUndefined()
    expect(await partFiles(remoteDir)).toEqual([])
  })
})

describe('TransferEngine downloads (backend sources -> local destination)', () => {
  it('downloads a file and preserves its bytes', async () => {
    const remoteDir = path.join(workDir, 'remote')
    const localDir = path.join(workDir, 'downloads')
    const source = path.join(remoteDir, 'remote.txt')
    const payload = Buffer.from([0, 1, 2, 3, 250, 251, 252])
    await writeFixture(source, payload)
    await mkdir(localDir, { recursive: true })

    const job = expectStarted(await startDownload([source], localDir))
    expect(job.direction).toBe('download')
    expect(job.bytesTotal).toBe(payload.length)
    expect(job.filesTotal).toBe(1)

    const finished = await waitForJob(job.id)
    expect(finished.state).toBe('completed')
    expect(finished.filesDone).toBe(1)
    expect(finished.bytesDone).toBe(payload.length)
    expect([...(await readFile(path.join(localDir, 'remote.txt')))]).toEqual([...payload])
  })

  it('downloads directories recursively, creating the destination tree', async () => {
    const remoteDir = path.join(workDir, 'remote')
    const localDir = path.join(workDir, 'downloads')
    await writeFixture(path.join(remoteDir, 'tree', 'x.txt'), 'x')
    await writeFixture(path.join(remoteDir, 'tree', 'sub', 'y.txt'), 'y')
    await mkdir(path.join(remoteDir, 'tree', 'empty'), { recursive: true })
    await mkdir(localDir, { recursive: true })

    const job = expectStarted(await startDownload([path.join(remoteDir, 'tree')], localDir))
    const finished = await waitForJob(job.id)
    expect(finished.state).toBe('completed')
    expect(finished.filesTotal).toBe(2)
    expect(await readFile(path.join(localDir, 'tree', 'x.txt'), 'utf8')).toBe('x')
    expect(await readFile(path.join(localDir, 'tree', 'sub', 'y.txt'), 'utf8')).toBe('y')
    expect((await stat(path.join(localDir, 'tree', 'empty'))).isDirectory()).toBe(true)
  })

  it('handles download conflicts: ask, skip and keepBoth', async () => {
    const remoteDir = path.join(workDir, 'remote')
    const localDir = path.join(workDir, 'downloads')
    const source = path.join(remoteDir, 'dup.txt')
    await writeFixture(source, 'incoming')
    await writeFixture(path.join(localDir, 'dup.txt'), 'existing')

    const ask = await startDownload([source], localDir, 'ask')
    expect(ask.status).toBe('conflicts')
    if (ask.status !== 'conflicts') throw new Error('unreachable')
    expect(ask.conflicts[0]?.name).toBe('dup.txt')

    const skipped = expectStarted(await startDownload([source], localDir, 'skip'))
    const skippedFinished = await waitForJob(skipped.id)
    expect(skippedFinished.state).toBe('completed')
    expect(await readFile(path.join(localDir, 'dup.txt'), 'utf8')).toBe('existing')

    const kept = expectStarted(await startDownload([source], localDir, 'keepBoth'))
    const keptFinished = await waitForJob(kept.id)
    expect(keptFinished.state).toBe('completed')
    expect(await readFile(path.join(localDir, 'dup.txt'), 'utf8')).toBe('existing')
    expect(await readFile(path.join(localDir, 'dup (1).txt'), 'utf8')).toBe('incoming')
  })

  it('overwrites existing destination files with the overwrite policy', async () => {
    const remoteDir = path.join(workDir, 'remote')
    const localDir = path.join(workDir, 'downloads')
    const source = path.join(remoteDir, 'overwrite.txt')
    await writeFixture(source, 'new content')
    await writeFixture(path.join(localDir, 'overwrite.txt'), 'old content')

    const job = expectStarted(await startDownload([source], localDir, 'overwrite'))
    const finished = await waitForJob(job.id)
    expect(finished.state).toBe('completed')
    expect(await readFile(path.join(localDir, 'overwrite.txt'), 'utf8')).toBe('new content')
  })

  it('cancels a large download mid-flight, leaving no .part files', async () => {
    const remoteDir = path.join(workDir, 'remote')
    const localDir = path.join(workDir, 'downloads')
    const source = path.join(remoteDir, 'large.bin')
    await writeFixture(source, Buffer.alloc(48 * 1024 * 1024, 3))
    await mkdir(localDir, { recursive: true })

    const job = expectStarted(await startDownload([source], localDir))
    const deadline = Date.now() + 5000
    while (
      (engine.list().find((candidate) => candidate.id === job.id)?.bytesDone ?? 0) === 0 &&
      Date.now() < deadline
    ) {
      await sleep(5)
    }
    await engine.cancel(job.id)

    const finished = await waitForJob(job.id)
    expect(finished.state).toBe('cancelled')
    expect(await partFiles(localDir)).toEqual([])
    // No partial destination file was committed either.
    const leftovers = (await readdir(localDir)).filter((name) => name === 'large.bin')
    expect(leftovers).toEqual([])
  })
})
