import { beforeEach, describe, expect, it } from 'vitest'
import { AppError } from '../../src/main/errors'
import {
  WslService,
  decodeWslOutput,
  parseDefaultDistro,
  parseDistroList,
  parseWslContextOutput,
  uncCandidatesForDistro
} from '../../src/main/wsl/service'
import type { WslProcessResult, WslRunner, WslServiceOptions } from '../../src/main/wsl/service'

const WSL_EXE = 'C:\\fake\\wsl.exe'
const CONTEXT_SCRIPT =
  'printf "TERMSHELF_DISTRO=%s\\n" "$WSL_DISTRO_NAME"; printf "TERMSHELF_HOME=%s\\n" "$HOME"; printf "TERMSHELF_SHELL=%s\\n" "$SHELL"; if command -v wslpath >/dev/null 2>&1; then printf "TERMSHELF_UNC=%s\\n" "$(wslpath -w / 2>/dev/null || true)"; fi'

// `\\wsl.localhost\Ubuntu` / `\\wsl$\Ubuntu` as the parser sees them.
const UNC_LOCALHOST_UBUNTU = '\\\\wsl.localhost\\Ubuntu'
const UNC_DOLLAR_UBUNTU = '\\\\wsl$\\Ubuntu'
const VERBOSE_DEFAULT = [
  '  NAME      STATE           VERSION',
  '* Ubuntu    Running         2',
  '  Debian    Stopped         2',
  ''
].join('\n')
const CONTEXT_DEFAULT = ['Ubuntu', '/home/demo', '/bin/bash', `${UNC_LOCALHOST_UBUNTU}\\`, ''].join(
  '\n'
)

let clock = 1_000_000

function ok(stdout: string, stderr = '', code = 0): WslProcessResult {
  return { stdout, stderr, code }
}

type HandlerValue = WslProcessResult | Error
interface RunnerHandlers {
  list?: HandlerValue
  verbose?: HandlerValue
  context?: HandlerValue | ((args: string[]) => HandlerValue)
}

interface FakeRunner {
  runner: WslRunner
  calls: string[][]
}

function createRunner(handlers: RunnerHandlers = {}): FakeRunner {
  const calls: string[][] = []
  const resolveValue = (
    value: HandlerValue | ((args: string[]) => HandlerValue) | undefined,
    args: string[],
    fallback: WslProcessResult
  ): WslProcessResult => {
    const chosen = typeof value === 'function' ? value(args) : (value ?? fallback)
    if (chosen instanceof Error) throw chosen
    return chosen
  }
  const runner: WslRunner = async (args) => {
    calls.push([...args])
    if (args[0] === '-l' && args[1] === '-q') {
      return resolveValue(handlers.list, args, ok('Ubuntu\n'))
    }
    if (args[0] === '-l' && args[1] === '-v') {
      return resolveValue(handlers.verbose, args, ok(VERBOSE_DEFAULT))
    }
    if (args.includes('-e')) {
      return resolveValue(handlers.context, args, ok(CONTEXT_DEFAULT))
    }
    throw new Error(`Unexpected WSL arguments: ${args.join(' ')}`)
  }
  return { runner, calls }
}

interface ServiceBundle {
  service: WslService
  calls: string[][]
}

function createService(
  handlers: RunnerHandlers = {},
  options: Partial<WslServiceOptions> = {}
): ServiceBundle {
  const { runner, calls } = createRunner(handlers)
  const service = new WslService({
    platform: 'win32',
    executablePath: WSL_EXE,
    runner,
    infoTtlMs: 1_000,
    now: () => clock,
    ...options
  })
  return { service, calls }
}

interface FakePathExists {
  pathExists: (candidate: string) => Promise<boolean>
  probed: string[]
}

function fakePathExists(existing: string[] | ((candidate: string) => boolean)): FakePathExists {
  const probed: string[] = []
  const isExisting =
    typeof existing === 'function'
      ? existing
      : (candidate: string) => existing.some((entry) => entry === candidate)
  return {
    probed,
    pathExists: async (candidate: string) => {
      probed.push(candidate)
      return isExisting(candidate)
    }
  }
}

