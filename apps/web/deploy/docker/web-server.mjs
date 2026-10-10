import { createServer, request } from 'node:http'
import { stat, readFile } from 'node:fs/promises'
import { resolve, extname, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

export function createWebServer({ root, backendHttp, backendWs }) {
  root = resolve(root)
  const http = new URL(backendHttp)
  const ws = new URL(backendWs)
  if (http.protocol !== 'http:' || ws.protocol !== 'http:')
    throw new Error('Expected trusted HTTP upstreams')
  const headers = (req) => {
    const result = { ...req.headers }
    for (const key of Object.keys(result)) {
      if (key.startsWith('x-forwarded-') || key === 'forwarded') delete result[key]
    }
    return result
  }
  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname
      if (pathname === '/healthz') {
        res.writeHead(200)
        res.end('ok')
        return
      }
      if (pathname.startsWith('/api/')) {
        const upstream = request(
          {
            hostname: http.hostname,
            port: http.port,
            path: req.url,
            method: req.method,
            headers: headers(req),
            timeout: 10000,
          },
          (response) => {
            res.writeHead(response.statusCode, response.headers)
            response.pipe(res)
          },
        )
        upstream.on('timeout', () => upstream.destroy())
        upstream.on('error', () => {
          if (!res.headersSent) res.writeHead(502)
          res.end()
        })
        req.pipe(upstream)
        return
      }
      if (!['GET', 'HEAD'].includes(req.method)) {
        res.writeHead(405)
        res.end()
        return
      }
      let decoded
      try {
        decoded = decodeURIComponent(pathname)
      } catch {
        res.writeHead(400)
        res.end()
        return
      }
      const file = resolve(root, '.' + decoded)
      if (!file.startsWith(root + sep) && file !== root) {
        res.writeHead(403)
        res.end()
        return
      }
      let selected = file
      try {
        if (!(await stat(selected)).isFile()) selected = resolve(root, 'index.html')
      } catch {
        if (extname(decoded)) {
          res.writeHead(404)
          res.end()
          return
        }
        selected = resolve(root, 'index.html')
      }
      const content = await readFile(selected)
      const mime = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.svg': 'image/svg+xml',
        '.woff2': 'font/woff2',
      }
      res.writeHead(200, {
        'Content-Type': mime[extname(selected)] ?? 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
      })
      res.end(req.method === 'HEAD' ? undefined : content)
    } catch {
      if (!res.headersSent) res.writeHead(500)
      res.end()
    }
  })
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://localhost').pathname !== '/ws') {
      socket.destroy()
      return
    }
    const upstream = request(new URL('/', ws), { headers: headers(req), timeout: 10000 })
    upstream.on('upgrade', (response, target, extra) => {
      target.setTimeout(0)
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join('\r\n')}\r\n\r\n`,
      )
      if (extra.length) socket.write(extra)
      if (head.length) target.write(head)
      target.pipe(socket)
      socket.pipe(target)
      socket.on('error', () => target.destroy())
      target.on('error', () => socket.destroy())
      socket.on('close', () => target.destroy())
    })
    upstream.on('response', (response) => {
      response.resume()
      socket.destroy()
    })
    upstream.on('timeout', () => upstream.destroy())
    upstream.on('error', () => socket.destroy())
    upstream.end()
  })
  return server
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createWebServer({
    root: process.env.NYXUS_WEB_ROOT ?? '/app/web',
    backendHttp: process.env.NYXUS_BACKEND_HTTP ?? 'http://127.0.0.1:8283',
    backendWs: process.env.NYXUS_BACKEND_WS ?? 'http://127.0.0.1:8282',
  })
  server.listen(
    Number(process.env.NYXUS_WEB_PORT ?? 8080),
    process.env.NYXUS_WEB_BIND ?? '127.0.0.1',
  )
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => server.close(() => process.exit(0)))
}
