import type { ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export function writeManagerPage(res: ServerResponse, lanAccess: boolean): void {
  try {
    const html = readFileSync(resolve(import.meta.dirname, '../dist/ui/index.html'), 'utf8')
      .replace('<!--MANAGER_LAN_ACCESS-->', String(lanAccess))
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(html)
  } catch {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end('Manager 页面构建产物不可用，请先运行 pnpm manager:build')
  }
}
