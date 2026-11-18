/**
 * Integration tests for the TermShelf dev/demo SSH server (tools/dev-sshd/server.ts).
 *
 * Everything runs in-process against an ephemeral port (`port: 0`) and a temporary
 * SFTP root, so the suite is safe to run in parallel with other test files.
 */
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { Client } from 'ssh2'
import type { ClientChannel, FileEntryWithStats, PseudoTtyOptions, SFTPWrapper, Stats } from 'ssh2'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateClientKeyPair, startDevSshd } from '../../tools/dev-sshd/server'
import type { DevSshdHandle } from '../../tools/dev-sshd/server'

const BIG_FILE_SIZE = 300 * 1024

/** Deterministic payload so partial reads can be verified byte-for-byte. */
function makeBigBuffer(): Buffer {
  const buffer = Buffer.alloc(BIG_FILE_SIZE)
  for (let index = 0; index < buffer.length; index += 1) buffer[index] = index % 251
  return buffer
}

const bigBuffer = makeBigBuffer()
const PTY_COMMAND = process.platform === 'win32' ? 'echo shell-ok' : 'printf shell-ok'

let workDir: string
let root: string
let realRoot: string
let sshd: DevSshdHandle
let client: Client
let sftp: SFTPWrapper

/* -------------------------------------------------------------------------- */
/* ssh2 client helpers                                                        */
/* -------------------------------------------------------------------------- */

interface ConnectOptions {
  password?: string
  privateKey?: string
  hostVerifier?: (key: Buffer) => boolean
}

function connectClient(target: DevSshdHandle, options: ConnectOptions = {}): Promise<Client> {
  return new Promise((resolve, reject) => {
    const socket = new Client()
    let settled = false
    // Keep unexpected post-ready errors from crashing the test process.
    socket.on('error', () => undefined)
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      socket.end()
      reject(new Error('SSH connection timed out'))
    }, 15_000)
    const settle = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) {
        socket.end()
        reject(error)
        return
      }
      resolve(socket)
    }
    socket.once('ready', () => settle())
    socket.once('error', (error: Error) => settle(error))
    socket.connect({
      host: target.host,
      port: target.port,
      username: target.username,
      password: options.password ?? target.password,
      ...(options.privateKey ? { privateKey: options.privateKey } : {}),
      ...(options.hostVerifier ? { hostVerifier: options.hostVerifier } : {})
    })
  })
}

function openSftp(target: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    target.sftp((error, sftpClient) => (error ? reject(error) : resolve(sftpClient)))
  })
}

function callRealpath(target: SFTPWrapper, remotePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    target.realpath(remotePath, (error, resolved) => (error ? reject(error) : resolve(resolved)))
  })
}

function callStat(target: SFTPWrapper, remotePath: string): Promise<Stats> {
  return new Promise((resolve, reject) => {
    target.stat(remotePath, (error, stats) => (error ? reject(error) : resolve(stats)))
  })
}

function callLstat(target: SFTPWrapper, remotePath: string): Promise<Stats> {
  return new Promise((resolve, reject) => {
    target.lstat(remotePath, (error, stats) => (error ? reject(error) : resolve(stats)))
  })
}

function callReaddir(target: SFTPWrapper, remotePath: string): Promise<FileEntryWithStats[]> {
  return new Promise((resolve, reject) => {
    target.readdir(remotePath, (error, entries) => (error ? reject(error) : resolve(entries)))
  })
}

function callVoid(run: (callback: (error?: Error | null) => void) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    run((error) => (error ? reject(error) : resolve()))
  })
}

function callMkdir(target: SFTPWrapper, remotePath: string): Promise<void> {
  return callVoid((callback) => target.mkdir(remotePath, callback))
}

function callRename(target: SFTPWrapper, from: string, to: string): Promise<void> {
  return callVoid((callback) => target.rename(from, to, callback))
}

function callUnlink(target: SFTPWrapper, remotePath: string): Promise<void> {
  return callVoid((callback) => target.unlink(remotePath, callback))
}

