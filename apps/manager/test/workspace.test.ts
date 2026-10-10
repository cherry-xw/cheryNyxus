import { afterEach, describe, expect, it, vi } from 'vitest'
import { managerRequest, onManagerSessionExpired, ManagerApiError } from '../../../packages/manager-ui/src/api'
import { useQq } from '../../../plugins/qq/ui/useQq'
import { QQDefaultConfig } from '../../../packages/protocol/src/qq'

afterEach(() => vi.restoreAllMocks())
describe('workspace failure isolation', () => {
  it('does not expire Manager login on Backend authentication failure', async () => {
    const expired = vi.fn(); onManagerSessionExpired(expired)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: { code: 'backend_auth_failed', message: 'private-secret' } }), { status: 502 }))
    await expect(managerRequest('/api/modules/qq/status')).rejects.toMatchObject({ code: 'backend_auth_failed', status: 502, message: expect.stringContaining('无需再次登录') })
    expect(expired).not.toHaveBeenCalled()
  })
  it('expires only the manager session for a protected 401', async () => {
    const expired = vi.fn(); onManagerSessionExpired(expired)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"error":"unauthorized"}', { status: 401 }))
    await expect(managerRequest('/api/modules/qq/status')).rejects.toMatchObject({ status: 401 })
    expect(expired).toHaveBeenCalledOnce()
  })
  it('keeps valid configuration when another status request fails', async () => {
    const config = structuredClone(QQDefaultConfig)
    const request = vi.fn(async (path: string) => {
      if (path.endsWith('/config')) return { data: { config, baseRevision: 1, apply: { state: 'applied', revision: 1 } } }
      if (path.endsWith('/catalog')) return { data: { presets: [], tools: [] } }
      throw new ManagerApiError('unavailable', 503, path, '离线')
    })
    const qq = useQq(request as typeof managerRequest)
    await qq.load()
    expect(qq.state.ready).toBe(true)
    expect(qq.state.status).toBeNull()
    expect(qq.state.statusError).toContain('离线')
    qq.add('users', '123')
    await qq.read()
    expect(qq.state.config.users).toEqual(['123'])
    expect(qq.dirty.value).toBe(true)
  })
  it('blocks a repeat save after conflict and preserves draft', async () => {
    const request = vi.fn(async (_path: string, init?: RequestInit) => {
      if (init?.method === 'PUT') throw new ManagerApiError('revision_conflict', 409, '/config', '冲突')
      return { data: { config: structuredClone(QQDefaultConfig), baseRevision: 1, apply: { state: 'applied', revision: 1 } } }
    })
    const qq = useQq(request as typeof managerRequest)
    await qq.read(); qq.add('users', '123'); await qq.save(); await qq.save()
    expect(qq.state.config.users).toEqual(['123'])
    expect(qq.state.uncertain).toBe(true)
    expect(request.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1)
  })
})
