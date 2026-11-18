import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalBackend } from '../../src/main/files/local-backend'
import { TransferEngine } from '../../src/main/transfers/engine'
import type { TransferJob } from '../../src/shared/types'

const directories: string[] = []

function tempDir(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  directories.push(directory)
  return directory
}

async function waitForJob(engine: TransferEngine, jobId: string): Promise<TransferJob> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const job = engine.list().find((candidate) => candidate.id === jobId)
    if (job && job.finishedAt !== null) return job
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('Timed out waiting for transfer job')
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('download timestamps', () => {
  it('stamps downloaded files with the completion time instead of the source mtime', async () => {
    const sourceDirectory = tempDir('termshelf-mtime-source-')
    const downloadDirectory = tempDir('termshelf-mtime-download-')
    const sourceFile = path.join(sourceDirectory, 'dataset.bin')
    fs.writeFileSync(sourceFile, Buffer.alloc(256 * 1024, 7))
    const oldTime = new Date('2020-01-02T03:04:05Z')
    fs.utimesSync(sourceFile, oldTime, oldTime)

    const engine = new TransferEngine({
      getBackend: () => new LocalBackend(),
      emit: () => undefined
    })
    const started = await engine.start({
      sessionId: 'mtime-test',
      direction: 'download',
      sources: [sourceFile],
      destDir: downloadDirectory,
      conflictPolicy: 'overwrite'
    })
    expect(started.status).toBe('started')
    if (started.status !== 'started') return
    const job = await waitForJob(engine, started.job.id)
    expect(job.state).toBe('completed')

    const downloaded = path.join(downloadDirectory, 'dataset.bin')
    const stats = fs.statSync(downloaded)
    const ageMs = Date.now() - stats.mtimeMs
    expect(ageMs).toBeGreaterThanOrEqual(0)
    expect(ageMs).toBeLessThan(60_000)
    expect(Math.abs(stats.mtimeMs - oldTime.getTime())).toBeGreaterThan(24 * 60 * 60 * 1000)
  })
})
