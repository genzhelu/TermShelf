import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppError } from '../../src/main/errors'
import { WslBackend } from '../../src/main/files/wsl-backend'
import { TransferEngine } from '../../src/main/transfers/engine'
import { linuxToNative } from '../../src/main/wsl/paths'
import type { TransferJob } from '../../src/shared/types'

const POSIX_ONLY = process.platform === 'win32'

const directories: string[] = []

function tempDir(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  directories.push(directory)
  return directory
}

interface Fixture {
  root: string
  backend: WslBackend
}

/** A temp directory acting as the Windows UNC root; the Linux home lives at root/home/test. */
function createFixture(homePath = '/home/test'): Fixture {
  const root = tempDir('termshelf-wsl-root-')
  fs.mkdirSync(path.join(root, 'home', 'test'), { recursive: true })
  return { root, backend: new WslBackend(root, homePath) }
}

function writeFixture(fixture: Fixture, linuxPath: string, content: string | Buffer): string {
  const nativePath = linuxToNative(fixture.root, linuxPath)
  fs.mkdirSync(path.dirname(nativePath), { recursive: true })
  fs.writeFileSync(nativePath, content)
  return nativePath
}

async function captureError(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason
  )
  expect(error).toBeInstanceOf(AppError)
  return error as AppError
}

function collectReadable(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    stream.on('data', (chunk: Buffer | string) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    })
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.on('error', reject)
  })
}

function writeToStream(stream: NodeJS.WritableStream, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.on('error', reject)
    stream.on('finish', resolve)
    stream.end(data)
  })
}

