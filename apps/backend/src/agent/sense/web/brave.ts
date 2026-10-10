import { SearchError, type SearchProvider, type SearchResult } from './runtime.js'

const MAX_BYTES = 1024 * 1024

/** Fixed endpoint: never follows model-supplied URLs or redirects. */
export function createBraveProvider(
  getKey: () => string | undefined = () => process.env.BRAVE_SEARCH_API_KEY,
  request: typeof fetch = (...args) => fetch(...args),
): SearchProvider {
  return {
    id: 'brave',
    availability: () => (getKey()?.trim() ? 'ready' : 'configuration_missing'),
    async search(input, signal): Promise<SearchResult[]> {
      const key = getKey()?.trim()
      if (!key) throw new SearchError('configuration_missing')
      const url = new URL('https://api.search.brave.com/res/v1/web/search')
      url.searchParams.set('q', input.query)
      url.searchParams.set('count', String(input.limit))
      url.searchParams.set('result_filter', 'web')
      url.searchParams.set('text_decorations', 'false')
      const response = await request(url, {
        method: 'GET',
        signal,
        redirect: 'error',
        credentials: 'omit',
        headers: { Accept: 'application/json', 'X-Subscription-Token': key },
      })
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      try {
        if (response.status === 401 || response.status === 403)
          throw new SearchError('authentication_failed')
        if (response.status === 429) throw new SearchError('rate_limited')
        if (!response.ok) throw new SearchError('network_error')
        if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? ''))
          throw new SearchError('invalid_response')
        if (Number(response.headers.get('content-length')) > MAX_BYTES)
          throw new SearchError('response_too_large')
        if (!response.body) throw new SearchError('invalid_response')
        reader = response.body.getReader()
        const chunks: Uint8Array[] = []
        let size = 0
        while (true) {
          signal.throwIfAborted()
          const chunk = await reader.read()
          if (chunk.done) break
          size += chunk.value.byteLength
          if (size > MAX_BYTES) throw new SearchError('response_too_large')
          chunks.push(chunk.value)
        }
        // Remove credential echoes before parsing so decoded values and URLs cannot expose them.
        const redact = (value: string) =>
          value.split(key).join('[REDACTED]').split(encodeURIComponent(key)).join('[REDACTED]')
        let data: unknown
        try {
          data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
          throw new SearchError('invalid_response')
        }
        if (!data || typeof data !== 'object' || !('web' in data))
          throw new SearchError('invalid_response')
        const web = data.web
        if (!web || typeof web !== 'object' || !('results' in web) || !Array.isArray(web.results))
          throw new SearchError('invalid_response')
        return web.results.slice(0, 100).map((r: unknown): SearchResult => {
          if (
            !r ||
            typeof r !== 'object' ||
            !('url' in r) ||
            !('title' in r) ||
            !('description' in r) ||
            typeof r.url !== 'string' ||
            typeof r.title !== 'string' ||
            typeof r.description !== 'string'
          )
            throw new SearchError('invalid_response')
          // Do not return URLs containing credential echoes, including encoded echoes.
          const safeUrl = redact(r.url) === r.url ? r.url : ''
          return { url: safeUrl, title: redact(r.title), snippet: redact(r.description) }
        })
      } finally {
        if (reader) {
          await reader.cancel().catch(() => undefined)
          reader.releaseLock()
        } else {
          await response.body?.cancel().catch(() => undefined)
        }
      }
    },
  }
}
