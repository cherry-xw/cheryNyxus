import { createServer } from 'node:http'
import { ProcessController } from './processController.js'

export interface ManagerOptions {
  host?: string
  port?: number
  backendCommand?: string
  backendArgs?: string[]
  ratholeCommand?: string
  ratholeArgs?: string[]
  controlToken?: string
}

export function createManager(options: ManagerOptions = {}) {
  const controller = new ProcessController()
  const backendCommand = options.backendCommand ?? process.execPath
  const backendArgs = options.backendArgs ?? ['dist/index.js']
  const ratholeCommand = options.ratholeCommand ?? 'rathole'
  const ratholeArgs = options.ratholeArgs ?? ['--config', 'rathole-client.toml']
  const server = createServer(async (req, res) => {
    if (req.socket.remoteAddress !== '127.0.0.1' && req.socket.remoteAddress !== '::1' && req.socket.remoteAddress !== '::ffff:127.0.0.1') {
      res.writeHead(403)
      res.end('Forbidden')
      return
    }
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    if (path === '/api/status' && req.method === 'GET') {
      json(res, 200, { manager: 'running', processes: controller.state() })
      return
    }
    const match = /^\/api\/(backend|rathole)\/(start|stop|restart)$/.exec(path)
    if (match && (req.method === 'POST' || req.method === 'PUT')) {
      if (!options.controlToken || req.headers['x-chery-manager-token'] !== options.controlToken) {
        res.writeHead(401, { 'Cache-Control': 'no-store' })
        res.end('Unauthorized')
        return
      }
      const name = match[1] as 'backend' | 'rathole'
      const action = match[2]
      const result = action === 'stop'
        ? await controller.stop(name)
        : action === 'restart'
          ? await controller.restart(name, name === 'backend' ? backendCommand : ratholeCommand, name === 'backend' ? backendArgs : ratholeArgs)
          : controller.start(name, name === 'backend' ? backendCommand : ratholeCommand, name === 'backend' ? backendArgs : ratholeArgs)
      json(res, 200, result)
      return
    }
    if (path === '/api/connection' && req.method === 'GET') {
      json(res, 200, { processes: controller.state(), backend: { status: 'unknown' }, tunnel: { status: 'unknown' } })
      return
    }
    if (path === '/' || path === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><title>CheryNyxus Manager</title><h1>CheryNyxus 本地管理器</h1><p>管理 API：/api/status</p>')
      return
    }
    res.writeHead(404)
    res.end('Not Found')
  })
  return {
    controller,
    listen: () => new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(options.port ?? 39980, options.host ?? '127.0.0.1', () => resolve())
    }),
    close: async () => {
      await controller.stopAll()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

function json(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}