async function waitForJob(engine: TransferEngine, jobId: string): Promise<TransferJob> {
  const deadline = Date.now() + 15_000
  for (;;) {
    const job = engine.list().find((candidate) => candidate.id === jobId)
    if (job && job.finishedAt !== null) return job
    if (Date.now() > deadline) throw new Error('Timed out waiting for transfer job')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('WslBackend listing', () => {
  it('lists a Linux folder with POSIX paths, breadcrumbs, parent and folder-first sort', async () => {
    const fixture = createFixture()
    fs.mkdirSync(path.join(fixture.root, 'home', 'test', 'dir-b'))
    fs.mkdirSync(path.join(fixture.root, 'home', 'test', 'dir-a'))
    writeFixture(fixture, '/home/test/b.txt', 'b')
    writeFixture(fixture, '/home/test/a.txt', 'a')
    writeFixture(fixture, '/home/test/file10.log', '10')
    writeFixture(fixture, '/home/test/file2.log', '2')

    const listing = await fixture.backend.list('/home/test')
    expect(listing.path).toBe('/home/test')
    expect(listing.parentPath).toBe('/home')
    expect(listing.breadcrumbs).toEqual([
      { name: '/', path: '/' },
      { name: 'home', path: '/home' },
      { name: 'test', path: '/home/test' }
    ])
    expect(listing.truncated).toBe(false)
    expect(listing.entries.slice(0, 2).map((entry) => entry.name)).toEqual(['dir-a', 'dir-b'])
    expect(listing.entries.map((entry) => entry.name)).toEqual([
      'dir-a',
      'dir-b',
      'a.txt',
      'b.txt',
      'file2.log',
      'file10.log'
    ])
    expect(listing.entries.find((entry) => entry.name === 'dir-a')?.kind).toBe('dir')
    expect(listing.entries.find((entry) => entry.name === 'a.txt')?.path).toBe('/home/test/a.txt')
    expect(listing.entries.find((entry) => entry.name === 'a.txt')?.size).toBe(1)
  })

  it('lists the Linux filesystem root through the UNC root', async () => {
    const fixture = createFixture()
    fs.mkdirSync(path.join(fixture.root, 'tmp'))
    const listing = await fixture.backend.list('/')
    expect(listing.path).toBe('/')
    expect(listing.parentPath).toBeNull()
    expect(listing.breadcrumbs).toEqual([{ name: '/', path: '/' }])
    expect(listing.entries.map((entry) => entry.name)).toEqual(['home', 'tmp'])
  })

  it('reports WSL_FS_UNAVAILABLE for a null root', async () => {
    const backend = new WslBackend(null, '/home/test')
    expect(await backend.home()).toBe('/home/test')
    expect((await captureError(backend.list('/home/test'))).code).toBe('WSL_FS_UNAVAILABLE')
    expect((await captureError(backend.stat('/home/test'))).code).toBe('WSL_FS_UNAVAILABLE')
    expect((await captureError(backend.realpath('/home/test'))).code).toBe('WSL_FS_UNAVAILABLE')
    expect((await captureError(backend.mkdir('/home/test', 'x'))).code).toBe('WSL_FS_UNAVAILABLE')
    expect((await captureError(backend.remove(['/home/test'], true))).code).toBe(
      'WSL_FS_UNAVAILABLE'
    )
    expect((await captureError(backend.setTimes('/home/test', Date.now()))).code).toBe(
      'WSL_FS_UNAVAILABLE'
    )
    expect(() => backend.createReadStream('/home/test')).toThrow(AppError)
    expect(() => backend.createWriteStream('/home/test')).toThrow(AppError)
  })
})

describe('WslBackend stat and realpath', () => {
  it('stats files and directories with POSIX names', async () => {
    const fixture = createFixture()
    writeFixture(fixture, '/home/test/hello.txt', 'hello')
    const file = await fixture.backend.stat('/home/test/hello.txt')
    expect(file).toMatchObject({
      path: '/home/test/hello.txt',
      name: 'hello.txt',
      kind: 'file',
      size: 5
    })
    if (process.platform !== 'win32') expect(file.mode ? file.mode & 0o777 : 0).toBe(0o644)

    const directory = await fixture.backend.stat('/home/test')
    expect(directory).toMatchObject({ path: '/home/test', name: 'test', kind: 'dir' })
  })

  it('throws FS_NOT_FOUND for missing entries', async () => {
    const fixture = createFixture()
    expect((await captureError(fixture.backend.stat('/home/test/missing'))).code).toBe(
      'FS_NOT_FOUND'
    )
  })

  it.skipIf(POSIX_ONLY)('reports symlinks and their targets', async () => {
    const fixture = createFixture()
    writeFixture(fixture, '/home/test/target.txt', 'target')
    fs.symlinkSync('target.txt', path.join(fixture.root, 'home', 'test', 'link.txt'))
    const link = await fixture.backend.stat('/home/test/link.txt')
    expect(link.kind).toBe('symlink')
    expect(link.symlinkTarget).toBe('target.txt')
  })

  it.skipIf(POSIX_ONLY)('realpaths symlinks back into Linux paths', async () => {
    const fixture = createFixture()
    writeFixture(fixture, '/home/test/target.txt', 'target')
    fs.symlinkSync('target.txt', path.join(fixture.root, 'home', 'test', 'link.txt'))
    expect(await fixture.backend.realpath('/home/test/link.txt')).toBe('/home/test/target.txt')
  })

  it('realpaths existing paths and normalizes dot segments', async () => {
    const fixture = createFixture()
    expect(await fixture.backend.realpath('/home/test')).toBe('/home/test')
    expect(await fixture.backend.realpath('/home/test/../test')).toBe('/home/test')
    expect(await fixture.backend.realpath('/')).toBe('/')
    expect((await captureError(fixture.backend.realpath('/home/test/nope'))).code).toBe(
      'FS_NOT_FOUND'
    )
  })
})

describe('WslBackend validation and traversal', () => {
  it('rejects invalid Linux paths', async () => {
    const fixture = createFixture()
    for (const invalid of ['relative/path', '', '/home/test/\u0000bad', `/${'a'.repeat(5000)}`]) {
      const error = await captureError(fixture.backend.list(invalid))
      expect(error.code).toBe('FS_INVALID_PATH')
    }
    const statError = await captureError(fixture.backend.stat('relative'))
    expect(statError.code).toBe('FS_INVALID_PATH')
    expect((await captureError(fixture.backend.mkdir('relative', 'x'))).code).toBe(
      'FS_INVALID_PATH'
    )
  })

  it('clamps traversal to the UNC root (cannot escape the WSL mount)', async () => {
    const fixture = createFixture()
    writeFixture(fixture, '/outside.txt', 'inside the mount')
    writeFixture(fixture, '/tmp/other.txt', 'tmp')
    // '/../outside.txt' normalizes to '/outside.txt' (root of the mount, not C:\).
    const clamped = await fixture.backend.stat('/../outside.txt')
    expect(clamped.path).toBe('/outside.txt')
    expect(clamped.name).toBe('outside.txt')
    // '/home/../../tmp/other.txt' normalizes to '/tmp/other.txt'.
    expect((await fixture.backend.stat('/home/../../tmp/other.txt')).path).toBe('/tmp/other.txt')
    // Traversal outside the mount is unreachable: it maps into the fake root.
    const error = await captureError(fixture.backend.stat('/../../../../etc/passwd'))
    expect(error.code).toBe('FS_NOT_FOUND')
    expect(error.message).toContain('/etc/passwd')
    expect(fs.existsSync(path.join(fixture.root, 'etc', 'passwd'))).toBe(false)
  })
})

describe('WslBackend mutations', () => {
  it('creates, renames and removes files and directories', async () => {
    const fixture = createFixture()
    expect(await fixture.backend.mkdir('/home/test', 'newdir')).toBe('/home/test/newdir')
    expect(fs.statSync(path.join(fixture.root, 'home', 'test', 'newdir')).isDirectory()).toBe(true)
    const duplicate = await captureError(fixture.backend.mkdir('/home/test', 'newdir'))
    expect(duplicate.code).toBe('FS_EXISTS')

    expect(await fixture.backend.rename('/home/test/newdir', 'renamed')).toBe('/home/test/renamed')
    expect(fs.existsSync(path.join(fixture.root, 'home', 'test', 'renamed'))).toBe(true)

    writeFixture(fixture, '/home/test/renamed/file.txt', 'data')
    await fixture.backend.remove(['/home/test/renamed/file.txt'], false)
    expect(fs.existsSync(path.join(fixture.root, 'home', 'test', 'renamed', 'file.txt'))).toBe(
      false
    )
    // A non-empty directory needs the recursive flag.
    writeFixture(fixture, '/home/test/renamed/nested.txt', 'nested')
    await expect(fixture.backend.remove(['/home/test/renamed'], false)).rejects.toThrow()
    await fixture.backend.remove(['/home/test/renamed'], true)
    expect(fs.existsSync(path.join(fixture.root, 'home', 'test', 'renamed'))).toBe(false)

    // Removing a missing path is a no-op.
    await expect(fixture.backend.remove(['/home/test/missing'], true)).resolves.toBeUndefined()
  })

  it('streams bytes accurately in both directions', async () => {
    const fixture = createFixture()
    const payload = Buffer.alloc(200 * 1024)
    for (let index = 0; index < payload.length; index += 1) payload[index] = (index * 13) % 256
    writeFixture(fixture, '/home/test/source.bin', payload)

    const downloaded = await collectReadable(
      fixture.backend.createReadStream('/home/test/source.bin')
    )
    expect(downloaded.length).toBe(payload.length)
    expect(downloaded.equals(payload)).toBe(true)

    await writeToStream(fixture.backend.createWriteStream('/home/test/uploaded.bin'), payload)
    const onDisk = fs.readFileSync(path.join(fixture.root, 'home', 'test', 'uploaded.bin'))
    expect(onDisk.equals(payload)).toBe(true)

    await expect(
      collectReadable(fixture.backend.createReadStream('/home/test/nope.bin'))
    ).rejects.toThrow()
  })

  it('sets modification times on native files', async () => {
    const fixture = createFixture()
    writeFixture(fixture, '/home/test/time.txt', 'time')
    const target = new Date('2021-05-06T07:08:09.000Z')
    await fixture.backend.setTimes('/home/test/time.txt', target.getTime())
    const stat = await fixture.backend.stat('/home/test/time.txt')
    expect(Math.abs(stat.mtimeMs - target.getTime())).toBeLessThan(1_500)
  })

  it('skips entries whose metadata cannot be read', async () => {
    const fixture = createFixture()
    writeFixture(fixture, '/home/test/keep-me.txt', 'keep')
    writeFixture(fixture, '/home/test/skip-me.txt', 'skip')

    const originalLstat = fs.promises.lstat
    const mutableFs = fs.promises as unknown as {
      lstat: (target: fs.PathLike, ...rest: unknown[]) => Promise<fs.Stats>
    }
    mutableFs.lstat = async (target: fs.PathLike, ...rest: unknown[]): Promise<fs.Stats> => {
      if (String(target).endsWith(`${path.sep}skip-me.txt`)) throw new Error('lstat failed')
      return (originalLstat as unknown as (...args: unknown[]) => Promise<fs.Stats>)(
        target,
        ...rest
      )
    }
    try {
      const listing = await fixture.backend.list('/home/test')
      const names = listing.entries.map((entry) => entry.name)
      expect(names).toContain('keep-me.txt')
      expect(names).not.toContain('skip-me.txt')
    } finally {
      mutableFs.lstat = originalLstat as unknown as typeof mutableFs.lstat
    }
  })
})

describe('WslBackend resilience', () => {
  it('resolves a missing UNC root lazily through the retry provider', async () => {
    const fixture = createFixture()
    writeFixture(fixture, '/home/test/later.txt', 'later')
    const backend = new WslBackend(null, '/home/test', async () => fixture.root)
    const listing = await backend.list('/home/test')
    expect(listing.entries.map((entry) => entry.name)).toEqual(['later.txt'])
    expect(backend.localPathFor('/home/test/later.txt')).toBe(
      linuxToNative(fixture.root, '/home/test/later.txt')
    )
  })

  it('switches to a refreshed UNC alias without reopening the session', async () => {
    const first = createFixture()
    const second = createFixture()
    writeFixture(second, '/home/test/new-mount.txt', 'new')
    const backend = new WslBackend(first.root, '/home/test')
    backend.updateRoot(second.root)
    const listing = await backend.list('/home/test')
    expect(listing.entries.map((entry) => entry.name)).toEqual(['new-mount.txt'])
    expect(backend.localPathFor('/home/test/new-mount.txt')).toBe(
      linuxToNative(second.root, '/home/test/new-mount.txt')
    )
  })

  it('skips Linux names that Win32 would reinterpret as separators', async () => {
    if (process.platform === 'win32') return
    const fixture = createFixture()
    writeFixture(fixture, '/home/test/normal.txt', 'normal')
    fs.writeFileSync(path.join(fixture.root, 'home', 'test', 'back\\slash.txt'), 'bad')
    const listing = await fixture.backend.list('/home/test')
    expect(listing.entries.map((entry) => entry.name)).toEqual(['normal.txt'])
    expect((await captureError(fixture.backend.stat('/home/test/back\\slash.txt'))).code).toBe(
      'FS_INVALID_PATH'
    )
  })
})

describe('WslBackend with TransferEngine', () => {
  it('uploads a local file into the WSL mount and downloads it back', async () => {
    const fixture = createFixture()
    const sourceDir = tempDir('termshelf-wsl-source-')
    const downloadDir = tempDir('termshelf-wsl-download-')
    const sourceFile = path.join(sourceDir, 'payload.bin')
    const payload = Buffer.alloc(160 * 1024)
    for (let index = 0; index < payload.length; index += 1) payload[index] = (index * 7) % 256
    fs.writeFileSync(sourceFile, payload)
    const sourceTime = new Date('2021-05-06T07:08:09.000Z')
    fs.utimesSync(sourceFile, sourceTime, sourceTime)

    const engine = new TransferEngine({
      getBackend: () => fixture.backend,
      emit: () => undefined
    })

    const upload = await engine.start({
      sessionId: 'wsl-session',
      direction: 'upload',
      sources: [sourceFile],
      destDir: '/home/test',
      conflictPolicy: 'overwrite'
    })
    expect(upload.status).toBe('started')
    if (upload.status !== 'started') return
    expect(upload.job.bytesTotal).toBe(payload.length)
    expect(upload.job.filesTotal).toBe(1)
    const uploaded = await waitForJob(engine, upload.job.id)
    expect(uploaded.state).toBe('completed')
    expect(uploaded.bytesDone).toBe(payload.length)
    expect(uploaded.filesDone).toBe(1)

    const nativeUpload = path.join(fixture.root, 'home', 'test', 'payload.bin')
    expect(fs.readFileSync(nativeUpload).equals(payload)).toBe(true)
    // Uploads preserve the source mtime through WslBackend.setTimes.
    const uploadedStat = await fixture.backend.stat('/home/test/payload.bin')
    expect(Math.abs(uploadedStat.mtimeMs - sourceTime.getTime())).toBeLessThan(2_000)

    // A second upload with the ask policy reports the conflict first.
    const conflict = await engine.start({
      sessionId: 'wsl-session',
      direction: 'upload',
      sources: [sourceFile],
      destDir: '/home/test',
      conflictPolicy: 'ask'
    })
    expect(conflict.status).toBe('conflicts')

    const download = await engine.start({
      sessionId: 'wsl-session',
      direction: 'download',
      sources: ['/home/test/payload.bin'],
      destDir: downloadDir,
      conflictPolicy: 'overwrite'
    })
    expect(download.status).toBe('started')
    if (download.status !== 'started') return
    const downloaded = await waitForJob(engine, download.job.id)
    expect(downloaded.state).toBe('completed')
    expect(downloaded.filesDone).toBe(1)

    const localDownload = path.join(downloadDir, 'payload.bin')
    expect(fs.readFileSync(localDownload).equals(payload)).toBe(true)
    // Downloads are stamped with the completion time, not the old source mtime.
    const downloadStat = fs.statSync(localDownload)
    expect(Date.now() - downloadStat.mtimeMs).toBeLessThan(60_000)
    expect(Math.abs(downloadStat.mtimeMs - sourceTime.getTime())).toBeGreaterThan(
      24 * 60 * 60 * 1000
    )
  })

  it('rejects uploading a WSL file onto itself through its Windows UNC path', async () => {
    const fixture = createFixture()
    writeFixture(fixture, '/home/test/same.txt', 'keep this data')
    const source = path.join(fixture.root, 'home', 'test', 'same.txt')
    const engine = new TransferEngine({ getBackend: () => fixture.backend, emit: () => undefined })
    const result = await engine.start({
      sessionId: 'wsl-session',
      direction: 'upload',
      sources: [source],
      destDir: '/home/test',
      conflictPolicy: 'overwrite'
    })
    expect(result.status).toBe('invalid')
    if (result.status !== 'invalid') return
    expect(result.message).toMatch(/same file/i)
    expect(fs.readFileSync(source, 'utf8')).toBe('keep this data')
  })

  it('offers Keep both instead of rejecting a self-copy conflict', async () => {
    const fixture = createFixture()
    writeFixture(fixture, '/home/test/same.txt', 'keep this data')
    const source = path.join(fixture.root, 'home', 'test', 'same.txt')
    const engine = new TransferEngine({ getBackend: () => fixture.backend, emit: () => undefined })

    const ask = await engine.start({
      sessionId: 'wsl-session',
      direction: 'upload',
      sources: [source],
      destDir: '/home/test',
      conflictPolicy: 'ask'
    })
    expect(ask.status).toBe('conflicts')

    const keepBoth = await engine.start({
      sessionId: 'wsl-session',
      direction: 'upload',
      sources: [source],
      destDir: '/home/test',
      conflictPolicy: 'keepBoth'
    })
    expect(keepBoth.status).toBe('started')
    if (keepBoth.status !== 'started') return
    const job = await waitForJob(engine, keepBoth.job.id)
    expect(job.state).toBe('completed')
    expect(fs.readFileSync(source, 'utf8')).toBe('keep this data')
    const names = (await fixture.backend.list('/home/test')).entries.map((entry) => entry.name)
    expect(names).toContain('same.txt')
    expect(names.some((name) => name !== 'same.txt' && name.startsWith('same'))).toBe(true)
  })

  it('rejects downloading a WSL file onto itself through its Windows UNC destination', async () => {
    const fixture = createFixture()
    writeFixture(fixture, '/home/test/same.txt', 'keep this data')
    const engine = new TransferEngine({ getBackend: () => fixture.backend, emit: () => undefined })
    const result = await engine.start({
      sessionId: 'wsl-session',
      direction: 'download',
      sources: ['/home/test/same.txt'],
      destDir: path.join(fixture.root, 'home', 'test'),
      conflictPolicy: 'overwrite'
    })
    expect(result.status).toBe('invalid')
    if (result.status !== 'invalid') return
    expect(result.message).toMatch(/same file/i)
    expect(fs.readFileSync(path.join(fixture.root, 'home', 'test', 'same.txt'), 'utf8')).toBe(
      'keep this data'
    )
  })

  it('refuses to overwrite a nested symlink target that is also its destination', async () => {
    if (process.platform === 'win32') return
    const fixture = createFixture()
    // Download /home/test/src into /home/test/out. /home/test/src/alias is a
    // symlink whose target is exactly /home/test/out/src/alias.
    fs.mkdirSync(path.join(fixture.root, 'home', 'test', 'src'), { recursive: true })
    fs.mkdirSync(path.join(fixture.root, 'home', 'test', 'out', 'src'), { recursive: true })
    fs.writeFileSync(path.join(fixture.root, 'home', 'test', 'out', 'src', 'alias'), 'precious')
    fs.symlinkSync('../out/src/alias', path.join(fixture.root, 'home', 'test', 'src', 'alias'))

    const engine = new TransferEngine({ getBackend: () => fixture.backend, emit: () => undefined })
    const started = await engine.start({
      sessionId: 'wsl-session',
      direction: 'download',
      sources: ['/home/test/src'],
      destDir: path.join(fixture.root, 'home', 'test', 'out'),
      conflictPolicy: 'overwrite'
    })
    expect(started.status).toBe('started')
    if (started.status !== 'started') return
    const job = await waitForJob(engine, started.job.id)
    expect(job.state).toBe('failed')
    expect(
      fs.readFileSync(path.join(fixture.root, 'home', 'test', 'out', 'src', 'alias'), 'utf8')
    ).toBe('precious')
  })

  it('uploads a directory tree through the WSL backend', async () => {
    const fixture = createFixture()
    const sourceDir = tempDir('termshelf-wsl-tree-')
    fs.mkdirSync(path.join(sourceDir, 'dataset', 'sub'), { recursive: true })
    fs.writeFileSync(path.join(sourceDir, 'dataset', 'a.txt'), 'AAA')
    fs.writeFileSync(path.join(sourceDir, 'dataset', 'sub', 'b.txt'), 'BBB')

    const engine = new TransferEngine({ getBackend: () => fixture.backend, emit: () => undefined })
    const started = await engine.start({
      sessionId: 'wsl-session',
      direction: 'upload',
      sources: [path.join(sourceDir, 'dataset')],
      destDir: '/home/test',
      conflictPolicy: 'overwrite'
    })
    expect(started.status).toBe('started')
    if (started.status !== 'started') return
    const job = await waitForJob(engine, started.job.id)
    expect(job.state).toBe('completed')
    expect(job.filesDone).toBe(2)

    expect(
      fs.readFileSync(path.join(fixture.root, 'home', 'test', 'dataset', 'a.txt'), 'utf8')
    ).toBe('AAA')
    expect(
      fs.readFileSync(path.join(fixture.root, 'home', 'test', 'dataset', 'sub', 'b.txt'), 'utf8')
    ).toBe('BBB')
  })
})