async function captureError(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason
  )
  expect(error).toBeInstanceOf(AppError)
  return error as AppError
}

beforeEach(() => {
  clock = 1_000_000
})

describe('decodeWslOutput', () => {
  it('decodes UTF-8 and normalises line endings', () => {
    expect(decodeWslOutput(Buffer.from('Ubuntu\r\nDebian\r\n', 'utf8'))).toBe('Ubuntu\nDebian\n')
    expect(decodeWslOutput('Ubuntu\r\nDebian')).toBe('Ubuntu\nDebian')
    expect(decodeWslOutput(Buffer.from('Ubuntu\n'))).toBe('Ubuntu\n')
  })

  it('decodes UTF-16LE output (with and without BOM)', () => {
    const withoutBom = Buffer.from('Ubuntu\r\nDebian\r\n', 'utf16le')
    expect(withoutBom.includes(0)).toBe(true)
    expect(decodeWslOutput(withoutBom)).toBe('Ubuntu\nDebian\n')

    const withBom = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Ubuntu', 'utf16le')])
    expect(decodeWslOutput(withBom)).toBe('Ubuntu')
  })

  it('strips UTF-8 BOMs and NUL characters, including CRLF inside strings', () => {
    expect(decodeWslOutput(Buffer.from('\uFEFFUbuntu\n', 'utf8'))).toBe('Ubuntu\n')
    expect(decodeWslOutput('\uFEFFUbuntu\r\n')).toBe('Ubuntu\n')
    expect(decodeWslOutput(Buffer.from('a\u0000b\u0000', 'utf16le'))).toBe('ab')
    expect(decodeWslOutput(Buffer.from('\uFEFFUbuntu', 'utf8'))).toBe('Ubuntu')
  })
})

describe('parseDistroList', () => {
  it('parses plain and CRLF-separated distro names', () => {
    expect(parseDistroList('Ubuntu\nDebian\n')).toEqual(['Ubuntu', 'Debian'])
    expect(parseDistroList('Ubuntu\r\nDebian\r\n')).toEqual(['Ubuntu', 'Debian'])
    expect(parseDistroList('\uFEFFUbuntu\n  \nDebian\n')).toEqual(['Ubuntu', 'Debian'])
  })

  it('preserves order and drops duplicates', () => {
    expect(parseDistroList('Ubuntu\nDebian\nUbuntu\n')).toEqual(['Ubuntu', 'Debian'])
  })

  it('ignores the no-distro banner emitted by wsl.exe', () => {
    const output = [
      'Windows Subsystem for Linux has no installed distributions.',
      'The Windows Subsystem for Linux may not be installed correctly.',
      ''
    ].join('\n')
    // Only lines starting with the well-known banner are skipped; the generic
    // diagnostic line is treated as an entry, so this test documents the limit.
    expect(parseDistroList(output)).toEqual([
      'The Windows Subsystem for Linux may not be installed correctly.'
    ])
    expect(
      parseDistroList('Windows Subsystem for Linux has no installed distributions.\n')
    ).toEqual([])
    expect(parseDistroList('\n\n')).toEqual([])
  })

  it('drops Windows-style leading asterisks and surrounding whitespace', () => {
    expect(parseDistroList('  Ubuntu  \r\n  Debian\t\n')).toEqual(['Ubuntu', 'Debian'])
  })
})

describe('parseDefaultDistro', () => {
  it('finds the starred row of wsl.exe -l -v output', () => {
    expect(parseDefaultDistro(VERBOSE_DEFAULT)).toBe('Ubuntu')
    expect(parseDefaultDistro('  NAME  STATE  VERSION\n* docker-desktop  Running  2\n')).toBe(
      'docker-desktop'
    )
  })

  it('handles tab-separated and compact rows', () => {
    expect(parseDefaultDistro('NAME\tSTATE\tVERSION\n*\tDebian\tRunning\t2\n')).toBe('Debian')
    expect(parseDefaultDistro('* Ubuntu\n')).toBe('Ubuntu')
  })

  it('returns null when there is no starred row or no distro name', () => {
    expect(parseDefaultDistro('  NAME  STATE  VERSION\n  Ubuntu  Running  2\n')).toBeNull()
    expect(parseDefaultDistro('')).toBeNull()
    expect(parseDefaultDistro('*\n')).toBeNull()
    expect(parseDefaultDistro('*   \n')).toBeNull()
  })
})

