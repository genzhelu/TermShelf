import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import type { WslInfo } from '@shared/types'
import { AppError } from '../errors'
import { findExecutable } from '../util/executable'

export interface WslProcessResult {
  stdout: string
  stderr: string
  code: number
}

export type WslRunner = (args: string[], timeoutMs: number) => Promise<WslProcessResult>

export interface WslContext {
  /** Actual distro name (even when the caller asked for the default). */
  distro: string
  /** POSIX home directory inside WSL. */
  homePath: string
  /** POSIX login shell inside WSL. */
  shellPath: string
  /** Windows UNC root mapped to the Linux filesystem root, when accessible. */
  uncRoot: string | null
  /** All candidates that were probed, most-specific first. */
  uncRootCandidates: string[]
}

export interface WslServiceOptions {
  platform?: NodeJS.Platform
  /** Overrides wsl.exe detection; mainly useful for tests and diagnostics. */
  executablePath?: string | null
  runner?: WslRunner
  /** Used by tests to pretend a UNC root exists. */
  pathExists?: (candidate: string) => Promise<boolean>
  infoTtlMs?: number
  now?: () => number
}

const INFO_TTL_MS = 30_000
const DEFAULT_TIMEOUT_MS = 10_000
const LIST_TIMEOUT_MS = 5_000
const VERBOSE_TIMEOUT_MS = 3_000
const CONTEXT_TIMEOUT_MS = 15_000
const UNC_PROBE_TIMEOUT_MS = 1_500

/** Waits for a child process and captures decoded stdout/stderr. */
export function runWslProcess(
  executable: string,
  args: string[],
  timeoutMs: number
): Promise<WslProcessResult> {
  return new Promise<WslProcessResult>((resolve, reject) => {
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let settled = false
    const child = spawn(executable, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch {
        // already gone
      }
      reject(new AppError('WSL_UNAVAILABLE', `WSL command timed out after ${timeoutMs} ms`))
    }, timeoutMs)
    timer.unref?.()

    child.stdout?.on('data', (data: Buffer) => stdout.push(data))
    child.stderr?.on('data', (data: Buffer) => stderr.push(data))
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(
        new AppError('WSL_UNAVAILABLE', `Could not run ${executable}: ${error.message}`, {
          cause: error.message
        })
      )
    })
    child.once('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        stdout: decodeWslOutput(Buffer.concat(stdout)),
        stderr: decodeWslOutput(Buffer.concat(stderr)),
        code: code ?? 1
      })
    })
  })
}

/**
 * `wsl.exe` commonly emits UTF-16LE (with NUL bytes) on Windows while tests and
 * some builds emit UTF-8. Decode both, strip BOMs/NULs and normalise CRLF.
 */
export function decodeWslOutput(value: Buffer | string): string {
  let text: string
  if (typeof value === 'string') {
    text = value
  } else if (value.length >= 2 && value[0] === 0xff && value[1] === 0xfe) {
    text = value.toString('utf16le')
  } else if (value.includes(0)) {
    text = value.toString('utf16le')
  } else {
    text = value.toString('utf8')
  }
  return text
    .replace(/^\uFEFF/, '')
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
}

/** Parses `wsl.exe -l -q` output into distro names. */
export function parseDistroList(output: string): string[] {
  const seen = new Set<string>()
  const distros: string[] = []
  for (const rawLine of output.split('\n')) {
    const name = rawLine.replace(/^\uFEFF/, '').trim()
    if (!name || name.startsWith('Windows Subsystem for Linux')) continue
    if (!seen.has(name)) {
      seen.add(name)
      distros.push(name)
    }
  }
  return distros
}

/** Parses the `*` row of `wsl.exe -l -v` (best effort; may return null). */
export function parseDefaultDistro(output: string): string | null {
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('*')) continue
    const rest = trimmed.slice(1).trim()
    if (!rest) return null
    const match = /^(.+?)(?:\s{2,}|\t|$)/.exec(rest)
    const name = match?.[1]?.trim()
    return name || null
  }
  return null
}

