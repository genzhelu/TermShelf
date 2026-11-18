#!/usr/bin/env tsx
/**
 * CLI entry point for the TermShelf dev/demo SSH server.
 *
 *   pnpm dev:sshd
 *   pnpm dev:sshd --root demo-remote --port 2222 --user demo --password demo
 *
 * The server is loopback-only, serves SFTP rooted at --root and opens a real
 * pty shell for terminal sessions. Ctrl+C shuts it down gracefully.
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { startDevSshd } from './server'
import type { DevSshdOptions, SftpPathMode } from './server'

interface CliOptions {
  root: string
  port: number
  host: string
  username: string
  password: string
  hostKeyPath: string
  authorizedKeysFiles: string[]
  shellPath: string | undefined
  sftpPathMode: SftpPathMode
  quiet: boolean
  help: boolean
}

const DEFAULT_OPTIONS: CliOptions = {
  root: 'demo-remote',
  port: 2222,
  host: '127.0.0.1',
  username: 'demo',
  password: 'demo',
  hostKeyPath: path.join('.dev-sshd', 'host.key'),
  authorizedKeysFiles: [],
  shellPath: undefined,
  sftpPathMode: 'virtual',
  quiet: false,
  help: false
}

const USAGE = `TermShelf dev SSH server

Usage:
  pnpm dev:sshd [options]

Options:
  --root <dir>             Backing directory for the virtual SFTP root / (default: demo-remote)
  --port <port>            TCP port to listen on (default: 2222, 0 = ephemeral)
  --host <address>         Address to bind (default: 127.0.0.1)
  --user <name>            Demo username (default: demo)
  --password <password>    Demo password (default: demo)
  --host-key <path>        Persisted ed25519 host key (default: .dev-sshd/host.key)
  --authorized-keys <file> OpenSSH authorized_keys file for public key auth (repeatable)
  --shell <path>           Shell used for pty sessions (default: $SHELL or /bin/bash)
  --sftp-path-mode <mode>  SFTP path mapping: 'virtual' (root exposed as /, default) or
                           'absolute' (real host paths under --root; matches the pty cwd,
                           needed for remote folder sync / OSC 7)
  --quiet                  Only print connection information
  --help                   Show this help

Connect with TermShelf: SSH session to 127.0.0.1:2222, user demo / demo.
Delete the host key file to simulate a changed host key (fingerprint mismatch).`

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { ...DEFAULT_OPTIONS, authorizedKeysFiles: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? ''
    const [flag, inlineValue] = arg.includes('=') ? splitOption(arg) : [arg, undefined]
    const takeValue = (): string => {
      if (inlineValue !== undefined) return inlineValue
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) throw new Error(`Missing value for ${flag}`)
      index += 1
      return next
    }
    switch (flag) {
      case '--root':
        options.root = takeValue()
        break
      case '--port': {
        const value = Number.parseInt(takeValue(), 10)
        if (!Number.isInteger(value) || value < 0 || value > 65535)
          throw new Error('Invalid --port')
        options.port = value
        break
      }
      case '--host':
        options.host = takeValue()
        break
      case '--user':
        options.username = takeValue()
        break
      case '--password':
        options.password = takeValue()
        break
      case '--host-key':
        options.hostKeyPath = takeValue()
        break
      case '--authorized-keys':
        options.authorizedKeysFiles.push(takeValue())
        break
      case '--shell':
        options.shellPath = takeValue()
        break
      case '--sftp-path-mode': {
        const mode = takeValue()
        if (mode !== 'virtual' && mode !== 'absolute') {
          throw new Error("Invalid --sftp-path-mode (expected 'virtual' or 'absolute')")
        }
        options.sftpPathMode = mode
        break
      }
      case '--quiet':
        options.quiet = true
        break
      case '--help':
      case '-h':
        options.help = true
        break
      default:
        throw new Error(`Unknown option: ${flag}`)
    }
  }
  return options
}

function splitOption(arg: string): [string, string] {
  const equals = arg.indexOf('=')
  return [arg.slice(0, equals), arg.slice(equals + 1)]
}

async function readAuthorizedKeys(files: string[]): Promise<string[]> {
  const keys: string[] = []
  for (const file of files) {
    const contents = await fs.readFile(file, 'utf8')
    for (const line of contents.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed.length > 0 && !trimmed.startsWith('#')) keys.push(trimmed)
    }
  }
  return keys
}

function connectionInstructions(handle: {
  host: string
  port: number
  username: string
  password: string
  fingerprint: string
  root: string
  sftpPathMode: SftpPathMode
  hostKeyPath: string
}): string {
  const lines = [
    '',
    'TermShelf dev SSH server',
    '─'.repeat(56),
    `  address:      ${handle.host}:${handle.port}`,
    `  username:     ${handle.username}`,
    `  password:     ${handle.password}`,
    handle.sftpPathMode === 'absolute'
      ? `  sftp root:    ${handle.root}  (absolute paths)`
      : `  virtual root: /  →  ${handle.root}`,
    `  host key:     ${handle.hostKeyPath}`,
    `  fingerprint:  ${handle.fingerprint}`,
    '',
    'Connect from TermShelf:',
    `  host ${handle.host}   port ${handle.port}   user ${handle.username}   password ${handle.password}`,
    'Connect from a terminal:',
    `  ssh -p ${handle.port} ${handle.username}@${handle.host}`,
    '',
    'Ctrl+C stops the server.',
    ''
  ]
  return lines.join('\n')
}

async function main(): Promise<void> {
  let options: CliOptions
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\n`)
    console.error(USAGE)
    process.exitCode = 2
    return
  }
  if (options.help) {
    console.log(USAGE)
    return
  }

  const authorizedKeys = await readAuthorizedKeys(options.authorizedKeysFiles)
  const serverOptions: DevSshdOptions = {
    root: path.resolve(options.root),
    port: options.port,
    host: options.host,
    username: options.username,
    password: options.password,
    hostKeyPath: path.resolve(options.hostKeyPath),
    authorizedKeys,
    sftpPathMode: options.sftpPathMode,
    ...(options.shellPath ? { shellPath: options.shellPath } : {}),
    log: options.quiet
      ? () => undefined
      : (message) => {
          if (
            !message.startsWith('OPEN') &&
            !message.startsWith('OPENDIR') &&
            !message.startsWith('MKDIR') &&
            !message.startsWith('RENAME')
          ) {
            console.log(`[dev-sshd] ${message}`)
          }
        }
  }

  const handle = await startDevSshd(serverOptions)
  console.log(connectionInstructions(handle))

  let stopping = false
  const stop = async (signal: string): Promise<void> => {
    if (stopping) return
    stopping = true
    console.log(`\n[dev-sshd] received ${signal}, shutting down…`)
    await handle.close()
    process.exit(0)
  }
  process.on('SIGINT', () => {
    void stop('SIGINT')
  })
  process.on('SIGTERM', () => {
    void stop('SIGTERM')
  })
}

void main().catch((error) => {
  console.error(
    `[dev-sshd] failed to start: ${error instanceof Error ? error.message : String(error)}`
  )
  process.exitCode = 1
})
