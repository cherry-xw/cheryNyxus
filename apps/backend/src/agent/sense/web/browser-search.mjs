// Search-only ephemeral browser: no personal profiles, downloads or CAPTCHA bypass.
import { pathToFileURL } from 'node:url'

export async function searchBrowser(request, chromium) {
  if (typeof request.query !== 'string' || !request.query.trim() ||
      !Number.isInteger(request.limit) || request.limit < 1 || request.limit > 10) {
    throw new Error('invalid_input')
  }
  const options = { headless: true }
  if (request.proxy) options.proxy = { server: request.proxy }
  const browser = await chromium.launch(options)
  const attempts = []
  try {
    for (const [engine, base, selector] of [
      ['bing', 'https://www.bing.com/search?q=', 'li.b_algo'],
      ['baidu', 'https://www.baidu.com/s?wd=', '#content_left .result, #content_left .c-container'],
    ]) {
      const context = await browser.newContext({ acceptDownloads: false })
      try {
        const page = await context.newPage()
        await page.goto(base + encodeURIComponent(request.query), { waitUntil: 'domcontentloaded', timeout: 12000 })
        const headings = selector.split(',').flatMap(part => [`${part.trim()} h2 a`, `${part.trim()} h3 a`]).join(', ')
        await page.waitForSelector(headings, { timeout: 6000 })
        const items = await page.locator(selector).evaluateAll(nodes => nodes.slice(0, 20).map(n => {
          const a = n.querySelector('h2 a, h3 a')
          const snippet = n.querySelector('.b_caption p, .c-abstract, [class*="content-right"], [class*="abstract"]')
          return { title: a?.innerText || '', url: a?.href || '', snippet: snippet?.innerText || n.innerText.slice(0, 1800) }
        }))
        const results = items.flatMap(item => {
          try {
            const url = new URL(item.url)
            if (!item.title.trim() || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) return []
            return [{ ...item, source: `browser-${engine}` }]
          } catch { return [] }
        })
        attempts.push({ provider: `browser-${engine}`, ok: !!results.length })
        if (results.length) return { results: results.slice(0, request.limit), attempts }
      } catch {
        attempts.push({ provider: `browser-${engine}`, ok: false, code: 'provider_unavailable' })
      } finally {
        await context.close()
      }
    }
    return { results: [], attempts }
  } finally {
    await browser.close()
  }
}

// The backend embeds this file as raw source and runs Node's ESM evaluator.
// Importing the module for fixture tests does not launch a browser.
if (!process.argv[1] || import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const chunks = []
    for await (const chunk of process.stdin) chunks.push(chunk)
    const request = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const { chromium } = await import('playwright')
    process.stdout.write(JSON.stringify(await searchBrowser(request, chromium)) + '\n')
  } catch {
    process.stderr.write('browser_search_unavailable\n')
    process.exitCode = 1
  }
}
