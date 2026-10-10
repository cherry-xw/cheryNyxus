import { describe, it, expect, vi } from 'vitest'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DynamicModules, safePluginPath } from '../src/modules/dynamic'
import { AccountStore } from '../src/accountStore'
import { createManager } from '../src/server'
import { usePlugins } from '../ui/usePlugins'
import { managerRequest, ManagerApiError } from '../../../packages/manager-ui/src/api'
import type { CoreRpc } from '../src/modules/contracts'

const descriptor = (id: string) => ({
  pluginId: `sample-${id}`,
  pluginVersion: '1',
  apiVersion: 2,
  descriptor: {
    id,
    title: id,
    entry: 'ui/index.html',
    apiPrefix: `/api/modules/${id}/`,
    resourceVersion: '1',
  },
  enabled: false,
  businessState: 'inactive',
  routes: [
    { method: 'GET', path: 'config' },
    { method: 'PUT', path: 'config' },
  ],
})
const fixture = () => {
  let modules = [descriptor('alpha'), descriptor('beta')]
  const call = vi.fn(async (method: string, params: any) => {
    if (method === 'ingress.ui.list') return { contractVersion: 2, registryRevision: 1, modules }
    if (method === 'ingress.list')
      return { contractVersion: 2, hostApiVersion: 2, registryRevision: 1, plugins: [] }
    if (method === 'ingress.ui.read')
      return {
        contractVersion: 2,
        resourceVersion: '1',
        contentType: params.path.endsWith('.html') ? 'text/html' : 'text/javascript',
        contentBase64: Buffer.from(
          params.path.endsWith('.html')
            ? '<html><head></head><body><script src="./main.js"></script></body></html>'
            : 'export const ok = true',
        ).toString('base64'),
      }
    if (method === 'ingress.management.call')
      return { contractVersion: 2, status: 200, body: { data: { disabledManagement: true } } }
    throw new Error('unexpected method')
  })
  return {
    call,
    remove: () => {
      modules = []
    },
  }
}

