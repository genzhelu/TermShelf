import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ShellKind } from '../util/executable'
import { shellQuote } from '../util/paths'

export interface LocalShellLaunch {
  shellPath: string
  args: string[]
  env: Record<string, string>
  kind: ShellKind
  integrated: boolean
  cleanup: () => Promise<void>
}

export interface PrepareLocalShellOptions {
  shellPath: string
  kind: ShellKind
  runtimeRoot: string
  sessionId: string
}

const BASH_INIT = `# TermShelf shell integration (bash)
if [ -f "$HOME/.bashrc" ]; then
  . "$HOME/.bashrc"
fi
__termshelf_osc7() {
  printf '\\033]7;file://%s%s\\007' "\${HOSTNAME:-\$(hostname 2>/dev/null)}" "$PWD"
}
case ";\${PROMPT_COMMAND:-};" in
  *";__termshelf_osc7;"*) ;;
  *) PROMPT_COMMAND="__termshelf_osc7\${PROMPT_COMMAND:+;\$PROMPT_COMMAND}" ;;
esac
__termshelf_osc7
`

function zshEnvInit(): string {
  return `# TermShelf shell integration (zsh)
__termshelf_zdotdir="\${TERMSHELF_ORIG_ZDOTDIR:-$HOME}"
if [ -f "$__termshelf_zdotdir/.zshenv" ]; then
  . "$__termshelf_zdotdir/.zshenv"
fi
`
}

const ZSH_PROFILE = `# TermShelf shell integration (zsh profile)
__termshelf_zdotdir="\${TERMSHELF_ORIG_ZDOTDIR:-$HOME}"
if [ -f "$__termshelf_zdotdir/.zprofile" ]; then
  . "$__termshelf_zdotdir/.zprofile"
fi
`

const ZSH_RC = `# TermShelf shell integration (zsh rc)
__termshelf_zdotdir="\${TERMSHELF_ORIG_ZDOTDIR:-$HOME}"
if [ -f "$__termshelf_zdotdir/.zshrc" ]; then
  . "$__termshelf_zdotdir/.zshrc"
fi
__termshelf_osc7() {
  printf '\\033]7;file://%s%s\\007' "\${HOST:-\$(hostname 2>/dev/null)}" "$PWD"
}
if autoload -Uz add-zsh-hook 2>/dev/null; then
  add-zsh-hook precmd __termshelf_osc7
else
  precmd_functions=(\${precmd_functions[@]} __termshelf_osc7)
fi
__termshelf_osc7
`

const ZSH_LOGIN = `# TermShelf shell integration (zsh login)
__termshelf_zdotdir="\${TERMSHELF_ORIG_ZDOTDIR:-$HOME}"
if [ -f "$__termshelf_zdotdir/.zlogin" ]; then
  . "$__termshelf_zdotdir/.zlogin"
fi
`

const FISH_INIT = `# TermShelf shell integration (fish)
function __termshelf_osc7 --on-event fish_prompt
    printf '\\033]7;file://%s%s\\007' (hostname) $PWD
end
__termshelf_osc7
`

const POWERSHELL_INIT = `# TermShelf shell integration (PowerShell)
$global:__termshelf_original_prompt = $function:prompt
if ($null -eq $global:__termshelf_original_prompt) {
  $global:__termshelf_original_prompt = { "PS $((Get-Location).Path)> " }
}
function global:__termshelf_emit_osc7 {
  try {
    $location = $ExecutionContext.SessionState.Path.CurrentFileSystemLocation.Path
    if ($location) {
      $normalized = $location -replace '\\\\', '/'
      [Console]::Write("\`e]7;file://$env:COMPUTERNAME/$normalized\`a")
    }
  } catch { }
}
function global:prompt {
  __termshelf_emit_osc7
  & $global:__termshelf_original_prompt
}
__termshelf_emit_osc7
`

/** POSIX init scripts reused by native Linux/macOS and WSL sessions. */
export function posixBashInit(): string {
  return BASH_INIT
}

export function posixFishInit(): string {
  return FISH_INIT
}

export function posixZshInits(): Record<'.zshenv' | '.zprofile' | '.zshrc' | '.zlogin', string> {
  return {
    '.zshenv': zshEnvInit(),
    '.zprofile': ZSH_PROFILE,
    '.zshrc': ZSH_RC,
    '.zlogin': ZSH_LOGIN
  }
}

export async function prepareLocalShellLaunch(
  options: PrepareLocalShellOptions
): Promise<LocalShellLaunch> {
  const base: LocalShellLaunch = {
    shellPath: options.shellPath,
    args: [],
    env: {},
    kind: options.kind,
    integrated: false,
    cleanup: async () => undefined
  }

  if (!['bash', 'zsh', 'fish', 'powershell'].includes(options.kind)) {
    return base
  }

  const directory = path.join(options.runtimeRoot, `shell-${options.sessionId}`)
  const cleanup = async (): Promise<void> => {
    try {
      await fs.promises.rm(directory, { recursive: true, force: true })
    } catch {
      // best effort
    }
  }

  try {
    await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 })
    const write = async (name: string, content: string): Promise<string> => {
      const filePath = path.join(directory, name)
      await fs.promises.writeFile(filePath, content, { mode: 0o600 })
      return filePath
    }

    if (options.kind === 'bash') {
      const initPath = await write('bashrc', BASH_INIT)
      return {
        ...base,
        args: [
          '-l',
          '-c',
          `exec ${shellQuote(options.shellPath)} --rcfile ${shellQuote(initPath)} -i`
        ],
        env: { TERMSHELF_SHELL_INTEGRATION: 'bash' },
        integrated: true,
        cleanup
      }
    }

    if (options.kind === 'zsh') {
      const originalZdotdir = process.env.ZDOTDIR ?? os.homedir()
      await write('.zshenv', zshEnvInit())
      await write('.zprofile', ZSH_PROFILE)
      await write('.zshrc', ZSH_RC)
      await write('.zlogin', ZSH_LOGIN)
      return {
        ...base,
        args: ['-l'],
        env: {
          ZDOTDIR: directory,
          TERMSHELF_ORIG_ZDOTDIR: originalZdotdir,
          TERMSHELF_SHELL_INTEGRATION: 'zsh'
        },
        integrated: true,
        cleanup
      }
    }

    if (options.kind === 'fish') {
      const initPath = await write('fish.fish', FISH_INIT)
      return {
        ...base,
        args: ['-l', '-C', `source ${shellQuote(initPath)}`],
        env: { TERMSHELF_SHELL_INTEGRATION: 'fish' },
        integrated: true,
        cleanup
      }
    }

    // Pass the init script through -EncodedCommand instead of -File: execution
    // policies (Restricted/AllSigned/RemoteSigned) block script *files*, and the
    // generated integration file is unsigned. Encoded commands are not subject to
    // the script file execution policy, so the prompt hook works out of the box
    // without asking the user to change a machine-wide policy.
    const encoded = Buffer.from(POWERSHELL_INIT, 'utf16le').toString('base64')
    return {
      ...base,
      args: ['-NoLogo', '-NoExit', '-EncodedCommand', encoded],
      env: { TERMSHELF_SHELL_INTEGRATION: 'powershell' },
      integrated: true,
      cleanup
    }
  } catch {
    await cleanup()
    return base
  }
}