describe('parseWslContextOutput', () => {
  it('parses distro, home, shell and the UNC root', () => {
    expect(parseWslContextOutput(CONTEXT_DEFAULT, null)).toEqual({
      distro: 'Ubuntu',
      homePath: '/home/demo',
      shellPath: '/bin/bash',
      uncPath: `${UNC_LOCALHOST_UBUNTU}\\`
    })
    expect(parseWslContextOutput(CONTEXT_DEFAULT, 'Requested')).toMatchObject({ distro: 'Ubuntu' })
  })

  it('accepts \\\\wsl$ UNC paths and keeps looking after extra lines', () => {
    const output = [
      'Ubuntu',
      '/home/demo',
      '/bin/zsh',
      'diagnostic line',
      `${UNC_DOLLAR_UBUNTU}\\`
    ].join('\n')
    expect(parseWslContextOutput(output, null).uncPath).toBe(`${UNC_DOLLAR_UBUNTU}\\`)
  })

  it('does not treat arbitrary network paths as a WSL mount', () => {
    const output = ['Ubuntu', '/home/demo', '/bin/bash', '\\\\server\\share'].join('\n')
    expect(parseWslContextOutput(output, null).uncPath).toBeNull()
  })

  it('falls back to defaults for empty or non-absolute fields', () => {
    expect(parseWslContextOutput('', 'Debian')).toEqual({
      distro: 'Debian',
      homePath: '/home',
      shellPath: '/bin/bash',
      uncPath: null
    })
    expect(parseWslContextOutput('Ubuntu\nrelative-home\nrelative-shell\n', null)).toEqual({
      distro: 'Ubuntu',
      homePath: '/home',
      shellPath: '/bin/bash',
      uncPath: null
    })
  })
})

describe('uncCandidatesForDistro', () => {
  it('returns the wsl.localhost candidate before wsl$', () => {
    expect(uncCandidatesForDistro('Ubuntu')).toEqual([UNC_LOCALHOST_UBUNTU, UNC_DOLLAR_UBUNTU])
  })

  it('puts the reported mount first and de-duplicates trailing separators', () => {
    expect(uncCandidatesForDistro('Ubuntu', `${UNC_DOLLAR_UBUNTU}\\`)).toEqual([
      UNC_DOLLAR_UBUNTU,
      UNC_LOCALHOST_UBUNTU
    ])
    expect(uncCandidatesForDistro('Ubuntu', `${UNC_LOCALHOST_UBUNTU}\\`)).toEqual([
      UNC_LOCALHOST_UBUNTU,
      UNC_DOLLAR_UBUNTU
    ])
  })

  it('de-duplicates case-insensitively', () => {
    expect(uncCandidatesForDistro('Ubuntu', '\\\\WSL.LOCALHOST\\ubuntu\\')).toEqual([
      '\\\\WSL.LOCALHOST\\ubuntu',
      UNC_DOLLAR_UBUNTU
    ])
  })

  it('returns no candidates without a distro name', () => {
    expect(uncCandidatesForDistro('')).toEqual([])
    expect(uncCandidatesForDistro('', null)).toEqual([])
  })
})