describe('dynamic modules fixed public contract', () => {
  it('two synthetic packages register without Manager rebuilding, disabled keeps management, uninstall revokes every read', async () => {
    const f = fixture(),
      modules = new DynamicModules({ call: f.call } as CoreRpc)
    expect((await modules.modules()).modules.map((item) => item.descriptor.id)).toEqual([
      'alpha',
      'beta',
    ])
    expect((await modules.resource('alpha')).bytes.toString()).toContain(
      '<base href="/modules/alpha/assets/1/">',
    )
    expect((await modules.modules()).modules[0]!.manager).toMatchObject({
      state: 'ready',
      resourceVersion: '1',
    })
    expect(
      (
        await modules.business({
          method: 'GET',
          url: new URL('http://local/api/modules/alpha/config'),
        })
      ).body,
    ).toEqual({ data: { disabledManagement: true } })
    f.remove()
    await expect(modules.resource('alpha')).rejects.toMatchObject({ status: 404 })
    await expect(modules.resource('alpha', '1', 'main.js')).rejects.toMatchObject({ status: 404 })
    await expect(
      modules.business({ method: 'GET', url: new URL('http://local/api/modules/alpha/config') }),
    ).rejects.toMatchObject({ status: 404 })
  })
  it('rejects stale versions, escape paths, duplicate navigation, embedded base, and arbitrary RPC/target', async () => {
    const f = fixture(),
      modules = new DynamicModules({ call: f.call } as CoreRpc)
    await expect(modules.resource('alpha', 'old', 'main.js')).rejects.toMatchObject({ status: 409 })
    for (const path of [
      '../config.yaml',
      '%2e%2e/config',
      '%252e%252e/config',
      '/etc/passwd',
      'a\\b',
      'a//b',
      'a/./b',
      'https://remote/x',
    ])
      expect(() => safePluginPath(path)).toThrow()
    await expect(
      modules.business({
        method: 'POST',
        url: new URL('http://local/api/modules/alpha/chat.submit'),
        body: { method: 'chat.submit', target: 'http://remote' },
      }),
    ).rejects.toMatchObject({ status: 404 })
    const original = f.call.getMockImplementation()!
    f.call.mockImplementation(async (method, input) =>
      method === 'ingress.ui.list'
        ? {
            contractVersion: 2,
            registryRevision: 1,
            modules: [descriptor('alpha'), descriptor('alpha')],
          }
        : original(method, input),
    )
    await expect(modules.modules()).rejects.toMatchObject({ code: 'registration_conflict' })
    f.call.mockImplementation(async (method, input) =>
      method === 'ingress.ui.read'
        ? {
            contractVersion: 2,
            resourceVersion: '1',
            contentType: 'text/html',
            contentBase64: Buffer.from('<head><base href="https://bad/"></head>').toString(
              'base64',
            ),
          }
        : original(method, input),
    )
    await expect(modules.resource('alpha')).rejects.toMatchObject({ code: 'invalid_response' })
  })
  it('does not retry an ambiguous write and keeps config readback failure uncertain', async () => {
    const call = vi.fn(async (method: string) => {
      if (method === 'ingress.config.save')
        return {
          contractVersion: 2,
          id: 'sample',
          config: {},
          baseRevision: 1,
          apply: { state: 'pending', revision: 1 },
          saved: true,
        }
      throw new Error('offline')
    })
    const modules = new DynamicModules({ call } as CoreRpc)
    await expect(
      modules.plugins({
        method: 'PUT',
        url: new URL('http://local/api/plugins/sample/config'),
        body: { contractVersion: 2, config: {}, expectedBaseRevision: 0, requestId: 'one' },
      }),
    ).rejects.toMatchObject({ code: 'save_unconfirmed', status: 502 })
    expect(call.mock.calls.filter(([method]) => method.endsWith('save'))).toHaveLength(1)
  })
  it('page controller blocks repeat unknown writes and refresh removes stale navigation', async () => {
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === 'POST')
        throw new ManagerApiError('save_unconfirmed', 502, path, '未知写入')
      if (path === '/api/plugins')
        return { data: { contractVersion: 2, hostApiVersion: 2, registryRevision: 1, plugins: [] } }
      return {
        data: { contractVersion: 2, managerApiVersion: 2, registryRevision: 1, modules: [] },
      }
    })
    const plugins = usePlugins(request as typeof managerRequest)
    await plugins.read()
    await plugins.mutate('disable', 'sample')
    await plugins.mutate('disable', 'sample')
    expect(request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
    expect(plugins.state.uncertain).toBe(true)
    await plugins.read()
    expect(plugins.state.uncertain).toBe(false)
    expect(plugins.state.modules).toEqual([])
  })
})

