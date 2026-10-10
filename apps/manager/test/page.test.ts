import { describe, expect, it, vi } from 'vitest'
import type { ServerResponse } from 'node:http'
import { writeManagerPage } from '../src/page.js'

function page(lanAccess = false) {
  let html = ''
  writeManagerPage({ writeHead() {}, end(value: string) { html = value } } as unknown as ServerResponse, lanAccess)
  return html
}

describe('Manager Vue entry page', () => {
  it('serves the compiled Vue shell with LAN bootstrap data', () => {
    const html = page(true)
    expect(html).toContain('<div id="app"></div>')
    expect(html).toContain('__CHERY_MANAGER__={lanAccess:true}')
    expect(html).toContain('/assets/manager.js')
    expect(html).toContain('/assets/index-')
    expect(html).not.toContain('X-Chery-Manager-Token')
    expect(html).not.toContain('localStorage')
    expect(html).not.toContain('下载 QQ')
  })

  it('keeps the page response no-store and does not expose credentials in bootstrap data', () => {
    const headers = vi.fn()
    const end = vi.fn()
    writeManagerPage({ writeHead: headers, end } as unknown as ServerResponse, false)
    expect(headers).toHaveBeenCalledWith(200, expect.objectContaining({ 'Cache-Control': 'no-store' }))
    expect(end).toHaveBeenCalledWith(expect.stringContaining('__CHERY_MANAGER__={lanAccess:false}'))
    expect(end.mock.calls[0]?.[0]).not.toContain('modules:')
    expect(end.mock.calls[0]?.[0]).not.toContain('password')
    expect(end.mock.calls[0]?.[0]).not.toContain('service key')
  })
})