describe('WslService.info', () => {
  it('reports WSL as unsupported on non-Windows platforms', async () => {
    const { runner, calls } = createRunner()
    const service = new WslService({ platform: 'linux', executablePath: null, runner })
    expect(service.supported).toBe(false)
    expect(service.executablePath).toBeNull()
    await expect(service.info()).resolves.toEqual({
      available: false,
      distros: [],
      defaultDistro: null,
      error: 'WSL is only available on Windows'
    })
    expect(calls).toEqual([])
  })

  it('reports a clear error when wsl.exe cannot be found', async () => {
    const { runner, calls } = createRunner()
    const service = new WslService({ platform: 'win32', executablePath: null, runner })
    expect(service.supported).toBe(false)
    await expect(service.info()).resolves.toMatchObject({
      available: false,
      error: 'wsl.exe was not found'
    })
    expect(calls).toEqual([])
  })

  it('lists installed distributions and the default distro', async () => {
    const { service } = createService({
      list: ok('Ubuntu\nDebian\n'),
      verbose: ok(VERBOSE_DEFAULT)
    })
    expect(service.supported).toBe(true)
    expect(service.executablePath).toBe(WSL_EXE)
    await expect(service.info()).resolves.toEqual({
      available: true,
      distros: ['Ubuntu', 'Debian'],
      defaultDistro: 'Ubuntu'
    })
  })

  it('reports unavailable when no distributions are installed', async () => {
    const { service } = createService({ list: ok('\n'), verbose: ok(VERBOSE_DEFAULT) })
    await expect(service.info()).resolves.toEqual({
      available: false,
      distros: [],
      defaultDistro: null,
      error: 'No WSL distributions are installed'
    })
  })

  it('ignores a default distro that is not in the installed list', async () => {
    const { service } = createService({
      list: ok('Ubuntu\n'),
      verbose: ok('  NAME  STATE  VERSION\n* Debian  Running  2\n')
    })
    await expect(service.info()).resolves.toEqual({
      available: true,
      distros: ['Ubuntu'],
      defaultDistro: null
    })
  })

  it('survives wsl.exe -l -v failing or throwing (default distro is optional)', async () => {
    const failing = createService({ list: ok('Ubuntu\n'), verbose: ok('', 'error', 1) })
    await expect(failing.service.info()).resolves.toEqual({
      available: true,
      distros: ['Ubuntu'],
      defaultDistro: null
    })

    const throwing = createService({
      list: ok('Ubuntu\n'),
      verbose: new Error('wsl.exe -l -v exploded')
    })
    await expect(throwing.service.info()).resolves.toEqual({
      available: true,
      distros: ['Ubuntu'],
      defaultDistro: null
    })
  })

  it('reports command failures as unavailable', async () => {
    const { service } = createService({ list: ok('', 'WSL is not responding', 1) })
    await expect(service.info()).resolves.toEqual({
      available: false,
      distros: [],
      defaultDistro: null,
      error: 'WSL is not responding'
    })
  })

  it('reports timeouts (runner rejects with AppError) as unavailable', async () => {
    const { service } = createService({
      list: new AppError('WSL_UNAVAILABLE', 'WSL command timed out after 10000 ms')
    })
    await expect(service.info()).resolves.toEqual({
      available: false,
      distros: [],
      defaultDistro: null,
      error: 'WSL command timed out after 10000 ms'
    })
  })

  it('caches results until the TTL expires and supports force refresh', async () => {
    const { service, calls } = createService()
    await service.info()
    expect(calls).toEqual([
      ['-l', '-q'],
      ['-l', '-v']
    ])
    await service.info()
    expect(calls).toHaveLength(2)

    clock += 1_001
    await service.info()
    expect(calls).toHaveLength(4)

    await service.info(true)
    expect(calls).toHaveLength(6)
  })

  it('caches unavailable results too', async () => {
    const { service, calls } = createService({ list: ok('', 'boom', 1) })
    await service.info()
    await service.info()
    expect(calls).toHaveLength(1)
  })
})

