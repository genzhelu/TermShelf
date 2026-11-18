/** Coalesces small terminal output chunks into fewer IPC messages. */
export class DataBatcher {
  private pending: string[] = []
  private pendingBytes = 0
  private timer: NodeJS.Timeout | null = null
  private disposed = false

  constructor(
    private readonly onFlush: (data: string) => void,
    private readonly intervalMs = 8,
    private readonly maxBytes = 256 * 1024
  ) {}

  push(chunk: string): void {
    if (this.disposed || !chunk) return
    this.pending.push(chunk)
    this.pendingBytes += chunk.length
    if (this.pendingBytes >= this.maxBytes) {
      this.flush()
      return
    }
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null
        this.flush()
      }, this.intervalMs)
    }
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.pending.length === 0) return
    const data = this.pending.join('')
    this.pending = []
    this.pendingBytes = 0
    this.onFlush(data)
  }

  dispose(): void {
    this.flush()
    this.disposed = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}
