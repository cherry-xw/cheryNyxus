import { createServer } from 'node:http'
import { connect, type AddressInfo } from 'node:net'
import { readFile } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import { freemem, loadavg, totalmem, uptime } from 'node:os'
import yaml from 'js-yaml'
import { ProcessController, ProcessStartError } from './processController.js'
import { CredentialStore } from './credentials.js'
import { RelayConfigStore } from './relayConfig.js'
import { loadOrCreateToken } from './tokenStore.js'
import { loadOrCreateConnectionCredential, rotateConnectionCredential } from './connectionCredential.js'
import { AccountStore } from './accountStore.js'
import {
  ManagerAuth,
  constantEqual,
  localOrigin,
  loopback,
  readBody,
  type AuthOptions,
} from './auth.js'
import { verifyLogin } from './verifyLogin.js'
import { writeManagerPage as writeRetroManagerPage } from './page.js'

import { createManagerCoreRpc } from './modules/capabilities/rpc.js'
import { DynamicModules } from './modules/dynamic.js'
import { CapabilityError } from './modules/capabilities/errors.js'
import {
  disableInitialSetup,
  readInitialSetup,
  readOidcConfig,
  saveOidcConfig,
  validateOidcInput,
} from './authConfig.js'

export interface ManagerOptions {
  backendMode?: 'child' | 'external'
  host?: string
  port?: number
  backendCommand?: string
  backendArgs?: string[]
  ratholeCommand?: string
  ratholeArgs?: string[]
  controlToken?: string
  tokenFile?: string
  relayStatusFile?: string
  backendStatusFile?: string
  configFile?: string
  credentialsFile?: string
  connectionCredentials?: Record<string, string>
  authFile?: string
  auth?: AuthOptions
  now?: () => number

  relayAdminToken?: string
  plugins?: { packageSourceRoot?: string }
}

