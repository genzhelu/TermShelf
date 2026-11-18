import fs from 'node:fs'
import path from 'node:path'
import type { Platform } from '@shared/types'

export type ShellKind = 'bash' | 'zsh' | 'fish' | 'powershell' | 'cmd' | 'sh' | 'other'

export interface ResolvedShell {
  path: string
  kind: ShellKind
  integration: boolean
}

export function shellKindForPath(shellPath: string): ShellKind {
  const name = path
    .basename(shellPath)
    .toLowerCase()
    .replace(/\.exe$/, '')
  if (name === 'bash') return 'bash'
  if (name === 'zsh') return 'zsh'
  if (name === 'fish') return 'fish'
  if (name === 'pwsh' || name === 'powershell') return 'powershell'
  if (name === 'cmd') return 'cmd'
  if (name === 'sh' || name === 'dash' || name === 'ksh') return 'sh'
  return 'other'
}

function isExecutableFile(candidate: string): boolean {
  try {
    const stat = fs.statSync(candidate)
    if (!stat.isFile()) return false
    if (process.platform !== 'win32') {
      fs.accessSync(candidate, fs.constants.X_OK)
    }
    return true
  } catch {
    return false
  }
}

/** Find an executable by absolute path or by scanning PATH (with PATHEXT on Windows). */
export function findExecutable(candidates: string[]): string | null {
  const pathEntries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
      : ['']

  for (const candidate of candidates) {
    if (!candidate) continue
    if (path.isAbsolute(candidate)) {
      if (isExecutableFile(candidate)) return candidate
      for (const extension of extensions) {
        if (isExecutableFile(candidate + extension)) return candidate + extension
      }
      continue
    }
    for (const entry of pathEntries) {
      for (const extension of extensions) {
        const full = path.join(entry, candidate + extension)
        if (isExecutableFile(full)) return full
      }
    }
  }
  return null
}

export function resolveDefaultShell(
  platform: Platform,
  override: string | null | undefined
): ResolvedShell {
  if (override && override.trim()) {
    const found = findExecutable([override.trim()])
    if (found) return { path: found, kind: shellKindForPath(found), integration: true }
    return { path: override.trim(), kind: shellKindForPath(override), integration: true }
  }

  if (platform === 'win32') {
    const powershell = findExecutable(['pwsh.exe', 'pwsh', 'powershell.exe', 'powershell'])
    if (powershell) {
      return { path: powershell, kind: 'powershell', integration: true }
    }
    const cmd = process.env.ComSpec ?? findExecutable(['cmd.exe', 'cmd'])
    return { path: cmd ?? 'cmd.exe', kind: 'cmd', integration: false }
  }

  const environmentShell = process.env.SHELL
  if (environmentShell && isExecutableFile(environmentShell)) {
    const kind = shellKindForPath(environmentShell)
    return { path: environmentShell, kind, integration: kind !== 'sh' && kind !== 'other' }
  }

  if (platform === 'darwin') {
    const zsh = findExecutable(['/bin/zsh'])
    if (zsh) return { path: zsh, kind: 'zsh', integration: true }
  }
  const bash = findExecutable(['/bin/bash', 'bash'])
  if (bash) return { path: bash, kind: 'bash', integration: true }
  const sh = findExecutable(['/bin/sh', 'sh'])
  return { path: sh ?? '/bin/sh', kind: 'sh', integration: false }
}
