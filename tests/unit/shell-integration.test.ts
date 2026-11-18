import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareLocalShellLaunch } from '../../src/main/shell/integration'

const directories: string[] = []

function runtimeRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termshelf-shell-'))
  directories.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of directories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('prepareLocalShellLaunch', () => {
  it('launches PowerShell through -EncodedCommand so execution policies do not block the hook', async () => {
    const launch = await prepareLocalShellLaunch({
      shellPath: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      kind: 'powershell',
      runtimeRoot: runtimeRoot(),
      sessionId: 'test'
    })
    expect(launch.integrated).toBe(true)
    const encodedIndex = launch.args.indexOf('-EncodedCommand')
    expect(encodedIndex).toBeGreaterThanOrEqual(0)
    expect(launch.args).not.toContain('-File')
    const script = Buffer.from(launch.args[encodedIndex + 1]!, 'base64').toString('utf16le')
    expect(script).toContain('__termshelf_emit_osc7')
    expect(script).toContain(']7;file://')
    expect(script).toContain('function global:prompt')
  })

  it('launches bash with a generated rcfile that emits OSC 7 and sources the user rc', async () => {
    const launch = await prepareLocalShellLaunch({
      shellPath: '/bin/bash',
      kind: 'bash',
      runtimeRoot: runtimeRoot(),
      sessionId: 'test'
    })
    expect(launch.integrated).toBe(true)
    expect(launch.args[0]).toBe('-l')
    expect(launch.args.join(' ')).toContain('--rcfile')
    const rcPath = /--rcfile '([^']+)'/.exec(launch.args[2] ?? '')?.[1]
    expect(rcPath).toBeTruthy()
    const content = fs.readFileSync(rcPath!, 'utf8')
    expect(content).toContain('$HOME/.bashrc')
    expect(content).toContain(']7;file://')
    expect(content).toContain('PROMPT_COMMAND')
  })

  it('launches zsh with a ZDOTDIR that preserves the original startup files', async () => {
    const launch = await prepareLocalShellLaunch({
      shellPath: '/bin/zsh',
      kind: 'zsh',
      runtimeRoot: runtimeRoot(),
      sessionId: 'test'
    })
    expect(launch.integrated).toBe(true)
    expect(launch.env.ZDOTDIR).toBeTruthy()
    const zshrc = fs.readFileSync(path.join(launch.env.ZDOTDIR!, '.zshrc'), 'utf8')
    expect(zshrc).toContain('.zshrc')
    expect(zshrc).toContain('add-zsh-hook')
    expect(zshrc).toContain(']7;file://')
  })

  it('does not integrate cmd.exe or plain sh', async () => {
    const cmd = await prepareLocalShellLaunch({
      shellPath: 'C:\\Windows\\System32\\cmd.exe',
      kind: 'cmd',
      runtimeRoot: runtimeRoot(),
      sessionId: 'test'
    })
    expect(cmd.integrated).toBe(false)
    expect(cmd.args).toEqual([])
    const sh = await prepareLocalShellLaunch({
      shellPath: '/bin/sh',
      kind: 'sh',
      runtimeRoot: runtimeRoot(),
      sessionId: 'test'
    })
    expect(sh.integrated).toBe(false)
  })

  it('removes its temporary integration directory on cleanup', async () => {
    const root = runtimeRoot()
    const launch = await prepareLocalShellLaunch({
      shellPath: '/bin/bash',
      kind: 'bash',
      runtimeRoot: root,
      sessionId: 'cleanup-test'
    })
    expect(fs.existsSync(path.join(root, 'shell-cleanup-test'))).toBe(true)
    await launch.cleanup()
    expect(fs.existsSync(path.join(root, 'shell-cleanup-test'))).toBe(false)
  })
})
