import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer, WebSocket } from 'ws'
import { describe, expect, it } from 'vitest'
// @ts-expect-error deployment JavaScript has no declaration file
import { createWebServer } from '../../deploy/docker/web-server.mjs'

describe('delivery proxy LAN forwarding', () => {
  it('preserves prefix HTTP, ticket and Lite query through actual HTTP/WS business traffic', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nyxus-proxy-'))
    await writeFile(join(root, 'index.html'), 'isolated-shell')
    const used = new Set<string>()
    const backend = createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ path: req.url })) })
    const wss = new WebSocketServer({ noServer: true })
    backend.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url!, 'http://localhost')
      const ticket = url.searchParams.get('ticket')
      if (!ticket || used.has(ticket)) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return }
      used.add(ticket)
      wss.handleUpgrade(req, socket, head, (ws) => ws.on('message', () => ws.send(JSON.stringify({ method: 'chat.list', chats: [], path: req.url }))))
    })
    backend.listen(0, '0.0.0.0'); await once(backend, 'listening')
    const upstream = `http://10.2.3.6:${(backend.address() as { port: number }).port}`
    const proxy = createWebServer({ root, backendHttp: upstream, backendWs: upstream + '/', basePath: '/nyxus' })
    proxy.listen(0, '0.0.0.0'); await once(proxy, 'listening')
    const base = `http://10.2.3.6:${(proxy.address() as { port: number }).port}`
    let ws: WebSocket | undefined
    try {
      expect(await (await fetch(base + '/nyxus/api/config?test=1')).json()).toEqual({ path: '/nyxus/api/config?test=1' })
      expect((await fetch(base + '/wrong/api/config')).status).toBe(404)
      const query = 'ticket=isolated-ticket&profile=lite&v=1&maxFrameBytes=512'
      ws = new WebSocket(base.replace('http:', 'ws:') + '/nyxus/ws?' + query)
      await once(ws, 'open'); ws.send(JSON.stringify({ method: 'chat.list' }))
      const [message] = await once(ws, 'message')
      expect(JSON.parse(message.toString())).toEqual({ method: 'chat.list', chats: [], path: '/?' + query })
      const replay = new WebSocket(base.replace('http:', 'ws:') + '/nyxus/ws?' + query)
      expect(await new Promise<boolean>((resolve) => { replay.once('error', () => resolve(true)); replay.once('open', () => { replay.terminate(); resolve(false) }) })).toBe(true)
    } finally {
      ws?.terminate(); wss.close(); await new Promise<void>((resolve) => proxy.close(() => resolve())); await new Promise<void>((resolve) => backend.close(() => resolve())); await rm(root, { recursive: true, force: true })
    }
  })
})
