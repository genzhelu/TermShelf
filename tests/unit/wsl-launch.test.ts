import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppError } from '../../src/main/errors'
import { prepareWslShellLaunch } from '../../src/main/wsl/launch'
import { linuxToNative } from '../../src/main/wsl/paths'
import type { WslContext, WslService } from '../../src/main/wsl/service'

const WSL_EXE = 'C:\\fake\\wsl.exe'

const directories: string[] = []

function tempDir(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  directories.push(directory)
  return directory
}

interface FakeWslService {
  service: WslService
  readableCalls: Array<[string, string]>
}

interface FakeServiceOptions {
  executablePath?: string | null
  readable?: boolean | ((distro: string, linuxPath: string) => boolean | Promise<boolean>)
}

/**
 * Structural stand-in for WslService: the launcher only uses executablePath and
 * testReadable, and never spawns anything, so no wsl.exe is required on Linux/CI.
 */
function fakeService(options: FakeServiceOptions = {}): FakeWslService {
  const readableCalls: Array<[string, string]> = []
  const executablePath = options.executablePath === undefined ? WSL_EXE : options.executablePath
  const service = {
    get executablePath(): string | null {
      return executablePath
    },
    async testReadable(distro: string, linuxPath: string): Promise<boolean> {
      readableCalls.push([distro, linuxPath])
      const readable = options.readable
      if (typeof readable === 'function') return readable(distro, linuxPath)
      return readable ?? true
    }
  }
  return { service: service as unknown as WslService, readableCalls }
}

function makeContext(uncRoot: string | null, overrides: Partial<WslContext> = {}): WslContext {
  return {
    distro: 'Ubuntu',
    homePath: '/home/test',
    shellPath: '/bin/bash',
    uncRoot,
    uncRootCandidates: [],
    ...overrides
  }
}

