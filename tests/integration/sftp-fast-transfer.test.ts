import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client, type SFTPWrapper } from 'ssh2'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startDevSshd, type DevSshdHandle } from '../../tools/dev-sshd/server'
import { SftpBackend } from '../../src/main/files/sftp-backend'
import { TransferEngine } from '../../src/main/transfers/engine'
import type { AppEvent, TransferJob } from '../../src/shared/types'

function connect(port: number): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client()
    client.once('ready', () => resolve(client)).once('error', reject)
    client.connect({
      host: '127.0.0.1',
      port,
      username: 'demo',
      password: 'demo',
      readyTimeout: 15_000,
      hostVerifier: () => true
    })
  })
}

function getSftp(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) =>
    client.sftp((error, sftp) => (error ? reject(error) : resolve(sftp)))
  )
}

async function waitForJob(engine: TransferEngine, jobId: string): Promise<TransferJob> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const job = engine.list().find((candidate) => candidate.id === jobId)
    if (job && job.finishedAt !== null) return job
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('Timed out waiting for transfer job')
}

describe('pipelined SFTP transfers', () => {
  let sshd: DevSshdHandle
  let client: Client
  let sftp: SFTPWrapper
  let backend: SftpBackend
  let baseDir: string
  let payload: Buffer

  beforeAll(async () => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termshelf-fast-sftp-'))
    sshd = await startDevSshd({
      root: path.join(baseDir, 'remote'),
      port: 0,
      hostKeyPath: path.join(baseDir, 'host.key')
    })
    client = await connect(sshd.port)
    sftp = await getSftp(client)
    backend = new SftpBackend(sftp)
    payload = crypto.randomBytes(2 * 1024 * 1024)
  })

  afterAll(async () => {
    try {
      sftp.end()
      client.end()
    } catch {
      // already closed
    }
    await sshd.close()
    fs.rmSync(baseDir, { recursive: true, force: true })
  })

  it('uploads and downloads with byte-accurate results and progress', async () => {
    const localSource = path.join(baseDir, 'source.bin')
    const localDownload = path.join(baseDir, 'download.bin')
    fs.writeFileSync(localSource, payload)

    let uploadProgress = 0
    await backend.uploadFile(localSource, '/fast-upload.bin', {
      onProgress: (bytes) => {
        uploadProgress = bytes
      }
    })
    expect(uploadProgress).toBe(payload.length)
    expect(fs.readFileSync(path.join(sshd.root, 'fast-upload.bin')).equals(payload)).toBe(true)

    let downloadProgress = 0
    await backend.downloadFile('/fast-upload.bin', localDownload, {
      onProgress: (bytes) => {
        downloadProgress = bytes
      }
    })
    expect(downloadProgress).toBe(payload.length)
    expect(fs.readFileSync(localDownload).equals(payload)).toBe(true)
  })

  it('is used by the transfer engine for uploads and downloads', async () => {
    const localSource = path.join(baseDir, 'engine-source.bin')
    const localDownloadDir = path.join(baseDir, 'engine-downloads')
    fs.mkdirSync(localDownloadDir, { recursive: true })
    fs.writeFileSync(localSource, payload)

    const events: AppEvent[] = []
    const engine = new TransferEngine({
      getBackend: () => backend,
      emit: (event) => events.push(event)
    })

    const upload = await engine.start({
      sessionId: 'fast-test',
      direction: 'upload',
      sources: [localSource],
      destDir: '/',
      conflictPolicy: 'overwrite'
    })
    expect(upload.status).toBe('started')
    if (upload.status !== 'started') return
    const uploadedJob = await waitForJob(engine, upload.job.id)
    expect(uploadedJob.state).toBe('completed')
    expect(uploadedJob.bytesDone).toBe(payload.length)
    expect(fs.readFileSync(path.join(sshd.root, 'engine-source.bin')).equals(payload)).toBe(true)

    const download = await engine.start({
      sessionId: 'fast-test',
      direction: 'download',
      sources: ['/engine-source.bin'],
      destDir: localDownloadDir,
      conflictPolicy: 'overwrite'
    })
    expect(download.status).toBe('started')
    if (download.status !== 'started') return
    const downloadedJob = await waitForJob(engine, download.job.id)
    expect(downloadedJob.state).toBe('completed')
    expect(fs.readFileSync(path.join(localDownloadDir, 'engine-source.bin')).equals(payload)).toBe(
      true
    )
    expect(events.some((event) => event.type === 'transfer:update')).toBe(true)
  })

  it('rejects promptly when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      backend.downloadFile('/fast-upload.bin', path.join(baseDir, 'aborted.bin'), {
        signal: controller.signal
      })
    ).rejects.toMatchObject({ code: 'TRANSFER_CANCELLED' })
  })
})
