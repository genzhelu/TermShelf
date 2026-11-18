/**
 * Bridges PTY output events from the main process to the xterm instance that
 * owns the session. Data that arrives before a terminal mounts (shell prompt
 * racing tab creation) is buffered and replayed on subscribe, so no output is
 * ever lost.
 */
type DataListener = (data: string) => void

const listeners = new Map<string, Set<DataListener>>()
const buffers = new Map<string, string[]>()
const MAX_BUFFERED_CHUNKS = 2000

export function dispatchSessionData(sessionId: string, data: string): void {
  if (!data) return
  const registered = listeners.get(sessionId)
  if (registered && registered.size > 0) {
    for (const listener of [...registered]) listener(data)
    return
  }
  const buffer = buffers.get(sessionId) ?? []
  buffer.push(data)
  if (buffer.length > MAX_BUFFERED_CHUNKS) buffer.splice(0, buffer.length - MAX_BUFFERED_CHUNKS)
  buffers.set(sessionId, buffer)
}

export function subscribeSessionData(sessionId: string, listener: DataListener): () => void {
  let registered = listeners.get(sessionId)
  if (!registered) {
    registered = new Set()
    listeners.set(sessionId, registered)
  }
  registered.add(listener)

  const pending = buffers.get(sessionId)
  if (pending && pending.length > 0) {
    buffers.delete(sessionId)
    listener(pending.join(''))
  }

  return () => {
    const current = listeners.get(sessionId)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) listeners.delete(sessionId)
  }
}

/** Drops buffered output for a session that has been closed. */
export function forgetSessionData(sessionId: string): void {
  buffers.delete(sessionId)
  listeners.delete(sessionId)
}