export function createManager(options: ManagerOptions = {}) {
  if (options.backendMode !== undefined && !['child', 'external'].includes(options.backendMode))
    throw new Error('backendMode 无效')
  const controller = new ProcessController()
  const cheryDir = process.env.CHERY_DIR ?? process.cwd()
  // 既有文件仅保留为机器密钥；不再授权浏览器或普通 API。
  const tokenState = loadOrCreateToken(
    options.tokenFile ?? `${cheryDir}/.chery/manager-token.json`,
    options.controlToken,
  )
  const controlToken = tokenState.token
  const connectionCredentials = options.connectionCredentials ?? {}
  for (const [id, file] of Object.entries(connectionCredentials)) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(id) || !file.startsWith('/'))
      throw new Error('connectionCredentials 必须使用模块 ID 和绝对文件路径')
  }
  const accountStore = new AccountStore(options.authFile ?? `${cheryDir}/.chery/manager-auth.json`)
  const configFile = options.configFile ?? `${cheryDir}/.chery/config.yaml`
  const auth = new ManagerAuth(accountStore, options.auth, options.now, {
    status: async () => (await readInitialSetup(configFile)).allowInitialSetup,
    create: async (username, password) => {
      await accountStore.saveInitial(username, password)
      await disableInitialSetup(configFile)
    },
  })
  const backendCommand = options.backendCommand ?? process.execPath
  const backendArgs = options.backendArgs ?? ['apps/backend/dist/index.js']
  const ratholeCommand = options.ratholeCommand ?? 'rathole'
  const ratholeArgs = options.ratholeArgs ?? ['--config', 'rathole-client.toml']
  const credentialStore = new CredentialStore({
    configFile,
    credentialsFile: options.credentialsFile ?? `${cheryDir}/.chery/manager-credentials.json`,
  })
  const relayConfig = new RelayConfigStore(configFile)
  const relayAdminToken = options.relayAdminToken ?? process.env.CHERY_RELAY_ADMIN_TOKEN ?? ''

  const modules = new DynamicModules(
    createManagerCoreRpc(configFile, credentialStore),
    options.plugins?.packageSourceRoot,
  )
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Frame-Options', 'DENY')
    try {
      let path = new URL(req.url ?? '/', 'http://localhost').pathname
      const machine = path.startsWith('/api/machine/')
      const origin = machine ? localOrigin(req) : auth.requestOrigin(req)
      if (!origin) {
        json(res, 403, { error: 'host_rejected' })
        return
      }
      if (path.startsWith('/api/machine/')) {
        const key = req.headers['x-chery-manager-machine-key']
        if (
          !loopback(req.socket.remoteAddress) ||
          req.headers.origin !== undefined ||
          req.headers.cookie !== undefined ||
          Object.keys(req.headers).some(
            (name) =>
              name === 'sec-fetch-site' || name.startsWith('x-forwarded-') || name === 'forwarded',
          ) ||
          typeof key !== 'string' ||
          !constantEqual(key, controlToken)
        ) {
          unauthorized(res)
          return
        }
        if (
          !/^\/api\/machine\/(status|connection|(?:backend|rathole)\/(?:start|stop|restart))$/.test(
            path,
          )
        ) {
          json(res, 404, { error: 'not_found' })
          return
        }
        path = path.replace('/api/machine/', '/api/')
      } else {
        if (req.headers['x-chery-manager-machine-key'] !== undefined) {
          unauthorized(res)
          return
        }
        if ((path === '/' || path === '/index.html') && req.method === 'GET') {
          writeRetroManagerPage(res, !isLoopbackHost(options.host))
          return
        }
        if (path.startsWith('/assets/') && req.method === 'GET') {
          try {
            const assetPath = resolve(import.meta.dirname, '../dist/ui', path.slice(1))
            if (!assetPath.startsWith(resolve(import.meta.dirname, '../dist/ui') + '/'))
              throw new Error('invalid asset path')
            const asset = await readFile(assetPath)
            const types: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css' }
            res.writeHead(200, {
              'Content-Type': `${types[extname(path)] ?? 'application/octet-stream'}; charset=utf-8`,
              'Cache-Control': 'no-store',
            })
            res.end(asset)
          } catch {
            json(res, 404, { error: 'not_found' })
          }
          return
        }
        if (!(await auth.authorize(req, res, path, origin))) return
      }
      if (path === '/api/auth/oidc/config' && req.method === 'GET') {
        json(res, 200, {
          data: await readOidcConfig(options.configFile ?? `${cheryDir}/.chery/config.yaml`),
          restartRequired: true,
        })
        return
      }
      if (path === '/api/auth/oidc/validate' && (req.method === 'POST' || req.method === 'PUT')) {
        const body = await readJsonBody(req)
        const result = validateOidcInput(body, auth.origins)
        json(res, 200, { data: { valid: result.errors.length === 0, errors: result.errors } })
        return
      }
      if (path === '/api/auth/oidc/config' && (req.method === 'POST' || req.method === 'PUT')) {
        try {
          const saved = await saveOidcConfig(
            options.configFile ?? `${cheryDir}/.chery/config.yaml`,
            await readJsonBody(req),
          )
          json(res, 200, { data: saved, restartRequired: true })
        } catch (error) {
          json(res, 400, {
            error: { code: 'invalid_oidc_config', message: (error as Error).message },
          })
        }
        return
      }
      // Machine paths cannot reach this branch: their whitelist excludes modules.
      if (path === '/api/modules' && req.method === 'GET') {
        json(res, 200, { data: await modules.modules() })
        return
      }
      if (path.startsWith('/modules/') && req.method === 'GET') {
        if (
          req.headers['sec-fetch-site'] === 'cross-site' ||
          (req.headers.origin !== undefined && req.headers.origin !== origin)
        ) {
          json(res, 403, { error: { code: 'origin_rejected', message: '请求来源未被允许' } })
          return
        }
        const resourcePath = (req.url ?? '').split('?')[0]!
        const match = /^\/modules\/([a-z][a-z0-9-]{0,63})(?:\/assets\/([^/]+)\/(.+))?$/.exec(
          resourcePath,
        )
        if (!match || (req.url?.includes('?') && (match[2] || new URL(req.url, 'http://localhost').search !== '?embedded=1')))
          throw new CapabilityError('invalid_params', 400, '资源路径无效')
        if (!match[2] && (!req.url?.endsWith('?embedded=1') || (req.headers['sec-fetch-dest'] !== undefined && req.headers['sec-fetch-dest'] !== 'iframe'))) {
          json(res, 403, { error: { code: 'embedded_only', message: '请通过 Manager 插件弹窗访问' } })
          return
        }
        const resource = await modules.resource(match[1]!, match[2], match[3])
        // Only authenticated plugin resources may be embedded by this Manager.
        res.setHeader('X-Frame-Options', 'SAMEORIGIN')
        res.setHeader('Content-Security-Policy', "frame-ancestors 'self'")
        res.writeHead(200, { 'Content-Type': resource.contentType })
        const bytes = !match[2]
          ? Buffer.from(resource.bytes.toString('utf8').replace('</head>', `<style data-manager-embedded>
body { padding: 0 !important; background: #d4d0c8 !important; }
main.manager { max-width: none; margin: 0; min-height: 0; border: 0; padding: 0; background: #d4d0c8; }
main.manager > header { display: none; }
</style></head>`))
          : resource.bytes
        res.end(bytes)
        return
      }
      if (
        path === '/api/plugins' ||
        path.startsWith('/api/plugins/') ||
        path.startsWith('/api/modules/')
      ) {
        const result = await (
          path.startsWith('/api/plugins')
            ? modules.plugins.bind(modules)
            : modules.business.bind(modules)
        )({
          method: req.method ?? 'GET',
          url: new URL(req.url ?? '/', origin),
          body: ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method ?? '')
            ? await readJsonBody(req)
            : undefined,
        })
        json(
          res,
          result?.status ?? 404,
          result?.body ?? {
            error: { code: 'not_found', message: '管理模块未启用或接口不存在' },
          },
        )
        return
      }
      if (path === '/api/status' && req.method === 'GET') {
        json(res, 200, {
          manager: 'running',
          backendMode: options.backendMode ?? 'child',
          processes: controller.state(),
          backend: await detectBackendStatus(options.backendStatusFile, options.configFile),
          relay: await readRelayStatus(options.relayStatusFile),
          system: readSystemMetrics(),
        })
        return
      }
      const match = /^\/api\/(backend|rathole)\/(start|stop|restart)$/.exec(path)
      if (match && (req.method === 'POST' || req.method === 'PUT')) {
        const name = match[1] as 'backend' | 'rathole'
        if (name === 'backend' && options.backendMode === 'external') {
          json(res, 409, {
            error: {
              code: 'backend_externally_managed',
              message: '后端由外部部署工具管理，请使用该工具启停',
            },
          })
          return
        }
        const action = match[2]
        const result =
          action === 'stop'
            ? await controller.stopExclusive(name)
            : action === 'restart'
              ? await controller.restartExclusive(
                  name,
                  name === 'backend' ? backendCommand : ratholeCommand,
                  name === 'backend' ? backendArgs : ratholeArgs,
                )
              : await controller.startExclusive(
                  name,
                  name === 'backend' ? backendCommand : ratholeCommand,
                  name === 'backend' ? backendArgs : ratholeArgs,
                )
        json(res, 200, result)
        return
      }
      if (path === '/api/connection' && req.method === 'GET') {
        json(res, 200, {
          processes: controller.state(),
          backend: controller.state().find((process) => process.name === 'backend') ?? {
            status: 'unknown',
          },
          backendListener: await readBackendStatus(options.backendStatusFile),
          tunnel: await readRelayStatus(options.relayStatusFile),
        })
        return
      }
      const credential = /^\/api\/connections\/([a-z][a-z0-9-]{0,63})\/credential(\/rotate)?$/.exec(path)
      if (credential) {
        const id = credential[1]!
        const file = connectionCredentials[id]
        if (!file || !(await modules.modules()).modules.some(item => item.descriptor.id === id))
          throw new CapabilityError('not_found', 404, '连接凭据未配置或模块未安装')
        const rotate = credential[2] !== undefined
        if ((!rotate && req.method !== 'GET') || (rotate && !['POST', 'PUT'].includes(req.method ?? '')))
          throw new CapabilityError('method_not_allowed', 405, '方法未被允许')
        const state = rotate ? rotateConnectionCredential(file) : loadOrCreateConnectionCredential(file)
        const readback = loadOrCreateConnectionCredential(file)
        if (readback.token !== state.token || readback.updatedAt !== state.updatedAt)
          throw new CapabilityError('save_unconfirmed', 502, '凭据结果未确认')
        json(res, 200, { token: readback.token, updatedAt: readback.updatedAt })
        return
      }
      if (path === '/api/credentials' && req.method === 'GET') {
        json(res, 200, await credentialStore.status())
        return
      }
      if (path === '/api/credentials/rotate' && (req.method === 'POST' || req.method === 'PUT')) {
        const body = await readJsonBody(req)
        const rotated = await credentialStore.rotate({
          username: typeof body.username === 'string' ? body.username : undefined,
          password: typeof body.password === 'string' ? body.password : undefined,
        })
        // 后端是管理器子进程 → 真正重启；否则（外部启动，如 dev / nodemon / systemd）不拉起
        // 会因端口占用而立刻崩溃的副本，交由后端自身的配置监听器自动重载新凭据（通常 1 秒内）。
        const managed = controller.isManaged('backend')
        const backendState = managed
          ? await controller.restart('backend', backendCommand, backendArgs)
          : { name: 'backend' as const, managed: false }
        const backend = { ...backendState, managed }
        // 用新凭据对后端做登录自检，确认已生效才提示成功，避免「以为生效了其实没有」。
        const network = await readBackendNetworkFromConfig(options.configFile)
        const verification = await verifyLogin(
          `http://127.0.0.1:${network.webPort}`,
          rotated.credentials.username,
          rotated.password,
        )
        json(res, 200, { credentials: rotated.credentials, backend, verification })
        return
      }
      if (path === '/api/relay/config' && (req.method === 'GET' || req.method === 'PUT')) {
        try {
          const result =
            req.method === 'GET'
              ? await relayConfig.view()
              : await relayConfig.save(await readJsonBody(req))
          if (req.method === 'PUT' && result.url && result.backendId && relayAdminToken) {
            await relayRequest(result, '/api/admin/backends/policy', { method: 'PUT', body: JSON.stringify({ backendId: result.backendId, publicDiscovery: result.publicDiscovery, remotePasswordEnabled: result.remotePasswordEnabled }) }, relayAdminToken)
          }
          json(res, 200, result)
        } catch (error) {
          json(res, 400, { error: (error as Error).message })
        }
        return
      }
      if (path === '/api/relay/status' && req.method === 'GET') {
        const config = await relayConfig.view()
        const health = config.url ? await relayRequest(config, '/healthz', { method: 'GET' }, relayAdminToken).catch(() => null) : null
        json(res, 200, {
          ...config,
          configured: Boolean(config.url && config.backendId),
          status: health ? 'online' : 'not_connected',
          connection: health ? 'online' : 'not_connected',
          binding: health ? 'available' : { status: 'unavailable', reason: 'relay_unreachable' },
          cooldown: { status: 'unavailable', reason: 'backend_cooldown_api_not_connected' },
        })
        return
      }
      if (path === '/api/relay/bindings' && req.method === 'GET') {
        const config = await relayConfig.view()
        if (!config.url || !config.backendId) {
          json(res, 200, { status: 'unavailable', reason: 'relay_not_configured', bindings: [] })
          return
        }
        const result = await relayRequest(config, `/api/admin/bindings?backendId=${encodeURIComponent(config.backendId)}`, { method: 'GET' }, relayAdminToken)
        json(res, result.status, await result.json())
        return
      }
      if (path === '/api/relay/bindings/request' && req.method === 'POST') {
        const config = await relayConfig.view()
        if (!config.url || !config.backendId) { json(res, 400, { error: 'relay_not_configured' }); return }
        const result = await relayRequest(config, '/api/admin/bindings/request', { method: 'POST', body: JSON.stringify({ backendId: config.backendId }) }, relayAdminToken)
        json(res, result.status, await result.json())
        return
      }
      if (path === '/api/relay/bindings/revoke' && req.method === 'POST') {
        const config = await relayConfig.view()
        if (!config.url || !config.backendId) { json(res, 400, { error: 'relay_not_configured' }); return }
        const result = await relayRequest(config, '/api/admin/bindings/revoke', { method: 'POST', body: JSON.stringify({ bindingId: (await readJsonBody(req)).bindingId }) }, relayAdminToken)
        json(res, result.status, await result.json())
        return
      }
      if (path === '/api/relay/password-cooldown' && req.method === 'GET') {
        json(res, 200, { status: 'unavailable', reason: 'backend_cooldown_api_not_connected' })
        return
      }
      if (path === '/api/relay/password-cooldown/reset' && req.method === 'POST') {
        json(res, 503, { error: 'backend_cooldown_api_not_connected', status: 'unavailable' })
        return
      }

      res.writeHead(404)
      res.end('Not Found')
    } catch (error) {
      if (error instanceof CapabilityError && !res.headersSent) {
        json(res, error.status, { error: { code: error.code, message: error.message } })
        return
      }
      if (!res.headersSent)
        json(
          res,
          error instanceof ProcessStartError
            ? 503
            : error instanceof SyntaxError ||
                ['invalid_json', 'body_too_large'].includes((error as Error).message)
              ? 400
              : 503,
          error instanceof ProcessStartError
            ? {
                error: {
                  code: 'process_start_failed',
                  message: `${error.processName === 'rathole' ? '中转隧道' : '后端'}启动失败：${error.message}`,
                },
              }
            : { error: 'request_failed' },
        )
      else res.end()
    }
  })
  server.requestTimeout = 10_000
  server.headersTimeout = 10_000
  return {
    controller,

    listen: () =>
      new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(options.port ?? 39980, options.host ?? '127.0.0.1', () => resolve())
      }),
    address: () => server.address() as AddressInfo | null,
    close: async () => {
      await modules.close()
      await controller.stopAll()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/** 回环地址判定：127.0.0.1 / ::1 / IPv4 映射回环。 */
export function isLoopbackAddress(remoteAddress: string | undefined): boolean {
  return (
    remoteAddress === '127.0.0.1' ||
    remoteAddress === '::1' ||
    remoteAddress === '::ffff:127.0.0.1' ||
    remoteAddress === '::ffff:127.0.0.1%0'
  )
}

/**
 * 读取本地管理器在 config.yaml 中的监听地址（manager.host）。
 * 防御性解析：文件缺失 / 格式非法 / 类型不符一律返回 undefined，由调用方兜底默认 127.0.0.1。
 * 优先级：CHERY_MANAGER_HOST 环境变量 > 本字段 > 默认。
 */
export async function readManagerHostFromConfig(configFile: string): Promise<string | undefined> {
  try {
    const parsed = yaml.load(await readFile(configFile, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    const manager = (parsed as Record<string, unknown>).manager
    if (typeof manager !== 'object' || manager === null || Array.isArray(manager)) return undefined
    const host = (manager as Record<string, unknown>).host
    return typeof host === 'string' && host ? host : undefined
  } catch {
    return undefined
  }
}

/** 监听地址是否仅限本机回环（缺省 / localhost / 回环 IP 视为仅本机，非回环即开放内网访问）。 */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return true
  const h = host.toLowerCase()
  return h === '127.0.0.1' || h === '::1' || h === '::ffff:127.0.0.1' || h === 'localhost'
}

function unauthorized(res: import('node:http').ServerResponse): void {
  res.writeHead(401, { 'Cache-Control': 'no-store' })
  res.end('Unauthorized')
}

async function relayRequest(config: { url: string }, path: string, init: RequestInit, adminToken: string): Promise<Response> {
  if (!adminToken) throw new Error('CHERY_RELAY_ADMIN_TOKEN is required for relay management')
  const response = await fetch(`${config.url.replace(/\/$/, '')}${path}`, {
    ...init,
    signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/json', 'X-Chery-Relay-Admin-Token': adminToken, ...(init.headers ?? {}) },
  })
  if (!response.ok) throw new Error('relay_management_unavailable')
  return response
}

async function readJsonBody(
  req: import('node:http').IncomingMessage,
): Promise<Record<string, unknown>> {
  return readBody(req)
}

async function readRelayStatus(file: string | undefined): Promise<unknown> {
  if (!file) return { status: 'unknown' }
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    return {
      status: typeof parsed.status === 'string' ? parsed.status : 'unknown',
      ...(typeof parsed.backendId === 'string' ? { backendId: parsed.backendId } : {}),
      ...(typeof parsed.error === 'string' ? { error: parsed.error } : {}),
      ...(typeof parsed.updatedAt === 'string' ? { updatedAt: parsed.updatedAt } : {}),
    }
  } catch {
    return { status: 'unknown' }
  }
}

/** 后端状态文件（CHERY_BACKEND_STATUS_FILE）的解析结果。 */
interface BackendStatusData {
  status: string
  addresses?: unknown
  agents?: unknown
  updatedAt?: string
}

async function readBackendStatus(file: string | undefined): Promise<BackendStatusData> {
  if (!file) return { status: 'unknown' }
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    return {
      status: typeof parsed.status === 'string' ? parsed.status : 'unknown',
      ...(parsed.addresses && typeof parsed.addresses === 'object'
        ? { addresses: parsed.addresses }
        : {}),
      ...(parsed.agents && typeof parsed.agents === 'object' ? { agents: parsed.agents } : {}),
      ...(typeof parsed.updatedAt === 'string' ? { updatedAt: parsed.updatedAt } : {}),
    }
  } catch {
    return { status: 'unknown' }
  }
}