function callRmdir(target: SFTPWrapper, remotePath: string): Promise<void> {
  return callVoid((callback) => target.rmdir(remotePath, callback))
}

function callChmod(target: SFTPWrapper, remotePath: string, mode: number): Promise<void> {
  return callVoid((callback) => target.chmod(remotePath, mode, callback))
}

function callUtimes(
  target: SFTPWrapper,
  remotePath: string,
  atime: Date,
  mtime: Date
): Promise<void> {
  return callVoid((callback) => target.utimes(remotePath, atime, mtime, callback))
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

function uploadFile(target: SFTPWrapper, remotePath: string, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = target.createWriteStream(remotePath)
    stream.on('error', reject)
    stream.on('close', () => resolve())
    stream.end(data)
  })
}

interface ExecResult {
  code: number | undefined
  stdout: string
  stderr: string
}

function execCommand(
  target: Client,
  command: string,
  ptyOptions?: PseudoTtyOptions
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const onExec = (error: Error | undefined, stream: ClientChannel): void => {
      if (error) {
        reject(error)
        return
      }
      let stdout = ''
      let stderr = ''
      let code: number | undefined
      stream.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
      })
      stream.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })
      stream.on('exit', (exitCode: number | null) => {
        if (typeof exitCode === 'number') code = exitCode
      })
      stream.on('close', (closeCode?: number) => {
        if (typeof closeCode === 'number' && code === undefined) code = closeCode
        resolve({ code, stdout, stderr })
      })
      stream.on('error', reject)
    }
    if (ptyOptions) target.exec(command, { pty: ptyOptions }, onExec)
    else target.exec(command, onExec)
  })
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/* -------------------------------------------------------------------------- */
/* Suite setup                                                                */
/* -------------------------------------------------------------------------- */

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'termshelf-dev-sshd-'))
  root = path.join(workDir, 'remote')
  await mkdir(path.join(root, 'subdir'), { recursive: true })
  await writeFile(path.join(root, 'hello.txt'), 'hello from dev-sshd\n')
  await writeFile(path.join(root, 'subdir', 'nested.txt'), 'nested\n')
  await writeFile(path.join(root, 'big.bin'), bigBuffer)
  realRoot = await realpath(root)

  sshd = await startDevSshd({
    root,
    host: '127.0.0.1',
    port: 0,
    hostKeyPath: path.join(workDir, 'host.key')
  })
  client = await connectClient(sshd)
  sftp = await openSftp(client)
})