export interface ParsedWslContext {
  distro: string
  homePath: string
  shellPath: string
  uncPath: string | null
}

const CONTEXT_LABEL = /^TERMSHELF_(DISTRO|HOME|SHELL|UNC)=(.*)$/

/** Parses the output of the context probe command. */
export function parseWslContextOutput(
  output: string,
  requestedDistro: string | null
): ParsedWslContext {
  const lines = output.split('\n')
  const labeled = new Map<string, string>()
  for (const line of lines) {
    const match = CONTEXT_LABEL.exec(line)
    if (match?.[1] && match[2] !== undefined) labeled.set(match[1], match[2])
  }
  if (labeled.size > 0) {
    const distro = (labeled.get('DISTRO') ?? '').trim() || requestedDistro || ''
    const home = (labeled.get('HOME') ?? '').trim()
    const shell = (labeled.get('SHELL') ?? '').trim()
    const unc = (labeled.get('UNC') ?? '').trim()
    return {
      distro,
      homePath: home.startsWith('/') ? home : '/home',
      shellPath: shell.startsWith('/') ? shell : '/bin/bash',
      uncPath: /^\\\\wsl(?:\.localhost|\$)\\/i.test(unc) ? unc : null
    }
  }
  // Backward-compatible positional parsing. Do not filter blank lines: each
  // field is positional, so a blank distro/home/shell must not shift the rest.
  const distro = lines[0]?.trim() || requestedDistro || ''
  const homePath = lines[1]?.trim().startsWith('/') ? lines[1]!.trim() : '/home'
  const shellPath = lines[2]?.trim().startsWith('/') ? lines[2]!.trim() : '/bin/bash'
  const uncLine = lines
    .slice(3)
    .map((line) => line.trim())
    .find((line) => /^\\\\wsl(?:\.localhost|\$)\\/i.test(line))
  return { distro, homePath, shellPath, uncPath: uncLine ?? null }
}

/** Builds UNC candidates for a distro, most preferred first. */
export function uncCandidatesForDistro(distro: string, reported?: string | null): string[] {
  const candidates: string[] = []
  const push = (value: string | null | undefined): void => {
    if (!value) return
    const trimmed = value.replace(/[\\/]+$/, '')
    if (!trimmed) return
    if (!candidates.some((entry) => entry.toLowerCase() === trimmed.toLowerCase())) {
      candidates.push(trimmed)
    }
  }
  if (distro && reported) {
    const match = /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)$/i.exec(reported.replace(/[\\/]+$/, ''))
    if (match?.[1]?.toLowerCase() === distro.toLowerCase()) push(reported)
  }
  if (distro) {
    push(`\\\\wsl.localhost\\${distro}`)
    push(`\\\\wsl$\\${distro}`)
  }
  return candidates
}

function probeUncRoot(
  pathExists: (candidate: string) => Promise<boolean>,
  candidate: string,
  timeoutMs: number,
  onNativeSettled: () => void
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (value: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => finish(false), Math.max(1, timeoutMs))
    timer.unref?.()
    pathExists(candidate).then(
      (value) => {
        onNativeSettled()
        finish(value)
      },
      () => {
        onNativeSettled()
        finish(false)
      }
    )
  })
}

const CONTEXT_SCRIPT = [
  'printf "TERMSHELF_DISTRO=%s\\n" "$WSL_DISTRO_NAME"',
  'printf "TERMSHELF_HOME=%s\\n" "$HOME"',
  'printf "TERMSHELF_SHELL=%s\\n" "$SHELL"',
  'if command -v wslpath >/dev/null 2>&1; then printf "TERMSHELF_UNC=%s\\n" "$(wslpath -w / 2>/dev/null || true)"; fi'
].join('; ')

