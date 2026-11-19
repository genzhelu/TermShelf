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
}

const EMPTY_CLEANUP = async (): Promise<void> => undefined

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

  const linuxDir = `/tmp/termshelf-${safeToken(options.sessionId)}`
  const nativeDir = linuxToNative(context.uncRoot, linuxDir)
  const cleanup = async (): Promise<void> => {
    try {
      await fs.promises.rm(nativeDir, { recursive: true, force: true })
    } catch {
      // best effort
    }
  }

  try {
    await fs.promises.mkdir(nativeDir, { recursive: true, mode: 0o700 })
    const write = async (name: string, content: string): Promise<string> => {
      const target = path.join(nativeDir, name)
      await fs.promises.writeFile(target, content, { mode: 0o600 })
      return `${linuxDir}/${name}`
    }

    if (kind === 'bash') {
      const initPath = await write('bashrc', posixBashInit())
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
      if (!rcPath || !(await service.testReadable(context.distro, rcPath))) {
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