describe('real Manager HTTP Session protected plugin resources', () => {
  it('requires Session and same origin for HTML/assets/API; machine credentials cannot enter; no business packages still permits login', async () => {
    const f = fixture()
    const rpc = await import('../src/modules/capabilities/rpc')
    const spy = vi
      .spyOn(rpc, 'createManagerCoreRpc')
      .mockReturnValue({ call: f.call, close: () => {} } as any)
    const root = await mkdtemp(join(tmpdir(), 'manager-dynamic-'))
    const authFile = join(root, 'auth.json'),
      configFile = join(root, 'config.yaml')
    await new AccountStore(authFile).save('owner', 'synthetic-manager-password')
    await writeFile(configFile, 'manager: {}\n')
    const manager = createManager({
      port: 0,
      authFile,
      configFile,
      tokenFile: join(root, 'token.json'),
      connectionCredentials: { alpha: join(root, 'connection-token.json') },
      credentialsFile: join(root, 'credentials.json'),
      controlToken: 'synthetic-machine-key',
    })
    await manager.listen()
    const base = `http://127.0.0.1:${manager.address()!.port}`
    try {
      const login = await fetch(base + '/api/auth/login', {
        method: 'POST',
        headers: { Origin: base, 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'owner', password: 'synthetic-manager-password' }),
      })
      expect(login.status).toBe(200)
      const Cookie = login.headers.get('set-cookie')!.split(';')[0]!
      const credentialPath = '/api/connections/alpha/credential'
      expect((await fetch(base + credentialPath)).status).toBe(401)
      const first = await fetch(base + credentialPath, { headers: { Cookie } })
      expect(first.status).toBe(200)
      const firstCredential = await first.json()
      expect(firstCredential.token).toHaveLength(43)
      expect((await fetch(base + credentialPath + '/rotate', { method: 'POST', headers: { Cookie } })).status).toBe(403)
      const rotated = await fetch(base + credentialPath + '/rotate', { method: 'POST', headers: { Cookie, Origin: base } })
      expect(rotated.status).toBe(200)
      const rotatedCredential = await rotated.json()
      expect(rotatedCredential.token).not.toBe(firstCredential.token)
      expect(await (await fetch(base + credentialPath, { headers: { Cookie } })).json()).toEqual(rotatedCredential)
      await writeFile(join(root, 'connection-token.json'), 'invalid')
      expect((await fetch(base + credentialPath, { headers: { Cookie } })).status).toBe(503)
      expect(await readFile(join(root, 'connection-token.json'), 'utf8')).toBe('invalid')
      expect((await fetch(base + '/api/connections/missing/credential', { headers: { Cookie } })).status).toBe(404)
      for (const path of [
        '/modules/alpha',
        '/modules/alpha/assets/1/main.js',
        '/api/modules/alpha/config',
        '/api/plugins',
      ]) {
        expect((await fetch(base + path)).status).toBe(401)
        expect(
          (
            await fetch(base + path, {
              headers: { 'x-chery-manager-machine-key': 'synthetic-machine-key' },
            })
          ).status,
        ).toBe(401)
        expect(
          (await fetch(base + path, { headers: { Cookie, Origin: 'http://evil' } })).status,
        ).toBe(403)
        expect((await fetch(base + (path === '/modules/alpha' ? path + '?embedded=1' : path), { headers: { Cookie, 'Sec-Fetch-Dest': 'iframe' } })).status).toBe(200)
      }
      expect(
        (
          await fetch(base + '/modules/alpha', {
            headers: { Cookie, 'Sec-Fetch-Site': 'cross-site' },
          })
        ).status,
      ).toBe(403)
      const html = await fetch(base + '/modules/alpha?embedded=1', { headers: { Cookie, 'Sec-Fetch-Dest': 'iframe' } })
      expect(html.headers.get('cache-control')).toBe('no-store')
      expect(html.headers.get('x-content-type-options')).toBe('nosniff')
      expect(await html.text()).toContain('<base href="/modules/alpha/assets/1/">')
      expect(
        (
          await fetch(base + '/modules/alpha/assets/1/%252e%252e/config.yaml', {
            headers: { Cookie },
          })
        ).status,
      ).toBe(400)
      expect(
        (await fetch(base + '/modules/alpha/assets/0/main.js', { headers: { Cookie } })).status,
      ).toBe(409)
      expect(
        (
          await fetch(base + '/api/modules/alpha/config', {
            method: 'PUT',
            headers: { Cookie, 'Content-Type': 'application/json' },
            body: '{}',
          })
        ).status,
      ).toBe(403)
      f.remove()
      expect((await fetch(base + '/modules/alpha?embedded=1', { headers: { Cookie, 'Sec-Fetch-Dest': 'iframe' } })).status).toBe(404)
      expect((await fetch(base + '/api/auth/me', { headers: { Cookie } })).status).toBe(200)
      expect(
        (await (await fetch(base + '/api/plugins', { headers: { Cookie } })).json()).data.plugins,
      ).toEqual([])
    } finally {
      await manager.close()
      spy.mockRestore()
    }
  })
})