/** Detects WSL and resolves per-distro context. All commands are argv based. */
export class WslService {
  private readonly platform: NodeJS.Platform
  private readonly runner: WslRunner
  private readonly pathExists: (candidate: string) => Promise<boolean>
  private readonly infoTtlMs: number
  private readonly now: () => number
  private readonly executable: string | null
  private infoCache: { at: number; value: WslInfo } | null = null
  private contextCache = new Map<string, { at: number; value: WslContext }>()
  private pendingUncProbes = 0

  constructor(options: WslServiceOptions = {}) {
    this.platform = options.platform ?? process.platform
    this.infoTtlMs = options.infoTtlMs ?? INFO_TTL_MS
    this.now = options.now ?? Date.now
    this.executable =
      options.executablePath !== undefined
        ? options.executablePath
        : this.platform === 'win32'
          ? findExecutable(['wsl.exe', 'C:\\Windows\\System32\\wsl.exe', 'wsl'])
          : null
    this.runner =
      options.runner ??
      ((args, timeoutMs) => {
        if (!this.executable) {
          return Promise.reject(new AppError('WSL_UNAVAILABLE', 'WSL is not installed'))
        }
        return runWslProcess(this.executable, args, timeoutMs)
      })
    this.pathExists =
      options.pathExists ??
      (async (candidate: string) => {
        try {
          const stats = await fs.stat(candidate)
          return stats.isDirectory()
        } catch {
          return false
        }
      })
  }

  get supported(): boolean {
    return this.platform === 'win32' && Boolean(this.executable)
  }

  get executablePath(): string | null {
    return this.executable
  }

  async info(force = false): Promise<WslInfo> {
    if (!force && this.infoCache && this.now() - this.infoCache.at < this.infoTtlMs) {
      return this.infoCache.value
    }
    if (!this.platformIsWindows()) {
      const value: WslInfo = {
        available: false,
        distros: [],
        defaultDistro: null,
        error: 'WSL is only available on Windows'
      }
      this.infoCache = { at: this.now(), value }
      return value
    }
    if (!this.executable) {
      const value: WslInfo = {
        available: false,
        distros: [],
        defaultDistro: null,
        error: 'wsl.exe was not found'
      }
      this.infoCache = { at: this.now(), value }
      return value
    }
    try {
      const list = await this.runner(['-l', '-q'], LIST_TIMEOUT_MS)
      if (list.code !== 0) {
        throw new AppError('WSL_UNAVAILABLE', list.stderr.trim() || 'wsl.exe -l -q failed')
      }
      const distros = parseDistroList(list.stdout)
      let defaultDistro: string | null = null
      try {
        const verbose = await this.runner(['-l', '-v'], VERBOSE_TIMEOUT_MS)
        if (verbose.code === 0) defaultDistro = parseDefaultDistro(verbose.stdout)
      } catch {
        // Default distro detection is optional.
      }
      if (defaultDistro && !distros.includes(defaultDistro)) defaultDistro = null
      const value: WslInfo = {
        available: distros.length > 0,
        distros,
        defaultDistro,
        ...(distros.length === 0 ? { error: 'No WSL distributions are installed' } : {})
      }
      this.infoCache = { at: this.now(), value }
      return value
    } catch (error) {
      const message = error instanceof AppError ? error.message : (error as Error).message
      const value: WslInfo = {
        available: false,
        distros: [],
        defaultDistro: null,
        error: message
      }
      this.infoCache = { at: this.now(), value }
      return value
    }
  }

  private platformIsWindows(): boolean {
    return this.platform === 'win32'
  }