describe('WslService.resolveContext', () => {
  it('throws WSL_UNAVAILABLE off Windows or without wsl.exe', async () => {
    const offWindows = new WslService({ platform: 'linux', executablePath: null })
    const error = await captureError(offWindows.resolveContext(null))
    expect(error.code).toBe('WSL_UNAVAILABLE')

    const noExe = new WslService({ platform: 'win32', executablePath: null })
    const missing = await captureError(noExe.resolveContext(null))
    expect(missing.code).toBe('WSL_UNAVAILABLE')
  })

  it('rejects an explicitly requested distro that is not installed', async () => {
    const { service, calls } = createService({ list: ok('Ubuntu\nDebian\n') })
    const error = await captureError(service.resolveContext('Fedora'))
    expect(error.code).toBe('WSL_DISTRO_NOT_FOUND')
    expect(error.details).toMatchObject({ distro: 'Fedora', distros: ['Ubuntu', 'Debian'] })
    // Only the info probes ran; the context command was never executed.
    expect(calls.filter((args) => args.includes('-e'))).toEqual([])
  })

  it('resolves an explicit distro, home, shell and UNC root', async () => {
    const paths = fakePathExists([UNC_LOCALHOST_UBUNTU])
    const withPaths = createService(
      { list: ok('Ubuntu\nDebian\n'), verbose: ok(VERBOSE_DEFAULT) },
      { pathExists: paths.pathExists }
    )
    const context = await withPaths.service.resolveContext('Ubuntu')
    expect(context).toEqual({
      distro: 'Ubuntu',
      homePath: '/home/demo',
      shellPath: '/bin/bash',
      uncRoot: UNC_LOCALHOST_UBUNTU,
      uncRootCandidates: [UNC_LOCALHOST_UBUNTU, UNC_DOLLAR_UBUNTU]
    })
    const contextCall = withPaths.calls.find((args) => args.includes('-e'))
    expect(contextCall?.slice(0, 4)).toEqual(['-d', 'Ubuntu', '-e', 'sh'])
    expect(contextCall?.[4]).toBe('-c')
    expect(contextCall?.[5]).toBe(CONTEXT_SCRIPT)
    expect(paths.probed).toEqual([UNC_LOCALHOST_UBUNTU])
  })

  it('resolves the default distro and omits -d', async () => {
    const { service, calls } = createService({ list: ok('Ubuntu\nDebian\n') })
    const context = await service.resolveContext(null)
    expect(context.distro).toBe('Ubuntu')
    expect(context.homePath).toBe('/home/demo')
    expect(context.shellPath).toBe('/bin/bash')
    const contextCall = calls.find((args) => args.includes('-e'))
    expect(contextCall).toEqual(['-e', 'sh', '-c', CONTEXT_SCRIPT])
  })

  it('falls back to /home and /bin/bash when the shell output is unusable', async () => {
    const { service } = createService({
      list: ok('Ubuntu\n'),
      context: ok('Ubuntu\nrelative\nrelative\n')
    })
    const context = await service.resolveContext('Ubuntu')
    expect(context.homePath).toBe('/home')
    expect(context.shellPath).toBe('/bin/bash')
  })

  it('probes UNC candidates in order and falls back to \\\\wsl$', async () => {
    const paths = fakePathExists([UNC_DOLLAR_UBUNTU])
    const { service } = createService(
      {
        list: ok('Ubuntu\n'),
        context: ok(`Ubuntu\n/home/demo\n/bin/bash\n${UNC_LOCALHOST_UBUNTU}\\\n`)
      },
      { pathExists: paths.pathExists }
    )
    const context = await service.resolveContext('Ubuntu')
    expect(context.uncRoot).toBe(UNC_DOLLAR_UBUNTU)
    expect(context.uncRootCandidates).toEqual([UNC_LOCALHOST_UBUNTU, UNC_DOLLAR_UBUNTU])
    expect(paths.probed).toEqual([UNC_LOCALHOST_UBUNTU, UNC_DOLLAR_UBUNTU])
  })

  it('returns a null UNC root when every probe fails (terminal-only fallback)', async () => {
    const paths = fakePathExists([])
    const { service } = createService({ list: ok('Ubuntu\n') }, { pathExists: paths.pathExists })
    const context = await service.resolveContext('Ubuntu')
    expect(context.uncRoot).toBeNull()
    expect(paths.probed).toEqual([UNC_LOCALHOST_UBUNTU, UNC_DOLLAR_UBUNTU])
  })

  it('prefers a UNC path reported by wslpath', async () => {
    const reported = '\\\\wsl.localhost\\Ubuntu-22.04'
    const paths = fakePathExists([reported])
    const { service } = createService(
      {
        list: ok('Ubuntu-22.04\n'),
        context: ok('Ubuntu-22.04\n/home/demo\n/bin/bash\n\\\\server\\share\n' + `${reported}\\\n`)
      },
      { pathExists: paths.pathExists }
    )
    const context = await service.resolveContext('Ubuntu-22.04')
    expect(context.uncRoot).toBe(reported)
    expect(paths.probed[0]).toBe(reported)
  })

  it('propagates context command failures and timeouts', async () => {
    const failing = createService({ list: ok('Ubuntu\n'), context: ok('', 'context failed', 1) })
    expect((await captureError(failing.service.resolveContext('Ubuntu'))).code).toBe(
      'WSL_UNAVAILABLE'
    )

    const timingOut = createService({
      list: ok('Ubuntu\n'),
      context: new AppError('WSL_UNAVAILABLE', 'WSL command timed out after 10000 ms')
    })
    const error = await captureError(timingOut.service.resolveContext('Ubuntu'))
    expect(error.code).toBe('WSL_UNAVAILABLE')
    expect(error.message).toContain('timed out')
  })

  it('rejects a context that reports a different, uninstalled distro', async () => {
    const { service } = createService({
      list: ok('Ubuntu\n'),
      context: ok('Fedora\n/home/demo\n/bin/bash\n')
    })
    const error = await captureError(service.resolveContext('Ubuntu'))
    expect(error.code).toBe('WSL_DISTRO_NOT_FOUND')
  })

  it('caches resolved contexts until the TTL expires and supports force refresh', async () => {
    const { service, calls } = createService({ list: ok('Ubuntu\n') })
    await service.resolveContext(null)
    expect(calls).toHaveLength(3) // -l -q, -l -v, context
    await service.resolveContext(null)
    expect(calls).toHaveLength(3)

    clock += 1_001
    await service.resolveContext(null)
    expect(calls).toHaveLength(6)

    await service.resolveContext(null, true)
    // force re-runs info and the context probe
    expect(calls).toHaveLength(9)
  })

  it('caches default and explicit-distro lookups separately', async () => {
    const { service, calls } = createService({
      list: ok('Ubuntu\nDebian\n'),
      verbose: ok(VERBOSE_DEFAULT),
      context: (args) =>
        args.includes('Debian') ? ok('Debian\n/home/deb\n/bin/zsh\n') : ok(CONTEXT_DEFAULT)
    })
    await service.resolveContext(null)
    expect(calls.filter((args) => args.includes('-e'))).toHaveLength(1)
    // The default lookup also caches under the resolved distro name.
    expect(await service.resolveContext('Ubuntu')).toMatchObject({ distro: 'Ubuntu' })
    expect(calls.filter((args) => args.includes('-e'))).toHaveLength(1)
    // A different explicit distro has its own cache entry and is probed once.
    expect(await service.resolveContext('Debian')).toMatchObject({
      distro: 'Debian',
      homePath: '/home/deb',
      shellPath: '/bin/zsh'
    })
    expect(calls.filter((args) => args.includes('-e'))).toHaveLength(2)
    const contextCalls = calls.filter((args) => args.includes('-e'))
    expect(contextCalls[0]).toEqual(['-e', 'sh', '-c', CONTEXT_SCRIPT])
    expect(contextCalls[1]?.slice(0, 4)).toEqual(['-d', 'Debian', '-e', 'sh'])
  })
})