/** Manager 所在主机的只读压力快照；load average 在 Windows 上通常不可用。 */
function readSystemMetrics(): {
  memoryUsedRatio: number
  load1: number | undefined
  uptimeSeconds: number
} {
  const total = totalmem()
  return {
    memoryUsedRatio: total > 0 ? (total - freemem()) / total : 0,
    load1: loadavg()[0] || undefined,
    uptimeSeconds: uptime(),
  }
}

/**
 * 读取 config.yaml 里后端的监听信息：server.port（WS）与 server.webPort（HTTP）。
 * 防御性解析：缺失 / 格式非法一律回退默认 8182 / 8183。
 */
export async function readBackendNetworkFromConfig(
  configFile: string | undefined,
): Promise<{ host: string; wsPort: number; webPort: number }> {
  if (!configFile) return { host: '127.0.0.1', wsPort: 8182, webPort: 8183 }
  try {
    const parsed = yaml.load(await readFile(configFile, 'utf8'))
    const server =
      typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>).server
        : undefined
    const s =
      typeof server === 'object' && server !== null && !Array.isArray(server)
        ? (server as Record<string, unknown>)
        : {}
    return {
      host: typeof s.host === 'string' && s.host ? s.host : '127.0.0.1',
      wsPort: typeof s.wsPort === 'number' ? s.wsPort : typeof s.port === 'number' ? s.port : 8182,
      webPort: typeof s.webPort === 'number' ? s.webPort : 8183,
    }
  } catch {
    return { host: '127.0.0.1', wsPort: 8182, webPort: 8183 }
  }
}

