import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { ControllerSocketClient } from './socketRpc.ts'
import { isBusinessActivity } from './lifecycle.ts'

const origin = 'https://mini.xcherry.top'
const hopHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])
export function parseAppRoute(raw: string) {
  const match = /^\/qq\/([1-9]\d{4,19})\/apps\/([a-z0-9][a-z0-9-]{1,30}[a-z0-9])(\/[^?#]*)?(\?[^#]*)?$/.exec(raw)
  if (!match) return
  const suffix = (match[3] ?? '/') + (match[4] ?? '')
  let decoded
  try { decoded = decodeURIComponent(suffix.split('?')[0]!) } catch { return }
  if (decoded.includes('%') || decoded.includes('//') || decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').some(part => part === '..' || part === '.')) return
  return { userId: match[1]!, appId: match[2]!, suffix, base: `/qq/${match[1]}/apps/${match[2]}`, redirect: !match[3] }
}

export function forwardHeaders(req: IncomingMessage, route: NonNullable<ReturnType<typeof parseAppRoute>>) {
  const headers = { ...req.headers }
  delete headers['accept-encoding']
  for (const key of Object.keys(headers)) {
    if (hopHeaders.has(key) || (req.headers.connection ?? '').toLowerCase().split(',').map(s => s.trim()).includes(key) || /^(x-chery-|x-forwarded-)/.test(key) || ['forwarded', 'authorization', 'proxy-authorization', 'connection', 'keep-alive', 'transfer-encoding'].includes(key)) delete headers[key]
  }
  // Platform browser authentication never reaches user application code.
  if (headers.cookie) headers.cookie = headers.cookie.split(';').filter(cookie => cookie.trim().startsWith(`chery_app_sid_${route.appId.replace(/[^a-z0-9]/gi, '_')}=`)).join(';')
  return { ...headers, host: 'mini.xcherry.top', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'mini.xcherry.top', 'x-forwarded-prefix': route.base, 'x-chery-app-id': route.appId, 'x-chery-owner-id': route.userId }
}

export function createManagedAppGateway(client = new ControllerSocketClient()) {
  let draining = false
  const active = new Set<ServerResponse | Duplex>()
  let connections = 0
  const perApp = new Map<string, number>()
  function reserve(route: NonNullable<ReturnType<typeof parseAppRoute>>, stream: ServerResponse | Duplex): boolean {
    const key = `${route.userId}:${route.appId}`
    if (draining || connections >= 128 || (perApp.get(key) ?? 0) >= 32) return false
    connections++
    active.add(stream)
    perApp.set(key, (perApp.get(key) ?? 0) + 1)
    let released = false
    const release = () => {
      if (released) return
      released = true
      connections--
      active.delete(stream)
      const remaining = (perApp.get(key) ?? 1) - 1
      if (remaining) perApp.set(key, remaining); else perApp.delete(key)
    }
    stream.once('finish', release)
    stream.once('close', release)
    stream.once('error', release)
    return true
  }
  async function target(route: NonNullable<ReturnType<typeof parseAppRoute>>) {
    const status = await client.inspectAppStatus({ userId: route.userId, appId: route.appId })
    const app = status.find(item => item.appId === route.appId && item.userId === route.userId)
    if (!app || app.state !== 'running' || app.serviceReady !== true || !app.containerIp || !/^172\.29\.\d{1,3}\.\d{1,3}$/.test(app.containerIp)) return
    return app.containerIp
  }
  return {
    drain() {
      draining = true
      for (const stream of active) stream.destroy()
    },
    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
      if (!req.url?.match(/^\/qq\/[^/]+\/apps\//)) return false
      const route = parseAppRoute(req.url)
      if (!route) { res.writeHead(400); res.end('INVALID_APP_PATH'); return true }
      if (route.redirect) { res.writeHead(308, { Location: `${route.base}/${req.url.includes('?') ? '?' + req.url.split('?')[1] : ''}` }); res.end(); return true }
      if (/^\/(?:__app_health|server|data|project|node_modules)(?:\/|$)|\.(?:sqlite(?:-wal|-shm)?|env)$|^\/(?:package(?:-lock)?\.json|vite\.config\.[^/]+)$/.test(decodeURIComponent(route.suffix.split('?')[0]!))) { res.writeHead(404); res.end(); return true }
      if (!reserve(route, res)) { res.writeHead(429); res.end('APP_CONNECTION_LIMIT'); return true }
      let ip
      try { ip = await target(route) } catch { /* unavailable controller is closed, not a route fallback */ }
      if (res.destroyed) return true
      if (!ip) {
        const html = req.headers.accept?.includes('text/html') && !route.suffix.startsWith('/api/')
        res.writeHead(503, { 'Content-Type': html ? 'text/html; charset=utf-8' : 'application/json', 'Cache-Control': 'no-store' })
        res.end(html ? '<!doctype html><meta charset="utf-8"><title>应用已停止</title><h1>应用当前不可用</h1><p>已停止或尚未就绪。历史数据保留，请在 QQ 对话中请求启动应用。</p>' : JSON.stringify({ error: { code: 'APP_STOPPED', message: '应用已停止或尚未就绪' } }))
        return true
      }
      if (isBusinessActivity(req.method ?? 'GET', route.suffix, String(req.headers['x-app-poll'] ?? ''))) void client.touchAppActivity({ userId: route.userId, appId: route.appId }).catch(() => {})
      const upstream = httpRequest({ hostname: ip, port: 3000, method: req.method, path: route.suffix, headers: forwardHeaders(req, route) }, response => {
        const headers = { ...response.headers, 'x-accel-buffering': 'no', 'cache-control': 'no-cache, no-transform' }
        for (const key of Object.keys(headers)) if (hopHeaders.has(key) || String(response.headers.connection ?? '').toLowerCase().split(',').map(s => s.trim()).includes(key)) delete (headers as Record<string, unknown>)[key]
        delete headers['www-authenticate']
        const location = headers.location
        if (location && location.startsWith('/') && !location.startsWith(`${route.base}/`)) headers.location = `${route.base}${location.startsWith('//') ? '/' : location}`
        if (headers['set-cookie']) headers['set-cookie'] = headers['set-cookie'].filter(cookie => cookie.startsWith(`chery_app_sid_${route.appId.replace(/[^a-z0-9]/gi, '_')}=`)).map(cookie => cookie.replace(/;\s*(?:path|domain)=[^;]*/gi, '') + `; Path=${route.base}/; Secure; HttpOnly; SameSite=Lax`)
        res.writeHead(response.statusCode ?? 502, headers)
        response.on('error', () => res.destroy())
        response.pipe(res)
      })
      const lifetime = setTimeout(() => { upstream.destroy(); res.destroy() }, 1800000)
      lifetime.unref()
      res.once('close', () => clearTimeout(lifetime))
      upstream.setTimeout(30000, () => upstream.destroy())
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end() })
      res.on('close', () => upstream.destroy())
      req.pipe(upstream)
      return true
    },
    async upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<boolean> {
      if (!req.url?.match(/^\/qq\/[^/]+\/apps\//)) return false
      const route = parseAppRoute(req.url)
      if (!route || req.headers.origin !== origin || !/^\/ws(?:\?|$)/.test(route.suffix)) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return true }
      if (!reserve(route, socket)) { socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n'); return true }
      let ip
      try { ip = await target(route) } catch { /* fail closed */ }
      if (socket.destroyed) return true
      if (!ip) { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return true }
      const upstream = httpRequest({ hostname: ip, port: 3000, path: route.suffix, headers: { ...forwardHeaders(req, route), connection: 'Upgrade', upgrade: 'websocket' } })
      upstream.on('upgrade', (response, remote, remoteHead) => {
        if (socket.destroyed) { remote.destroy(); return }
        socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers).filter(([key]) => ['upgrade', 'connection', 'sec-websocket-accept', 'sec-websocket-protocol', 'sec-websocket-extensions'].includes(key)).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`)
        if (remoteHead.length) socket.write(remoteHead)
        if (head.length) remote.write(head)
        const maximumLifetime = setTimeout(() => { remote.destroy(); socket.destroy() }, 1800000)
        maximumLifetime.unref()
        remote.on('close', () => { clearTimeout(maximumLifetime); socket.destroy() })
        socket.pipe(remote).pipe(socket)
        socket.on('close', () => remote.destroy())
        remote.on('error', () => socket.destroy())
      })
      upstream.on('response', response => { response.resume(); socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n') })
      socket.on('close', () => upstream.destroy())
      socket.on('error', () => upstream.destroy())
      upstream.on('error', () => socket.destroy())
      upstream.setTimeout(1800000, () => { upstream.destroy(); socket.destroy() })
      upstream.end()
      return true
    },
  }
}