describe('labeled WSL context output', () => {
  it('parses labeled fields and does not let empty fields shift later values', () => {
    const output = [
      'TERMSHELF_DISTRO=Ubuntu',
      'TERMSHELF_HOME=',
      'TERMSHELF_SHELL=/usr/bin/zsh',
      'TERMSHELF_UNC=\\\\wsl.localhost\\Ubuntu\\',
      'noise'
    ].join('\n')
    expect(parseWslContextOutput(output, null)).toEqual({
      distro: 'Ubuntu',
      homePath: '/home',
      shellPath: '/usr/bin/zsh',
      uncPath: `${UNC_LOCALHOST_UBUNTU}\\`
    })
  })

  it('falls back for missing labeled fields and malformed UNC roots', () => {
    const output = [
      'TERMSHELF_DISTRO=',
      'TERMSHELF_HOME=relative',
      'TERMSHELF_SHELL=relative',
      'TERMSHELF_UNC=C:\\not-a-wsl-root'
    ].join('\n')
    expect(parseWslContextOutput(output, 'Debian')).toEqual({
      distro: 'Debian',
      homePath: '/home',
      shellPath: '/bin/bash',
      uncPath: null
    })
  })

  it('ignores a reported share belonging to a different distro', () => {
    expect(uncCandidatesForDistro('Ubuntu', '\\\\wsl$\\Debian')).toEqual([
      UNC_LOCALHOST_UBUNTU,
      UNC_DOLLAR_UBUNTU
    ])
  })

  it('falls back to the wsl$ alias when wsl.localhost stalls', async () => {
    const { runner } = createRunner()
    const service = new WslService({
      platform: 'win32',
      executablePath: WSL_EXE,
      runner,
      pathExists: (candidate) =>
        candidate.toLowerCase().includes('wsl$')
          ? Promise.resolve(true)
          : new Promise<boolean>(() => undefined)
    })
    const context = await service.resolveContext('Ubuntu')
    expect(context.uncRoot).toBe(UNC_DOLLAR_UBUNTU)
    // A forced retry while the stalled alias is still outstanding must keep
    // the known-working mount instead of downgrading to terminal-only.
    const retry = await service.resolveContext('Ubuntu', true)
    expect(retry.uncRoot).toBe(UNC_DOLLAR_UBUNTU)
  }, 5_000)

  it('degrades to a terminal-only context when the UNC probe stalls', async () => {
    const { runner } = createRunner()
    const service = new WslService({
      platform: 'win32',
      executablePath: WSL_EXE,
      runner,
      pathExists: () => new Promise<boolean>(() => undefined)
    })
    const started = Date.now()
    const context = await service.resolveContext('Ubuntu')
    expect(context.uncRoot).toBeNull()
    expect(Date.now() - started).toBeLessThan(3_000)
  }, 5_000)
})

