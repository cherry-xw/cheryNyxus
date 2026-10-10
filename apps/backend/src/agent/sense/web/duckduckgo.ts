import { SearchError, type SearchProvider, type SearchResult } from './runtime.js'

const MAX_BYTES = 1024 * 1024
const ENDPOINT = 'https://html.duckduckgo.com/html/'

function clean(value: string, limit: number): string {
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)
}

function extractAttribute(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`${name}=[\"']([^\"']+)`, 'i'))
  return match?.[1]
}

function decodeRedirect(value: string): string {
  const match = value.match(/[?&]uddg=([^&]+)/i)
  return match ? decodeURIComponent(match[1]!) : value
}

/** Free public HTML search endpoint. No API key, cookies, or redirects are used. */
export function createDuckDuckGoProvider(
  request: typeof fetch = (...args) => fetch(...args),
): SearchProvider {
  return {
    id: 'duckduckgo',
    availability: () => 'ready',
    async search(input, signal): Promise<SearchResult[]> {
      const url = new URL(ENDPOINT)
      url.searchParams.set('q', input.query)
      const response = await request(url, {
        method: 'GET',
        signal,
        redirect: 'error',
        credentials: 'omit',
        headers: { Accept: 'text/html' },
      })
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      try {
        if (!response.ok) throw new SearchError(response.status === 429 ? 'rate_limited' : 'network_error')
        if (!/^text\/html(?:\s*;|$)/i.test(response.headers.get('content-type') ?? ''))
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
        const html = Buffer.concat(chunks).toString('utf8')
        const results: SearchResult[] = []
        const blocks = html.match(/<div[^>]+class=["'][^"']*result[^"']*["'][\s\S]*?<\/div>/gi) ?? []
        for (const block of blocks.slice(0, 100)) {
          const anchor = block.match(/<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]*>([\s\S]*?)<\/a>/i)
          if (!anchor) continue
          const tag = anchor[0]
          const rawUrl = extractAttribute(tag, 'href')
          if (!rawUrl) continue
          const href = decodeRedirect(rawUrl)
          const snippet = block.match(/class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/a?>/i)?.[1] ?? ''
          results.push({
            title: clean(anchor[1]!, 300),
            url: href,
            snippet: clean(snippet, 2000),
          })
        }
        return results
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