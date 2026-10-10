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
})
