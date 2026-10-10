interface MarkdownWorkerResponse {
  id: number
  html?: string
  error?: string
}

interface PendingRequest {
  source: string
  resolve: (html: string) => void
  reject: (error: Error) => void
}

const CACHE_LIMIT = 64
const CACHE_CHARACTER_BUDGET = 1_000_000
const cache = new Map<string, string>()
const pending = new Map<number, PendingRequest>()
let cacheCharacters = 0
let worker: Worker | undefined
let workerFailed = false
let nextId = 1

function cacheResult(source: string, html: string): void {
  if (source.length > CACHE_CHARACTER_BUDGET / 2) return
  const previous = cache.get(source)
  if (previous) cacheCharacters -= source.length
  cache.delete(source)
  cache.set(source, html)
  cacheCharacters += source.length
  while (cache.size > CACHE_LIMIT || cacheCharacters > CACHE_CHARACTER_BUDGET) {
    const oldest = cache.keys().next().value as string | undefined
    if (oldest === undefined) break
    cache.delete(oldest)
    cacheCharacters -= oldest.length
  }
}

function ensureWorker(): Worker | undefined {
  if (worker || workerFailed || typeof Worker === 'undefined') return worker
  try {
    worker = new Worker(new URL('../workers/markdown.worker.ts', import.meta.url), {
      type: 'module',
      name: 'chery-markdown',
    })
    worker.addEventListener('message', (event: MessageEvent<MarkdownWorkerResponse>) => {
      const request = pending.get(event.data.id)
      if (!request) return
      pending.delete(event.data.id)
      if (event.data.error) {
        request.reject(new Error(event.data.error))
        return
      }
      const html = event.data.html ?? ''
      cacheResult(request.source, html)
      request.resolve(html)
    })
    worker.addEventListener('error', () => {
      workerFailed = true
      worker?.terminate()
      worker = undefined
      for (const request of pending.values()) request.reject(new Error('Markdown Worker 不可用'))
      pending.clear()
    })
  } catch {
    workerFailed = true
  }
  return worker
}

async function renderFallback(source: string): Promise<string> {
  const { renderMarkdown } = await import('./markdownEngine')
  const html = renderMarkdown(source)
  cacheResult(source, html)
  return html
}

export async function renderMarkdownAsync(source: string): Promise<string> {
  if (!source) return ''
  const cached = cache.get(source)
  if (cached !== undefined) {
    cache.delete(source)
    cache.set(source, cached)
    return cached
  }
  const target = ensureWorker()
  if (!target) return renderFallback(source)
  const id = nextId++
  return new Promise<string>((resolve, reject) => {
    pending.set(id, { source, resolve, reject })
    target.postMessage({ id, source })
  }).catch(() => renderFallback(source))
}