  async resolveContext(distro: string | null, force = false): Promise<WslContext> {
    if (!this.platformIsWindows() || !this.executable) {
      throw new AppError('WSL_UNAVAILABLE', 'WSL is not available on this platform')
    }
    const info = await this.info(force)
    if (!info.available) {
      throw new AppError('WSL_UNAVAILABLE', info.error || 'WSL is not installed')
    }
    const key = distro ?? `default:${info.defaultDistro ?? ''}`
    const cached = this.contextCache.get(key)
    if (!force && cached && this.now() - cached.at < this.infoTtlMs) return cached.value

    if (distro && !info.distros.includes(distro)) {
      throw new AppError('WSL_DISTRO_NOT_FOUND', `WSL distribution "${distro}" is not installed`, {
        distro,
        distros: info.distros
      })
    }

    const args = [...(distro ? ['-d', distro] : []), '-e', 'sh', '-c', CONTEXT_SCRIPT]
    const result = await this.runner(args, CONTEXT_TIMEOUT_MS)
    if (result.code !== 0) {
      throw new AppError(
        'WSL_UNAVAILABLE',
        result.stderr.trim() || 'Could not query the WSL distribution'
      )
    }
    const parsed = parseWslContextOutput(result.stdout, distro)
    const actualDistro = parsed.distro || distro || info.defaultDistro || info.distros[0] || ''
    if (!actualDistro) {
      throw new AppError('WSL_DISTRO_NOT_FOUND', 'Could not determine the WSL distribution')
    }
    if (info.distros.length > 0 && !info.distros.includes(actualDistro)) {
      throw new AppError(
        'WSL_DISTRO_NOT_FOUND',
        `WSL distribution "${actualDistro}" is not installed`
      )
    }
    let homePath = parsed.homePath
    if (!homePath.startsWith('/')) homePath = '/'
    const candidates = uncCandidatesForDistro(actualDistro, parsed.uncPath)
    let uncRoot: string | null = null
    const deadline = this.now() + UNC_PROBE_TIMEOUT_MS
    // Windows fs.stat cannot be cancelled. If a previous round left probes
    // unresolved, skip issuing more so retries cannot exhaust the libuv thread
    // pool; the terminal-only fallback still works.
    if (this.pendingUncProbes === 0) {
      for (const [index, candidate] of candidates.entries()) {
        const remaining = deadline - this.now()
        if (remaining <= 0) break
        // Give every alias a share of the budget instead of letting a stalled
        // \\wsl.localhost request consume the time needed to try \\wsl$.
        const candidatesLeft = candidates.length - index
        const budget = Math.max(250, Math.floor(remaining / candidatesLeft))
        this.pendingUncProbes += 1
        const settled = (): void => {
          this.pendingUncProbes = Math.max(0, this.pendingUncProbes - 1)
        }
        if (await probeUncRoot(this.pathExists, candidate, Math.min(remaining, budget), settled)) {
          uncRoot = candidate
          break
        }
      }
    } else {
      // Do not issue more Win32 stats while old ones are unresolved. Reuse the
      // last known mount (if any) so a retry does not downgrade a working tab.
      const cached = this.contextCache.get(key) ?? this.contextCache.get(actualDistro)
      if (cached?.value.uncRoot) uncRoot = cached.value.uncRoot
    }
    const value: WslContext = {
      distro: actualDistro,
      homePath,
      shellPath: parsed.shellPath,
      uncRoot,
      uncRootCandidates: candidates
    }
    this.contextCache.set(key, { at: this.now(), value })
    this.contextCache.set(actualDistro, { at: this.now(), value })
    return value
  }

  /** Runs a command inside a distro, used by the launch bootstrap. */
  async runInDistro(
    distro: string,
    commandArgs: string[],
    timeoutMs = DEFAULT_TIMEOUT_MS
  ): Promise<WslProcessResult> {
    return this.runner(['-d', distro, '-e', ...commandArgs], timeoutMs)
  }

  async testReadable(distro: string, linuxPath: string): Promise<boolean> {
    try {
      const result = await this.runInDistro(distro, ['test', '-r', linuxPath])
      return result.code === 0
    } catch {
      return false
    }
  }

  /** Full spawn args for an interactive WSL terminal. */
  spawnArgs(distro: string, command: string[] = []): string[] {
    return ['-d', distro, '-e', ...command]
  }
}
