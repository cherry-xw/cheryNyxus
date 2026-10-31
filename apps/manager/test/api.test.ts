import { afterEach, describe, expect, it, vi } from 'vitest'
import { managerRequest } from '../../../packages/manager-ui/src/api'

describe('Manager request wrapper', () => {
  afterEach(() => vi.restoreAllMocks())

  it('preserves same-origin credentials and JSON parameters', async () => {
    const response = { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({ authenticated: true }) } as Response
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response)
    await expect(managerRequest('/api/auth/me')).resolves.toEqual({ authenticated: true })
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/me', expect.objectContaining({ credentials: 'same-origin', cache: 'no-store', redirect: 'error' }))
  })

  it('does not include a secret in returned error text', async () => {
    const response = { ok: false, status: 503, headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({ error: { code: 'unavailable', message: 'secret-key-must-not-leak' } }) } as Response
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response)
    await expect(managerRequest('/api/modules/capabilities/models', { method: 'POST', body: JSON.stringify({ key: 'secret-key-must-not-leak' }) })).rejects.toMatchObject({ code: 'unavailable', status: 503, message: expect.not.stringContaining('secret-key-must-not-leak') })
  })
  it('propagates page disposal to the actual fetch and never submits an already cancelled read', async () => {
    const controller = new AbortController()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_path, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })
    }))
    const pending = managerRequest('/api/modules/qq/context/index', { signal: controller.signal })
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await rejection
    expect(fetchMock.mock.calls[0]![1]!.signal!.aborted).toBe(true)
    await expect(managerRequest('/api/modules/qq/context/index', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})
