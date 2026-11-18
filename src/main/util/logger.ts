import fs from 'node:fs'
import path from 'node:path'

export type LogLevel = 'info' | 'warn' | 'error' | 'debug'

/** Small rotating file logger; never throws into application code. */
export class Logger {
  readonly directory: string
  readonly filePath: string
  private readonly maxBytes: number
  private readonly maxFiles: number

  constructor(directory: string, options?: { maxBytes?: number; maxFiles?: number }) {
    this.directory = directory
    this.filePath = path.join(directory, 'main.log')
    this.maxBytes = options?.maxBytes ?? 5 * 1024 * 1024
    this.maxFiles = options?.maxFiles ?? 3
    try {
      fs.mkdirSync(directory, { recursive: true })
    } catch {
      // Logging must never prevent the app from starting.
    }
  }

  private write(level: LogLevel, message: string, details?: unknown): void {
    const timestamp = new Date().toISOString()
    let line = `${timestamp} [${level}] ${message}`
    if (details !== undefined) {
      try {
        const serialized =
          details instanceof Error
            ? `${details.name}: ${details.message}\n${details.stack ?? ''}`
            : JSON.stringify(details)
        line += ` ${serialized}`
      } catch {
        line += ' [unserializable details]'
      }
    }
    line += '\n'
    try {
      this.rotateIfNeeded()
      fs.appendFileSync(this.filePath, line, { mode: 0o600 })
    } catch {
      // ignore
    }
    if (process.env.NODE_ENV !== 'production') {
      const output =
        level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
      output(`[termshelf:${level}] ${message}`, details ?? '')
    }
  }

  private rotateIfNeeded(): void {
    try {
      const stat = fs.statSync(this.filePath)
      if (stat.size < this.maxBytes) return
      for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
        const from = index === 1 ? this.filePath : `${this.filePath}.${index - 1}`
        const to = `${this.filePath}.${index}`
        if (fs.existsSync(from)) fs.renameSync(from, to)
      }
    } catch {
      // file may not exist yet
    }
  }

  info(message: string, details?: unknown): void {
    this.write('info', message, details)
  }

  warn(message: string, details?: unknown): void {
    this.write('warn', message, details)
  }

  error(message: string, details?: unknown): void {
    this.write('error', message, details)
  }

  debug(message: string, details?: unknown): void {
    this.write('debug', message, details)
  }
}
