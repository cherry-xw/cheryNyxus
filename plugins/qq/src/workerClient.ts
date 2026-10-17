import http from 'node:http'
import { randomUUID } from 'node:crypto'

export interface WorkerProgress {
  phase: 'preparing' | 'downloading' | 'processing'
  bytes: number
  totalBytes?: number
  elapsedMs: number
}
export async function executeQQWorker(socketPath: string, payload: unknown, signal?: AbortSignal,
  onProgress?: (progress: WorkerProgress) => void): Promise<Record<string, unknown>> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: '/exec', method: 'POST', headers: { 'content-type': 'application/json', 'accept': 'application/x-ndjson', 'x-request-id': randomUUID() } }, res => {
      let text = '', result: Record<string, unknown> | undefined
      const streaming = res.headers['content-type']?.includes('application/x-ndjson')
      const consume = (line: string) => {
        const event = JSON.parse(line)
        if (event.type === 'result') result = event.data
        else if (event.type === 'progress' && ['preparing', 'downloading', 'processing'].includes(event.data?.phase)
          && Number.isFinite(event.data.bytes) && event.data.bytes >= 0 && Number.isFinite(event.data.elapsedMs)) {
          try { onProgress?.(event.data) } catch { /* Notifications never fail the command. */ }
        }
      }
      res.setEncoding('utf8')
      res.on('data', chunk => {
        text += chunk
        if (text.length > 300000) { req.destroy(new Error('Worker response too large')); return }
        if (streaming) {
          let end: number
          try { while ((end = text.indexOf('\n')) >= 0) { const line = text.slice(0, end); text = text.slice(end + 1); if (line) consume(line) } }
          catch { req.destroy(new Error('Invalid worker response')) }
        }
      })
      res.on('error', reject)
      res.on('aborted', () => reject(new Error('Worker response interrupted')))
      res.on('end', () => {
        try {
          const data = streaming ? result : JSON.parse(text)
          if (!data) throw new Error('Worker result missing')
          if (res.statusCode !== 200) reject(new Error(data.error || 'Worker rejected request'))
          else resolve(data)
        } catch (e) { reject(e instanceof Error ? e : new Error('Invalid worker response')) }
      })
    })
    const cancel = () => req.destroy(new Error('Worker cancelled'))
    signal?.addEventListener('abort', cancel, { once: true })
    req.on('close', () => signal?.removeEventListener('abort', cancel))
    req.on('error', reject)
    req.end(JSON.stringify(payload))
  })
}