afterAll(async () => {
  try {
    client?.end()
  } catch {
    // ignore
  }
  await sshd?.close()
  await rm(workDir, { recursive: true, force: true })
})

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe('dev sshd', () => {
  it('binds an ephemeral port and reports connection details', () => {
    expect(sshd.port).toBeGreaterThan(0)
    expect(sshd.port).toBeLessThanOrEqual(65535)
    expect(sshd.host).toBe('127.0.0.1')
    expect(sshd.username).toBe('demo')
    expect(sshd.sftpPathMode).toBe('virtual')
    expect(sshd.password).toBe('demo')
    expect(sshd.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/)
    expect(sshd.root).toBe(realRoot)
  })

  it('serves the same host key fingerprint clients observe', async () => {
    let observed: string | undefined
    const hostVerifier = (key: Buffer): boolean => {
      observed = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
      return true
    }
    const verified = await connectClient(sshd, { hostVerifier })
    try {
      expect(observed).toBe(sshd.fingerprint)
    } finally {
      verified.end()
    }
  })

  it('reuses a persisted host key on restart', async () => {
    const second = await startDevSshd({
      root,
      port: 0,
      hostKeyPath: path.join(workDir, 'host.key')
    })
    try {
      expect(second.fingerprint).toBe(sshd.fingerprint)
    } finally {
      await second.close()
    }
  })

  it('rejects a wrong password', async () => {
    await expect(connectClient(sshd, { password: 'not-the-demo-password' })).rejects.toThrow(
      /authentication/i
    )
  })

  it('accepts an authorized public key and rejects an unknown key', async () => {
    const authorized = generateClientKeyPair()
    const unauthorized = generateClientKeyPair()
    const keyServer = await startDevSshd({
      root: path.join(workDir, 'key-auth-remote'),
      port: 0,
      hostKeyPath: path.join(workDir, 'key-host.key'),
      authorizedKeys: [authorized.publicKey]
    })
    try {
      // Password is deliberately wrong so success proves the publickey path.
      const keyClient = await connectClient(keyServer, {
        password: 'wrong-password',
        privateKey: authorized.privateKey
      })
      try {
        const keySftp = await openSftp(keyClient)
        expect(await callRealpath(keySftp, '/')).toBe('/')
      } finally {
        keyClient.end()
      }
      await expect(
        connectClient(keyServer, {
          password: 'wrong-password',
          privateKey: unauthorized.privateKey
        })
      ).rejects.toThrow(/authentication/i)
    } finally {
      await keyServer.close()
    }
  })

  it('exposes the sandboxed filesystem root over SFTP', async () => {
    expect(await callRealpath(sftp, '/')).toBe('/')
    expect(await callRealpath(sftp, '.')).toBe('/')

    const hello = await callStat(sftp, '/hello.txt')
    expect(hello.isFile()).toBe(true)
    expect(hello.size).toBe(Buffer.byteLength('hello from dev-sshd\n'))
    // Windows does not expose POSIX permission bits; keep the mode check POSIX-only.
    if (process.platform !== 'win32') expect(hello.mode & 0o777).toBe(0o644)

    const entries = await callReaddir(sftp, '/')
    const names = entries.map((entry) => entry.filename).sort()
    expect(names).toEqual(['big.bin', 'hello.txt', 'subdir'])
    const subdir = entries.find((entry) => entry.filename === 'subdir')
    expect(subdir?.attrs.isDirectory()).toBe(true)
    const nested = await callStat(sftp, '/subdir/nested.txt')
    expect(nested.isFile()).toBe(true)
  })

  it('clamps path traversal to the sandbox root', async () => {
    // Clamping must map /../../etc/passwd to the virtual /etc/passwd, not the host file.
    const statError = await callStat(sftp, '/../../etc/passwd').then(
      () => undefined,
      (error: Error & { code?: number }) => error
    )
    expect(statError).toBeDefined()
    expect(statError?.code).toBe(2) // SSH_FX_NO_SUCH_FILE
    expect(await callRealpath(sftp, '/..')).toBe('/')

    // A traversal write lands inside the sandbox instead of outside of it.
    await callVoid((callback) => sftp.writeFile('/../escaped.txt', 'clamped', callback))
    expect(await readFile(path.join(root, 'escaped.txt'), 'utf8')).toBe('clamped')
    await expect(readFile(path.join(workDir, 'escaped.txt'), 'utf8')).rejects.toThrow()
    await callUnlink(sftp, '/escaped.txt')
  })

  it('downloads files with createReadStream', async () => {
    const downloaded = await collectReadable(sftp.createReadStream('/big.bin'))
    expect(downloaded.length).toBe(BIG_FILE_SIZE)
    expect(downloaded.equals(bigBuffer)).toBe(true)

    const slice = await collectReadable(
      sftp.createReadStream('/big.bin', { start: 1000, end: 1999 })
    )
    expect(slice.length).toBe(1000)
    expect(slice.equals(bigBuffer.subarray(1000, 2000))).toBe(true)
  })

  it('uploads files with createWriteStream', async () => {
    await callMkdir(sftp, '/uploads')
    const payload = Buffer.alloc(128 * 1024)
    for (let index = 0; index < payload.length; index += 1) payload[index] = (index * 7) % 256
    await uploadFile(sftp, '/uploads/uploaded.bin', payload)

    const onDisk = await readFile(path.join(root, 'uploads', 'uploaded.bin'))
    expect(onDisk.equals(payload)).toBe(true)
    const stats = await callStat(sftp, '/uploads/uploaded.bin')
    expect(stats.size).toBe(payload.length)
  })

  it('creates, renames, chmods, touches and removes entries', async () => {
    await callMkdir(sftp, '/newdir')
    expect((await callStat(sftp, '/newdir')).isDirectory()).toBe(true)

    await callRename(sftp, '/newdir', '/renamed')
    expect((await callStat(sftp, '/renamed')).isDirectory()).toBe(true)
    await expect(callStat(sftp, '/newdir')).rejects.toThrow()

    await uploadFile(sftp, '/renamed/file.txt', Buffer.from('movable'))
    await callRename(sftp, '/renamed/file.txt', '/renamed/moved.txt')
    expect((await callLstat(sftp, '/renamed/moved.txt')).isFile()).toBe(true)

    // chmod semantics differ on Windows (only the read-only bit); keep it POSIX-only.
    if (process.platform !== 'win32') {
      await callChmod(sftp, '/hello.txt', 0o600)
      expect((await callStat(sftp, '/hello.txt')).mode & 0o777).toBe(0o600)
      await callChmod(sftp, '/hello.txt', 0o644)
    }

    const touchTime = new Date(1_700_000_000 * 1000)
    await callUtimes(sftp, '/hello.txt', touchTime, touchTime)
    const touched = await callStat(sftp, '/hello.txt')
    expect(touched.atime).toBe(1_700_000_000)
    expect(touched.mtime).toBe(1_700_000_000)

    await callUnlink(sftp, '/renamed/moved.txt')
    await expect(callStat(sftp, '/renamed/moved.txt')).rejects.toThrow()
    await callRmdir(sftp, '/renamed')
    await expect(callStat(sftp, '/renamed')).rejects.toThrow()
  })

  it('runs an exec request over a pty', async () => {
    const result = await execCommand(client, PTY_COMMAND, {
      cols: 90,
      rows: 30,
      term: 'xterm-256color'
    })
    expect(result.stdout).toContain('shell-ok')
    expect(result.code).toBe(0)
  })

  it('runs an exec request without a pty', async () => {
    const result = await execCommand(client, PTY_COMMAND)
    expect(result.stdout).toContain('shell-ok')
    expect(result.code).toBe(0)
  })

  it.skipIf(process.platform === 'win32')('serves an interactive pty shell', async () => {
    const stream = await new Promise<ClientChannel>((resolve, reject) => {
      client.shell({ cols: 100, rows: 30, term: 'xterm-256color' }, (error, channel) =>
        error ? reject(error) : resolve(channel)
      )
    })
    let output = ''
    stream.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
    })
    stream.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
    })
    const closed = once(stream, 'close')
    // The echoed command contains "dev-sshd-$(...", the output contains "dev-sshd-shell".
    stream.write('echo dev-sshd-$(printf shell)\n')
    stream.write('exit\n')
    await withTimeout(closed, 15_000, 'interactive shell close')
    expect(output).toContain('dev-sshd-shell')
  })

  it('closes cleanly and refuses new connections afterwards', async () => {
    const disposable = await startDevSshd({
      root: path.join(workDir, 'disposable-remote'),
      port: 0,
      hostKeyPath: path.join(workDir, 'disposable-host.key')
    })
    const port = disposable.port
    const disposableClient = await connectClient(disposable)
    disposableClient.end()
    await disposable.close()
    await disposable.close() // idempotent

    const reconnect = await startDevSshd({ root: path.join(workDir, 'disposable-remote'), port })
    expect(reconnect.port).toBe(port)
    await reconnect.close()
  })
})