/** 探测 host:port 是否可连接（后端存活性检查）。 */
export function isPortOpen(host: string, port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('timeout', () => {
      socket.destroy()
      resolve(false)
    })
    socket.once('error', () => resolve(false))
  })
}

/**
 * 后端运行状态：状态文件优先（含 agents 统计），缺失时探测 config.yaml 的 server.port。
 * 地址回退到 config.yaml 的 server.webPort / server.port，供页面构造后端访问 URL。
 */
async function detectBackendStatus(
  statusFile: string | undefined,
  configFile: string | undefined,
): Promise<unknown> {
  const network = await readBackendNetworkFromConfig(configFile)
  const probeHost = network.host === '0.0.0.0' || network.host === '::' ? '127.0.0.1' : network.host
  const fileData = await readBackendStatus(statusFile)
  const listening = await isPortOpen(probeHost, network.wsPort)
  const fallbackAddresses = {
    local: { httpPort: network.webPort, websocketPort: network.wsPort },
  }
  if (listening || fileData.status === 'running') {
    return {
      status: 'running',
      addresses: fileData.addresses ?? fallbackAddresses,
      ...(fileData.agents ? { agents: fileData.agents } : {}),
      ...(typeof fileData.updatedAt === 'string' ? { updatedAt: fileData.updatedAt } : {}),
    }
  }
  return { status: 'stopped', addresses: fallbackAddresses }
}

function json(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(body))
}
