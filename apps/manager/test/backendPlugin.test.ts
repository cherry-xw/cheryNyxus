import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { AccountStore } from '../src/accountStore.js'
import { createManager, type ManagerOptions } from '../src/server.js'
import { BackendPluginConfigStore } from '../src/backendPluginConfig.js'
import { withBackendLifecycle } from './backendFixture.js'

const managers: ReturnType<typeof createManager>[] = []
const roots: string[] = []
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(extra: ManagerOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'manager-backend-plugin-'))
  roots.push(root)
  const configFile = join(root, 'config.yaml')
  await writeFile(configFile, 'server:\n  host: 127.0.0.1\n  port: 1\n  webPort: 1\nmanager:\n  host: 127.0.0.1\n')
  const authFile = join(root, 'auth.json')
  await new AccountStore(authFile).save('owner', 'manager-test-password')
  const manager = createManager({
    port: 0,
    host: '127.0.0.1',
    cheryDir: root,
    configFile,
    authFile,
    credentialsFile: join(root, 'credentials.json'),
    tokenFile: join(root, 'token.json'),
    backendCommand: process.execPath,
    backendSupervisor: {
      retryDelaysMs: [20, 30, 40],
      isReady: async () => false,
      readinessPollMs: 10,
    },
    ...extra,
  })
  managers.push(manager)
  await manager.listen()
  const base = `http://127.0.0.1:${manager.address()!.port}`
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'owner', password: 'manager-test-password' }),
  })
  expect(login.status).toBe(200)
  const headers = {
    Cookie: login.headers.get('set-cookie')!.split(';')[0]!,
    Origin: base,
    'Content-Type': 'application/json',
  }
  const request = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } })
  return { root, configFile, manager, base, headers, request }
}

async function waitForState(
  request: (path: string, init?: RequestInit) => Promise<Response>,
  state: string,
  timeout = 5_000,
) {
  const begin = Date.now()
  let last: Record<string, unknown> = {}
  while (Date.now() - begin < timeout) {
    const response = await request('/api/backend-plugin/status')
    const body = (await response.json()) as { data: Record<string, unknown> }
    last = body.data
    if (body.data.state === state) return body.data
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`等待 ${state} 超时，最后状态：${JSON.stringify(last)}`)
}

it('external status probes configured port without inventing process metrics', async () => {
  const {configFile, manager, request} = await fixture({backendMode:'external'})
  await writeFile(configFile, `server:
  host: 127.0.0.1
  port: ${manager.address()!.port}
`)
  const {data} = await (await request('/api/backend-plugin/status')).json() as any
  expect(data).toMatchObject({state:'running',running:true,managedBy:'external',pid:null,uptimeSeconds:null,listener:{host:'127.0.0.1',port:manager.address()!.port,ready:true}})
  expect(data.resources.process.memoryBytes).toBeNull()
  await writeFile(configFile, 'server: {host: 127.0.0.1, port: 1}')
  const offline = await (await request('/api/backend-plugin/status')).json() as any
  expect(offline.data).toMatchObject({running:false,listener:{port:1,ready:false}})
})

it('受 Manager 会话保护的预装插件状态接口返回默认值', async () => {
  const { manager, base } = await fixture()
  expect((await fetch(`${base}/api/backend-plugin/status`)).status).toBe(401)
  // ManagerAuth 既有契约：修改类请求先做同源校验，缺 Origin/跨站一律 403（见 server.test.ts），
  // 会话校验（401）在同源之后；GET 未登录始终 401。
  expect((await fetch(`${base}/api/backend-plugin/start`, { method: 'POST' })).status).toBe(403)
  expect(
    (await fetch(`${base}/api/backend-plugin/start`, { method: 'POST', headers: { Origin: 'http://evil' } })).status,
  ).toBe(403)
  const { request } = { request: (path: string, init?: RequestInit) => fetch(`${base}${path}`, init) }
  const anonymous = await request('/api/backend-plugin/status')
  expect(anonymous.status).toBe(401)
  const { request: session } = await (async () => ({ request: async (path: string) => {
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'owner', password: 'manager-test-password' }),
    })
    return fetch(`${base}${path}`, { headers: { Cookie: login.headers.get('set-cookie')!.split(';')[0]! } })
  } }))()
  const status = await (await session('/api/backend-plugin/status')).json() as { data: Record<string, unknown> }
  expect(status.data).toMatchObject({
    state: 'inactive',
    running: false,
    pid: null,
    retryCount: 0,
    maxRetries: 3,
    nextRetryAt: null,
    lastError: null,
    autoStart: true,
    managedBy: 'manager',
    logs: [],
  })
  expect(status.data.resources).toMatchObject({ system: expect.any(Object), process: expect.any(Object) })
  expect(manager.supervisor.currentState()).toBe('inactive')
})

