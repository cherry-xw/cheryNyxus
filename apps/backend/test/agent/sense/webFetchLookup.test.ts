import { EventEmitter } from 'node:events'
import { lookup } from 'node:dns/promises'
import { request } from 'node:http'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WebFetchRuntime } from '../../../src/agent/sense/web/fetch.js'

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }))
vi.mock('node:http', () => ({ request: vi.fn() }))
vi.mock('node:https', () => ({ request: vi.fn() }))
const records = [{ address: '93.184.216.34', family: 4 }, { address: '2606:4700:4700::1111', family: 6 }]

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(lookup).mockResolvedValue(records)
})

describe('production web fetch pinned DNS lookup', () => {
  it.each([true, false])('honors all=%s and reports real IPv4/IPv6 families', async all => {
    const callback = vi.fn()
    vi.mocked(request).mockImplementation(((options: any, respond: any) => {
      options.lookup('example.org', { all }, callback)
      const req = Object.assign(new EventEmitter(), {
        end() {
          const response = Object.assign(new EventEmitter(), { statusCode: 200, headers: { 'content-type': 'text/plain' } })
          respond(response)
          response.emit('data', Buffer.from('fixture'))
          response.emit('end')
        },
        destroy: vi.fn(),
      })
      return req
    }) as any)
    expect(await new WebFetchRuntime().fetch({ url: 'http://example.org/' })).toMatchObject({ ok: true, text: 'fixture' })
    if (all) expect(callback).toHaveBeenCalledWith(null, records)
    else expect(callback).toHaveBeenCalledWith(null, records[0]!.address, 4)
    // Runtime preflight and transport pinning only: lookup callback never does DNS.
    expect(lookup).toHaveBeenCalledTimes(2)
    expect(lookup).toHaveBeenCalledWith('example.org', { all: true, verbatim: true })
  })

  it('reports family 6 for an IPv6-only DNS answer', async () => {
    vi.mocked(lookup).mockResolvedValue([records[1]!])
    const callback = vi.fn()
    vi.mocked(request).mockImplementation(((options: any) => {
      options.lookup('example.org', {}, callback)
      const req = Object.assign(new EventEmitter(), { end() { req.emit('error', new Error('fixture stop')) } })
      return req
    }) as any)
    await new WebFetchRuntime().fetch({ url: 'http://example.org/' })
    expect(callback).toHaveBeenCalledWith(null, records[1]!.address, 6)
  })

  it('rejects mixed public/private DNS answers before creating a request', async () => {
    vi.mocked(lookup).mockResolvedValue([...records, { address: '127.0.0.1', family: 4 }])
    expect(await new WebFetchRuntime().fetch({ url: 'http://example.org/' })).toMatchObject({ ok: false, error: { code: 'forbidden_address' } })
    expect(request).not.toHaveBeenCalled()
  })
})
