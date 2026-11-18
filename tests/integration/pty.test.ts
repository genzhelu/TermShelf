/**
 * Smoke test for the native pseudo-terminal dependency.
 *
 * `@homebridge/node-pty-prebuilt-multiarch` ships N-API prebuilds; this test
 * proves the binary can spawn a child on the current host without a display.
 * It must stay dependency-free so a broken pty prebuild is obvious in CI.
 */
import * as pty from '@homebridge/node-pty-prebuilt-multiarch'
import { describe, expect, it } from 'vitest'

function shellCommand(): { file: string; args: string[]; expected: string } {
  if (process.platform === 'win32') {
    return {
      file: process.env.COMSPEC ?? 'cmd.exe',
      args: ['/d', '/s', '/c', 'echo pty-ok'],
      expected: 'pty-ok'
    }
  }
  return { file: '/bin/bash', args: ['-c', 'printf pty-ok'], expected: 'pty-ok' }
}

describe('node-pty prebuilt binary', () => {
  it('spawns a process and streams its output', async () => {
    const { file, args, expected } = shellCommand()
    const { output, exitCode } = await new Promise<{ output: string; exitCode: number }>(
      (resolve, reject) => {
        let output = ''
        let settled = false
        const terminal = pty.spawn(file, args, {
          name: 'xterm-256color',
          cols: 80,
          rows: 24,
          cwd: process.cwd(),
          env: { ...process.env, TERM: 'xterm-256color' }
        })
        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          try {
            terminal.kill()
          } catch {
            // ignore
          }
          reject(new Error(`pty timed out; output so far: ${JSON.stringify(output)}`))
        }, 15_000)
        terminal.onData((data) => {
          output += data
        })
        terminal.onExit(({ exitCode }) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve({ output, exitCode })
        })
      }
    )
    expect(exitCode).toBe(0)
    expect(output).toContain(expected)
  })
})