it('启动失败按 3 次上限进入 failed，停止接口仍可使用且不保留旧重启/停用路径', async () => {
  const { request } = await fixture({ backendArgs: ['-e', 'setTimeout(() => process.exit(3), 5)'] })
  const started = await request('/api/backend-plugin/start', { method: 'POST' })
  expect(started.status).toBe(200)
  const failed = await waitForState(request, 'failed')
  expect(failed).toMatchObject({ retryCount: 3, maxRetries: 3, nextRetryAt: null, running: false })
  expect(String(failed.lastError)).toContain('退出码 3')
  expect(failed.logs).toEqual([])
  expect((await request('/api/backend/stop', { method: 'POST' })).status).toBe(200)
  for (const path of [
    '/api/backend-plugin/restart',
    '/api/backend-plugin/disable',
  ]) {
    expect((await request(path, { method: 'POST' })).status).toBe(404)
  }
})

it('重试等待期可取消自动重试，取消后不再启动', async () => {
  const { request } = await fixture({
    backendArgs: ['-e', 'setTimeout(() => process.exit(6), 5)'],
    backendSupervisor: { retryDelaysMs: [5_000], isReady: async () => false, readinessPollMs: 10 },
  })
  await request('/api/backend-plugin/start', { method: 'POST' })
  const retrying = await waitForState(request, 'retrying')
  expect(retrying.retryCount).toBe(1)
  expect(retrying.nextRetryAt).not.toBeNull()
  const cancelled = await request('/api/backend-plugin/cancel-retry', { method: 'POST' })
  expect(cancelled.status).toBe(200)
  const body = (await cancelled.json()) as { data: Record<string, unknown> }
  expect(body.data).toMatchObject({ state: 'failed', retryCount: 1, nextRetryAt: null })
  expect(String(body.data.lastError)).toContain('已手动取消自动重试')
  // 不在重试等待期时再次取消应被拒绝。
  expect((await request('/api/backend-plugin/cancel-retry', { method: 'POST' })).status).toBe(409)
  await new Promise((resolve) => setTimeout(resolve, 150))
  const status = (await (await request('/api/backend-plugin/status')).json()) as { data: Record<string, unknown> }
  expect(status.data.state).toBe('failed')
})

it('autoStart 开关持久化到配置事务并回读确认，其他配置保持原样', async () => {
  const { request, configFile, manager } = await fixture()
  const saved = await request('/api/backend-plugin/config', {
    method: 'PUT',
    body: JSON.stringify({ autoStart: false }),
  })
  expect(saved.status).toBe(200)
  expect(await saved.json()).toMatchObject({ data: { autoStart: false } })
  const text = await readFile(configFile, 'utf8')
  expect(text).toContain('autoStart: false')
  expect(text).toContain('manager:')
  expect(text).toContain('host: 127.0.0.1')
  expect((await manager.backendPluginConfig.view()).autoStart).toBe(false)
  // 单次运行状态变化不写回开关，开关只影响下次启动。
  expect(await manager.autoStartBackend()).toEqual({ started: false, reason: 'auto_start_disabled' })
  expect(manager.supervisor.currentState()).toBe('inactive')
  // 非法输入拒绝，且不破坏已有配置。
  expect(
    (
      await request('/api/backend-plugin/config', {
        method: 'PUT',
        body: JSON.stringify({ autoStart: 'yes' }),
      })
    ).status,
  ).toBe(400)
  expect((await manager.backendPluginConfig.view()).autoStart).toBe(false)
})