function scriptDir(uncRoot: string, sessionId: string): string {
  return linuxToNative(uncRoot, `/tmp/termshelf-${sessionId}`)
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('prepareWslShellLaunch — bash', () => {
  it('writes an init script through the UNC mount and runs bash with --rcfile', async () => {
    const uncRoot = tempDir('termshelf-wsl-unc-')
    const { service, readableCalls } = fakeService()
    const sessionId = 'sess-bash'
    const result = await prepareWslShellLaunch({
      service,
      context: makeContext(uncRoot),
      sessionId
    })

    expect(result.integrated).toBe(true)
    expect(result.file).toBe(WSL_EXE)
    expect(result.label).toBe('WSL · Ubuntu · bash')
    expect(result.env).toEqual({ TERMSHELF_SHELL_INTEGRATION: 'bash' })
    // --cd makes the shell start in the Linux home rather than the Windows cwd.
    expect(result.args).toEqual([
      '-d',
      'Ubuntu',
      '--cd',
      '/home/test',
      '-e',
      '/bin/bash',
      '-l',
      '-c',
      "exec '/bin/bash' --rcfile '/tmp/termshelf-sess-bash/bashrc' -i"
    ])

    const nativeDir = scriptDir(uncRoot, sessionId)
    const initPath = path.join(nativeDir, 'bashrc')
    expect(fs.existsSync(initPath)).toBe(true)
    expect(fs.readFileSync(initPath, 'utf8')).toContain('TermShelf shell integration (bash)')
    expect(readableCalls).toEqual([['Ubuntu', '/tmp/termshelf-sess-bash/bashrc']])

    await result.cleanup()
    expect(fs.existsSync(nativeDir)).toBe(false)
    // Cleanup is idempotent.
    await expect(result.cleanup()).resolves.toBeUndefined()
  })

  it('defaults --cd to / when the context has no home path', async () => {
    const uncRoot = tempDir('termshelf-wsl-unc-')
    const { service } = fakeService()
    const result = await prepareWslShellLaunch({
      service,
      context: makeContext(uncRoot, { homePath: '' }),
      sessionId: 'sess-home'
    })
    expect(result.integrated).toBe(true)
    expect(result.args.slice(0, 4)).toEqual(['-d', 'Ubuntu', '--cd', '/'])
    await result.cleanup()
  })

  it('sanitizes the session id so scripts stay under /tmp', async () => {
    const uncRoot = tempDir('termshelf-wsl-unc-')
    const { service } = fakeService()
    const result = await prepareWslShellLaunch({
      service,
      context: makeContext(uncRoot),
      sessionId: 'weird id/../x:y'
    })
    expect(result.integrated).toBe(true)
    const lastArg = result.args[result.args.length - 1] ?? ''
    expect(lastArg).toContain("--rcfile '/tmp/termshelf-weird_id_.._x_y/bashrc'")
    // The token cannot add path separators (no traversal out of /tmp).
    expect(lastArg).not.toContain("'/../")
    expect(lastArg).not.toContain('weird id')
    expect(fs.existsSync(path.join(uncRoot, 'tmp'))).toBe(true)
    await result.cleanup()
  })
})

describe('prepareWslShellLaunch — zsh', () => {
  it('writes zdotdir init files and launches zsh with ZDOTDIR', async () => {
    const uncRoot = tempDir('termshelf-wsl-unc-')
    const { service, readableCalls } = fakeService()
    const result = await prepareWslShellLaunch({
      service,
      context: makeContext(uncRoot, { shellPath: '/usr/bin/zsh' }),
      sessionId: 'sess-zsh'
    })

    expect(result.integrated).toBe(true)
    expect(result.label).toBe('WSL · Ubuntu · zsh')
    expect(result.env).toEqual({ TERMSHELF_SHELL_INTEGRATION: 'zsh' })
    expect(result.args).toEqual([
      '-d',
      'Ubuntu',
      '--cd',
      '/home/test',
      '-e',
      'env',
      'ZDOTDIR=/tmp/termshelf-sess-zsh',
      '/usr/bin/zsh',
      '-l'
    ])

    const nativeDir = scriptDir(uncRoot, 'sess-zsh')
    for (const name of ['.zshenv', '.zprofile', '.zshrc', '.zlogin']) {
      expect(fs.existsSync(path.join(nativeDir, name))).toBe(true)
    }
    expect(readableCalls).toEqual([['Ubuntu', '/tmp/termshelf-sess-zsh/.zshrc']])

    await result.cleanup()
    expect(fs.existsSync(nativeDir)).toBe(false)
  })
})

describe('prepareWslShellLaunch — fish', () => {
  it('sources the generated fish init file', async () => {
    const uncRoot = tempDir('termshelf-wsl-unc-')
    const { service, readableCalls } = fakeService()
    const result = await prepareWslShellLaunch({
      service,
      context: makeContext(uncRoot, { shellPath: '/usr/bin/fish' }),
      sessionId: 'sess-fish'
    })

    expect(result.integrated).toBe(true)
    expect(result.label).toBe('WSL · Ubuntu · fish')
    expect(result.env).toEqual({ TERMSHELF_SHELL_INTEGRATION: 'fish' })
    expect(result.args).toEqual([
      '-d',
      'Ubuntu',
      '--cd',
      '/home/test',
      '-e',
      '/usr/bin/fish',
      '-l',
      '-C',
      "source '/tmp/termshelf-sess-fish/fish.fish'"
    ])

    const nativeDir = scriptDir(uncRoot, 'sess-fish')
    expect(fs.existsSync(path.join(nativeDir, 'fish.fish'))).toBe(true)
    expect(readableCalls).toEqual([['Ubuntu', '/tmp/termshelf-sess-fish/fish.fish']])

    await result.cleanup()
    expect(fs.existsSync(nativeDir)).toBe(false)
  })
})

describe('prepareWslShellLaunch — plain fallbacks', () => {
  it('falls back to a plain wsl.exe launch for unsupported shells', async () => {
    const uncRoot = tempDir('termshelf-wsl-unc-')
    const { service, readableCalls } = fakeService()
    const result = await prepareWslShellLaunch({
      service,
      context: makeContext(uncRoot, { shellPath: '/bin/sh' }),
      sessionId: 'sess-sh'
    })
    expect(result.integrated).toBe(false)
    expect(result.label).toBe('WSL · Ubuntu')
    expect(result.env).toEqual({})
    expect(result.args).toEqual(['-d', 'Ubuntu', '--cd', '/home/test'])
    expect(readableCalls).toEqual([])
    expect(fs.existsSync(path.join(uncRoot, 'tmp'))).toBe(false)
    await expect(result.cleanup()).resolves.toBeUndefined()
  })

  it('falls back when the UNC root is unavailable', async () => {
    const { service, readableCalls } = fakeService()
    const result = await prepareWslShellLaunch({
      service,
      context: makeContext(null),
      sessionId: 'sess-null'
    })
    expect(result.integrated).toBe(false)
    expect(result.args).toEqual(['-d', 'Ubuntu', '--cd', '/home/test'])
    expect(readableCalls).toEqual([])
  })

  it('falls back and removes its scripts when wsl.exe cannot read them', async () => {
    const uncRoot = tempDir('termshelf-wsl-unc-')
    const { service } = fakeService({ readable: false })
    const result = await prepareWslShellLaunch({
      service,
      context: makeContext(uncRoot),
      sessionId: 'sess-unreadable'
    })
    expect(result.integrated).toBe(false)
    expect(fs.existsSync(scriptDir(uncRoot, 'sess-unreadable'))).toBe(false)
  })

  it('falls back and cleans up when the readable probe throws', async () => {
    const uncRoot = tempDir('termshelf-wsl-unc-')
    const { service } = fakeService({
      readable: () => {
        throw new Error('wsl test -r failed')
      }
    })
    const result = await prepareWslShellLaunch({
      service,
      context: makeContext(uncRoot),
      sessionId: 'sess-probe-error'
    })
    expect(result.integrated).toBe(false)
    expect(fs.existsSync(scriptDir(uncRoot, 'sess-probe-error'))).toBe(false)
  })

  it('falls back when the init script cannot be written', async () => {
    const notADirectory = path.join(tempDir('termshelf-wsl-file-'), 'not-a-dir')
    fs.writeFileSync(notADirectory, 'file')
    const { service } = fakeService()
    const result = await prepareWslShellLaunch({
      service,
      context: makeContext(notADirectory),
      sessionId: 'sess-write-fail'
    })
    expect(result.integrated).toBe(false)
    expect(result.args).toEqual(['-d', 'Ubuntu', '--cd', '/home/test'])
  })

  it('throws WSL_UNAVAILABLE when wsl.exe is missing', async () => {
    const { service } = fakeService({ executablePath: null })
    const error = await prepareWslShellLaunch({
      service,
      context: makeContext(tempDir('termshelf-wsl-unc-')),
      sessionId: 'sess-no-exe'
    }).then(
      () => undefined,
      (reason: unknown) => reason
    )
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe('WSL_UNAVAILABLE')
  })
})