describe('WslService helpers', () => {
  it('runInDistro forwards argv and the timeout', async () => {
    const { service, calls } = createService()
    const result = await service.runInDistro('Ubuntu', ['bash', '-lc', 'echo hi'], 1_234)
    expect(result.code).toBe(0)
    expect(calls).toEqual([['-d', 'Ubuntu', '-e', 'bash', '-lc', 'echo hi']])
  })

  it('testReadable runs a POSIX test and swallows failures', async () => {
    const readable = createService({ context: ok('') })
    readable.calls.length = 0
    // The fake runner returns the generic context result for any -e call; code 0
    // means the test succeeded.
    await expect(readable.service.testReadable('Ubuntu', '/tmp/x')).resolves.toBe(true)
    expect(readable.calls[0]).toEqual(['-d', 'Ubuntu', '-e', 'test', '-r', '/tmp/x'])

    const unreadable = new WslService({
      platform: 'win32',
      executablePath: WSL_EXE,
      runner: async () => ok('', '', 1)
    })
    await expect(unreadable.testReadable('Ubuntu', '/tmp/x')).resolves.toBe(false)

    const throwing = new WslService({
      platform: 'win32',
      executablePath: WSL_EXE,
      runner: async () => {
        throw new Error('spawn failed')
      }
    })
    await expect(throwing.testReadable('Ubuntu', '/tmp/x')).resolves.toBe(false)
  })

  it('spawnArgs builds interactive wsl.exe argv', () => {
    const { service } = createService()
    expect(service.spawnArgs('Ubuntu')).toEqual(['-d', 'Ubuntu', '-e'])
    expect(service.spawnArgs('Ubuntu', ['bash', '-l'])).toEqual([
      '-d',
      'Ubuntu',
      '-e',
      'bash',
      '-l'
    ])
  })
})