it('autoStart 为 true 时 Manager 启动自动拉起 Backend，端口已占用则不重复拉起', async () => {
  const { manager } = await fixture({
    backendArgs: ['-e', withBackendLifecycle('setInterval(() => {}, 1000)')],
    backendSupervisor: { isReady: async () => true, readinessPollMs: 5 },
  })
  const started = await manager.autoStartBackend()
  expect(started).toEqual({ started: true })
  const snapshot = await manager.supervisor.snapshot({ logs: false })
  expect(snapshot.pid).not.toBeNull()
  expect(['starting', 'running']).toContain(snapshot.state)
  await manager.supervisor.shutdown()
})

it('Backend 离线时平级插件列表仍返回本地已安装插件并标记不可用', async () => {
  const { root, request } = await fixture()
  await mkdir(join(root, '.chery', 'ingress'), { recursive: true })
  await writeFile(
    join(root, '.chery', 'ingress', 'registry.json'),
    JSON.stringify({
      schemaVersion: 2,
      revision: 7,
      plugins: [
        {
          id: 'qq',
          version: '1.2.3',
          apiVersion: 2,
          entry: 'index.html',
          dependencies: [],
          capabilities: ['ingress', 'manager.ui'],
          enabled: true,
          packageDigest: 'a'.repeat(64),
          grantedCapabilities: ['ingress', 'manager.ui', 'unknown-capability'],
          channelGrants: [],
        },
        {
          id: 'capabilities',
          version: '0.4.0',
          apiVersion: 2,
          entry: 'index.html',
          dependencies: [{ id: 'qq', version: '1.2.3' }],
          capabilities: ['rpc.management'],
          enabled: false,
          packageDigest: 'b'.repeat(64),
          grantedCapabilities: ['rpc.management'],
          channelGrants: [],
        },
        { id: 'BAD ID', version: '1.0.0', apiVersion: 2 },
      ],
    }),
  )
  const response = await request('/api/plugins')
  expect(response.status).toBe(200)
  const body = (await response.json()) as {
    data: {
      contractVersion: number
      registryRevision: number
      backendUnavailable: boolean
      plugins: Array<Record<string, unknown>>
    }
  }
  expect(body.data.contractVersion).toBe(2)
  expect(body.data.registryRevision).toBe(7)
  expect(body.data.backendUnavailable).toBe(true)
  expect(body.data.plugins.map((plugin) => plugin.id)).toEqual(['qq', 'capabilities'])
  for (const plugin of body.data.plugins) {
    expect(plugin).toMatchObject({
      installed: true,
      backendUnavailable: true,
      reason: '依赖 Backend 运行，当前不可用',
      state: 'unknown',
    })
  }
  expect(body.data.plugins[0]).toMatchObject({ enabled: true, savedVersion: '1.2.3' })
  expect(body.data.plugins[0]!.grantedCapabilities).toEqual(['ingress', 'manager.ui'])
  expect(body.data.plugins[1]).toMatchObject({ enabled: false, savedVersion: '0.4.0' })
  expect(body.data.plugins[1]!.dependencies).toEqual([{ id: 'qq', version: '1.2.3' }])
})

it('配置存储默认 autoStart 为 true，并在缺失文件时也能保存', async () => {
  const root = await mkdtemp(join(tmpdir(), 'manager-backend-config-'))
  roots.push(root)
  const file = join(root, 'config.yaml')
  const store = new BackendPluginConfigStore(file)
  expect(await store.view()).toEqual({ autoStart: true })
  expect(await store.save({ autoStart: false })).toEqual({ autoStart: false })
  expect(await store.view()).toEqual({ autoStart: false })
  await expect(store.save({ autoStart: 1 })).rejects.toThrow('autoStart 必须是布尔值')
  await expect(store.save(null)).rejects.toThrow('config 必须是对象')
})