/**
 * Absolute SFTP path mode: the client namespace is the real host namespace under
 * the sandbox root, matching what a pty shell sees. This is what the app needs to
 * validate remote folder sync (OSC 7): the shell writes/reports a path and the
 * SFTP backend must be able to list that same path.
 */
describe.skipIf(process.platform === 'win32')('dev sshd (absolute sftp path mode)', () => {
  let absoluteRoot: string
  let absoluteRealRoot: string
  let absoluteSshd: DevSshdHandle
  let absoluteClient: Client
  let absoluteSftp: SFTPWrapper

  beforeAll(async () => {
    absoluteRoot = path.join(workDir, 'absolute-remote')
    await mkdir(path.join(absoluteRoot, 'docs'), { recursive: true })
    await writeFile(path.join(absoluteRoot, 'note.txt'), 'absolute mode\n')
    await writeFile(path.join(absoluteRoot, 'docs', 'guide.md'), 'guide\n')
    absoluteRealRoot = await realpath(absoluteRoot)
    absoluteSshd = await startDevSshd({
      root: absoluteRoot,
      port: 0,
      hostKeyPath: path.join(workDir, 'absolute-host.key'),
      sftpPathMode: 'absolute'
    })
    absoluteClient = await connectClient(absoluteSshd)
    absoluteSftp = await openSftp(absoluteClient)
  })

  afterAll(async () => {
    try {
      absoluteClient?.end()
    } catch {
      // ignore
    }
    await absoluteSshd?.close()
  })

  it('reports the absolute root through realpath and lists absolute paths', async () => {
    expect(absoluteSshd.sftpPathMode).toBe('absolute')
    expect(absoluteSshd.root).toBe(absoluteRealRoot)
    expect(await callRealpath(absoluteSftp, '.')).toBe(absoluteRealRoot)
    expect(await callRealpath(absoluteSftp, absoluteRealRoot)).toBe(absoluteRealRoot)

    const entries = await callReaddir(absoluteSftp, absoluteRealRoot)
    expect(entries.map((entry) => entry.filename).sort()).toEqual(['docs', 'note.txt'])
    const note = await callStat(absoluteSftp, path.join(absoluteRealRoot, 'note.txt'))
    expect(note.isFile()).toBe(true)
    expect(note.size).toBe(Buffer.byteLength('absolute mode\n'))
    expect((await callStat(absoluteSftp, path.join(absoluteRealRoot, 'docs'))).isDirectory()).toBe(
      true
    )
  })

  it('round-trips uploads and downloads with absolute paths', async () => {
    const payload = Buffer.from('absolute upload payload')
    const remoteFile = path.join(absoluteRealRoot, 'docs', 'uploaded.bin')
    await uploadFile(absoluteSftp, remoteFile, payload)
    expect((await readFile(path.join(absoluteRoot, 'docs', 'uploaded.bin'))).equals(payload)).toBe(
      true
    )

    const downloaded = await collectReadable(absoluteSftp.createReadStream(remoteFile))
    expect(downloaded.equals(payload)).toBe(true)

    const newDir = path.join(absoluteRealRoot, 'created-dir')
    await callMkdir(absoluteSftp, newDir)
    expect((await callStat(absoluteSftp, newDir)).isDirectory()).toBe(true)
    await callRmdir(absoluteSftp, newDir)
  })

  it('rejects paths outside the absolute sandbox root', async () => {
    const outsideRead = await callStat(absoluteSftp, '/etc/passwd').then(
      () => undefined,
      (error: Error & { code?: number }) => error
    )
    expect(outsideRead).toBeDefined()
    expect(outsideRead?.code).toBe(3) // SSH_FX_PERMISSION_DENIED

    const outsidePath = path.join(path.dirname(absoluteRealRoot), 'termshelf-outside.txt')
    const outsideWrite = await callVoid((callback) =>
      absoluteSftp.writeFile(outsidePath, 'must not be written', callback)
    ).then(
      () => undefined,
      (error: Error & { code?: number }) => error
    )
    expect(outsideWrite).toBeDefined()
    await expect(readFile(outsidePath, 'utf8')).rejects.toThrow()
  })

  it('runs the pty shell in the same directory that SFTP reports as the root', async () => {
    const result = await execCommand(absoluteClient, 'printf %s "$PWD"', {
      cols: 80,
      rows: 24,
      term: 'xterm-256color'
    })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(absoluteRealRoot)
  })
})
