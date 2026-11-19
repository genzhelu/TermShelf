import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { LocalShellLaunch } from '../shell/integration'
import { posixBashInit, posixFishInit, posixZshInits } from '../shell/integration'
import { shellKindForPath } from '../util/executable'
import { shellQuote } from '../util/paths'
import { AppError } from '../errors'
import { linuxToNative } from './paths'
import type { WslContext, WslService } from './service'

export interface WslShellLaunch {
  file: string
  args: string[]
  env: Record<string, string>
  label: string
  integrated: boolean
  cleanup: () => Promise<void>
}

export interface PrepareWslLaunchOptions {
  service: WslService
  context: WslContext
  sessionId: string
  /** Test/launch override; a random token is used in production. */
  launchToken?: string
}

const EMPTY_CLEANUP = async (): Promise<void> => undefined

/**
 * Windows fs modes over the 9P bridge do not reliably set Linux permissions.
 * Run chmod inside the distro; if that cannot be established, use a plain shell
 * rather than sourcing init files with unknown ownership/mode.
 */
async function restrictPermissions(
  service: WslService,
  distro: string,
  linuxDir: string,
  files: string[]
): Promise<boolean> {
  const runner = (service as Partial<Pick<WslService, 'runInDistro'>>).runInDistro
  if (typeof runner !== 'function') return true
  const filePaths = files.map((name) => `${linuxDir}/${name}`)
  const command = [
    `chmod 700 ${shellQuote(linuxDir)}`,
    ...filePaths.map((file) => `chmod 600 ${shellQuote(file)}`)
  ].join(' && ')
  try {
    const result = await runner.call(service, distro, ['sh', '-c', command])
    return result.code === 0
  } catch {
    return false
  }
}

function safeToken(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'session'
}

/**
 * Prepares a WSL-backed interactive shell. Shell integration scripts are
 * written into the distribution's /tmp directory through the Windows UNC
 * mount, so the same OSC 7 hooks work as for native POSIX shells. If the WSL
 * filesystem or shell is not usable, the caller gets a plain `wsl.exe` launch.
 */
export async function prepareWslShellLaunch(
  options: PrepareWslLaunchOptions
): Promise<WslShellLaunch> {
  const { service, context } = options
  const file = service.executablePath
  if (!file) throw new AppError('WSL_UNAVAILABLE', 'wsl.exe was not found')
  const baseArgs = ['-d', context.distro, '--cd', context.homePath || '/']
  const plain: WslShellLaunch = {
    file,
    args: baseArgs,
    env: {},
    label: `WSL · ${context.distro}`,
    integrated: false,
    cleanup: EMPTY_CLEANUP
  }
  if (!context.uncRoot) return plain

  const kind = shellKindForPath(context.shellPath)
  if (kind !== 'bash' && kind !== 'zsh' && kind !== 'fish') return plain

  const token = safeToken(options.launchToken ?? randomUUID().slice(0, 8))
  const linuxDir = `/tmp/termshelf-${safeToken(options.sessionId)}-${token}`
  const nativeDir = linuxToNative(context.uncRoot, linuxDir)
  let ownsDirectory = false
  const cleanup = async (): Promise<void> => {
    if (!ownsDirectory) return
    try {
      await fs.promises.rm(nativeDir, { recursive: true, force: true })
    } catch {
      // best effort
    }
  }

  try {
    await fs.promises.mkdir(path.dirname(nativeDir), { recursive: true, mode: 0o700 })
    // Create the private per-launch directory without reusing a stale one.
    await fs.promises.mkdir(nativeDir, { mode: 0o700 })
    ownsDirectory = true
    const write = async (name: string, content: string): Promise<string> => {
      const target = path.join(nativeDir, name)
      await fs.promises.writeFile(target, content, { mode: 0o600 })
      return `${linuxDir}/${name}`
    }

    if (kind === 'bash') {
      const initPath = await write('bashrc', posixBashInit())
      if (!(await restrictPermissions(service, context.distro, linuxDir, ['bashrc']))) {
        await cleanup()
        return plain
      }
      if (!(await service.testReadable(context.distro, initPath))) {
        await cleanup()
        return plain
      }
      const inner = `exec ${shellQuote(context.shellPath)} --rcfile ${shellQuote(initPath)} -i`
      return {
        file,
        args: [...baseArgs, '-e', context.shellPath, '-l', '-c', inner],
        env: { TERMSHELF_SHELL_INTEGRATION: 'bash' },
        label: `WSL · ${context.distro} · bash`,
        integrated: true,
        cleanup
      }
    }

    if (kind === 'zsh') {
      const inits = posixZshInits()
      let rcPath = ''
      for (const [name, content] of Object.entries(inits)) {
        const written = await write(name, content)
        if (name === '.zshrc') rcPath = written
      }
      if (
        !rcPath ||
        !(await restrictPermissions(service, context.distro, linuxDir, Object.keys(inits))) ||
        !(await service.testReadable(context.distro, rcPath))
      ) {
        await cleanup()
        return plain
      }
      return {
        file,
        args: [...baseArgs, '-e', 'env', `ZDOTDIR=${linuxDir}`, context.shellPath, '-l'],
        env: { TERMSHELF_SHELL_INTEGRATION: 'zsh' },
        label: `WSL · ${context.distro} · zsh`,
        integrated: true,
        cleanup
      }
    }

    const initPath = await write('fish.fish', posixFishInit())
    if (!(await restrictPermissions(service, context.distro, linuxDir, ['fish.fish']))) {
      await cleanup()
      return plain
    }
    if (!(await service.testReadable(context.distro, initPath))) {
      await cleanup()
      return plain
    }
    return {
      file,
      args: [...baseArgs, '-e', context.shellPath, '-l', '-C', `source ${shellQuote(initPath)}`],
      env: { TERMSHELF_SHELL_INTEGRATION: 'fish' },
      label: `WSL · ${context.distro} · fish`,
      integrated: true,
      cleanup
    }
  } catch {
    await cleanup()
    return plain
  }
}

export type { LocalShellLaunch }
