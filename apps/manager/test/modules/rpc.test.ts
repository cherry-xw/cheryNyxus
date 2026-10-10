import { describe, it, expect } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { BackendRpcClient } from '../../src/modules/capabilities/rpc.js'
import { createSettingsPackage as createCapabilitiesModule } from '../settingsPackage.js'
import { SettingsService as CapabilityService } from '../../../../plugins/settings/src/service.js'
import { CapabilityError } from '../../../../plugins/settings/src/errors.js'

describe('bounded RPC failure boundaries (consumer tests only)', () => {
  it('distinguishes uncertain writes and saved-but-failed readback without retrying saves', async () => {
    const state = {
      protocolVersion: 2,
      savedRevision: 'new',
      appliedRevision: 'old',
      status: 'failed',
      impacts: [],
      restart: { required: true, status: 'manual' },
    }
    for (const mode of ['uncertain', 'readback', 'failed-apply', 'auth-save', 'auth-readback']) {
      let reads = 0
      let saves = 0
      const service = new CapabilityService({
        call: async (method) => {
          if (method === 'config.get') {
            reads++
            if (reads > 1 && mode === 'auth-readback')
              throw new CapabilityError('backend_auth_failed', 502, '后端拒绝管理权限')
            if (reads > 1 && mode === 'readback')
              throw new CapabilityError('unavailable', 503, 'private')
            return {
              baseRevision: reads === 1 ? 'old' : 'new',
              global: {},
              llm: { brain: { test: { provider: 'openai', model: reads === 1 ? 'old' : 'new' } } },
            }
          }
          if (method === 'config.save') {
            saves++
            if (mode === 'auth-save')
              throw new CapabilityError('backend_auth_failed', 502, '后端拒绝管理权限')
            if (mode === 'uncertain') throw new CapabilityError('unavailable', 503, 'private')
            return { ...state, baseRevision: 'new', candidateRevisionId: 'candidate', warnings: [] }
          }
          if (method === 'config.preview')
            return {
              protocolVersion: 2,
              baseRevision: 'old',
              previewToken: `preview-${mode}`,
              impacts: [],
              destructiveTargets: [],
              policy: 'wait',
            }
          return state
        },
      })
      const operation = service.save('brains', false, {
        name: 'test',
        value: { model: 'new' },
        expectedBaseRevision: 'old',
        requestId: mode,
      })
      if (mode === 'failed-apply')
        await expect(operation).resolves.toMatchObject({
          saved: true,
          apply: { status: 'failed', restart: { required: true } },
        })
      else
        await expect(operation).rejects.toMatchObject({
          code:
            mode === 'uncertain'
              ? 'save_unconfirmed'
              : mode === 'auth-save'
                ? 'backend_auth_failed'
                : 'saved_readback_failed',
        })
      expect(saves).toBe(1)
    }
  })
  it('offline and missing credentials fail closed without file fallback', async () => {
    const rpc = new BackendRpcClient({
      target: async () => ({ http: 'http://127.0.0.1:1', ws: 'ws://127.0.0.1:2' }),
      credentials: async () => ({ username: 'test', password: 'synthetic' }),
      timeoutMs: 100,
    })
    await expect(rpc.call('config.get')).rejects.toMatchObject({ code: 'unavailable' })
    rpc.close()
    await expect(rpc.call('config.get')).rejects.toMatchObject({ code: 'unavailable' })
    const missing = new BackendRpcClient({
      target: async () => ({ http: 'http://127.0.0.1:1', ws: 'ws://127.0.0.1:2' }),
      credentials: async () => ({ username: '' }),
    })
    await expect(missing.call('config.get')).rejects.toMatchObject({
      code: 'backend_auth_failed',
      status: 502,
    })
  })
  it('arbitrary RPC and user-controlled target material are refused', async () => {
    const rpc = new BackendRpcClient({
      target: async () => ({ http: 'http://127.0.0.1/', ws: 'ws://other.invalid/' }),
      credentials: async () => ({ username: 'test', password: 'synthetic' }),
    })
    await expect(rpc.call('chat.send' as never)).rejects.toMatchObject({
      code: 'method_not_allowed',
    })
    await expect(rpc.call('config.get')).rejects.toMatchObject({ code: 'unavailable' })
  })
  it('backend denial never exposes upstream body or credentials', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(401)
      res.end('synthetic-secret')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const rpc = new BackendRpcClient({
      target: async () => ({ http: `http://127.0.0.1:${port}`, ws: 'ws://127.0.0.1:2' }),
      credentials: async () => ({ username: 'test', password: 'synthetic-secret' }),
    })
    try {
      await expect(rpc.call('config.get')).rejects.toMatchObject({
        code: 'backend_auth_failed',
        status: 502,
        message: '后端认证失败，请检查服务端凭据',
      })
    } finally {
      rpc.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
  it('invalid core responses and unrecognized routes are never successful empty catalog', async () => {
    const module = createCapabilitiesModule({ call: async () => ({}) })
    expect(
      (
        await module.handle({
          method: 'GET',
          url: new URL('http://manager/api/modules/capabilities/catalog'),
        })
      ).status,
    ).toBe(503)
    expect(
      (
        await module.handle({
          method: 'GET',
          url: new URL('http://manager/api/modules/capabilities/apply'),
        })
      ).status,
    ).toBe(503)
    expect(
      (
        await module.handle({
          method: 'GET',
          url: new URL('http://manager/api/modules/capabilities/rpc'),
        })
      ).status,
    ).toBe(404)
  })
})
