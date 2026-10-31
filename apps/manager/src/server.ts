import { createServer } from 'node:http'
import { connect, type AddressInfo } from 'node:net'
import { readFile } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import { freemem, loadavg, totalmem, uptime } from 'node:os'
import yaml from 'js-yaml'
import { ProcessController, ProcessStartError } from './processController.js'
import { BackendSupervisor, type BackendSupervisorOptions } from './backendSupervisor.js'
import { BackendPluginConfigStore } from './backendPluginConfig.js'
import { BackendIntentStore } from './backendIntent.js'
import { BackendControlConflict } from './backendControl.js'
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
import { BackendMaintenance } from './backendMaintenance.js'
import { RelayClientConfigStore } from './relayClientConfig.js'
import { relayReachable } from './boundedHttp.js'
import { readBackendStatus, readRelayStatus } from './runtimeStatus.js'
import { writeManagerPage as writeRetroManagerPage } from './page.js'

import { createManagerCoreRpc } from './modules/capabilities/rpc.js'
import { DynamicModules, offlinePluginList } from './modules/dynamic.js'
import { CapabilityError } from './modules/capabilities/errors.js'
import {
  disableInitialSetup,
  readInitialSetup,
  readOidcConfig,
  saveOidcConfig,
  validateOidcInput,
} from './authConfig.js'
import { BusinessLoginConfigStore } from './businessLoginConfig.js'

export interface ManagerOptions {
  backendMode?: 'child' | 'external'
  host?: string
  port?: number
  cheryDir?: string
  backendCommand?: string
  backendArgs?: string[]
  /** 后端监管器覆盖项（重试退避、稳定清零时长、就绪探测等），主要供测试与部署微调。 */
  backendSupervisor?: Partial<BackendSupervisorOptions>
  ingressRegistryFile?: string
  controlToken?: string
  tokenFile?: string
  relayStatusFile?: string
  relayClientConfigFile?: string
  backendStatusFile?: string
  backendIntentFile?: string
  configFile?: string
  credentialsFile?: string
  connectionCredentials?: Record<string, string>
  authFile?: string
  auth?: AuthOptions
  now?: () => number

  plugins?: { packageSourceRoot?: string }
}

export function createManager(options: ManagerOptions = {}) {
  if (options.backendMode !== undefined && !['child', 'external'].includes(options.backendMode))
    throw new Error('backendMode 无效')
  const controller = new ProcessController()
  const cheryDir = options.cheryDir ?? process.env.CHERY_DIR ?? process.cwd()
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
  const credentialStore = new CredentialStore({
    configFile,
    credentialsFile: options.credentialsFile ?? `${cheryDir}/.chery/manager-credentials.json`,
  })
  const relayConfig = new RelayConfigStore(configFile)
  const relayClientConfig = new RelayClientConfigStore(options.relayClientConfigFile ?? process.env.CHERY_RELAY_CLIENT_CONFIG_FILE)
  const now = options.now ?? Date.now
  const maintenance = new BackendMaintenance({
    now,
    credentials: () => credentialStore.auth(),
    target: async () => {
      const network = await readBackendNetworkFromConfig(configFile)
      const host = network.host === '0.0.0.0' || network.host === '::' ? '127.0.0.1' : network.host
      if (/[\/@?#]/.test(host) || !Number.isInteger(network.webPort) || network.webPort < 1 || network.webPort > 65535)
        throw new CapabilityError('unavailable', 503, '后端维护地址无效')
      return `http://${host.includes(':') ? `[${host}]` : host}:${network.webPort}`
    },
  })
  const relayStatus = async () => {
    const desired = await relayClientConfig.view().catch(() => ({}))
    const file = options.relayStatusFile ?? ('statusFile' in desired && typeof desired.statusFile === 'string' ? desired.statusFile : undefined)
    return readRelayStatus(file, desired, now())
  }

  const resolveBackendListener = async (): Promise<{ host: string; port: number }> => {
    const network = await readBackendNetworkFromConfig(configFile)
    return {
      host: network.host === '0.0.0.0' || network.host === '::' ? '127.0.0.1' : network.host,
      port: network.wsPort,
    }
  }
  // Manager 是后端子进程的唯一所有者：启动、有限重试与稳定清零都在此监管器内完成。
  const backendIntent = new BackendIntentStore(options.backendIntentFile ?? `${cheryDir}/.chery/manager-backend-intent.json`)
  const supervisor = new BackendSupervisor({
    command: backendCommand,
    args: backendArgs,
    ...options.backendSupervisor,
    intent: backendIntent,
    resolveListener: options.backendSupervisor?.resolveListener ?? resolveBackendListener,
    isReady:
      options.backendSupervisor?.isReady ??
      ((listener) => (listener ? isPortOpen(listener.host, listener.port) : Promise.resolve(false))),
    isPortOpen: options.backendSupervisor?.isPortOpen ?? ((listener) => isPortOpen(listener.host, listener.port)),
  })
  const backendPluginConfig = new BackendPluginConfigStore(configFile)
  const businessLoginConfig = new BusinessLoginConfigStore(configFile)
  const ingressRegistryFile =
    options.ingressRegistryFile ?? `${cheryDir}/.chery/ingress/registry.json`
  let pluginDisable: { operationId: string | null; status: 'waiting' | 'saved' | 'failed'; error?: string } | null = null
  const readBackendPluginStatus = async (withLogs: boolean) => ({
    ...(await (async () => {
      const snapshot = await supervisor.snapshot({ logs: withLogs })
      if (options.backendMode !== 'external') return snapshot
      const listener = await resolveBackendListener()
      const ready = await isPortOpen(listener.host, listener.port)
      return { ...snapshot, state: ready ? 'running' : 'inactive', running: ready,
        pid: null, uptimeSeconds: null, stableSince: null, lastError: null,
        retryCount: 0, nextRetryAt: null, nextRetryInMs: null, logs: [],
        listener: { ...listener, ready },
        resources: { system: snapshot.resources.system, process: {pid:null,uptimeSeconds:null,cpuPercent:null,memoryBytes:null} },
      }
    })()),
    autoStart: (await backendPluginConfig.view()).autoStart,
    managedBy: options.backendMode === 'external' ? 'external' : 'manager',
    intent: await supervisor.control.readIntent(),
    pluginDisable,
  })
  /** 按持久化开关决定是否在 Manager 启动时拉起 Backend；端口已被占用时视为外部运行，不重复拉起。 */
  const autoStartBackend = async (): Promise<{
    started: boolean
    reason?: string
    error?: string
  }> => {
    if (options.backendMode === 'external') return { started: false, reason: 'external_mode' }
    const { autoStart } = await backendPluginConfig.view()
    if (!autoStart) return { started: false, reason: 'auto_start_disabled' }
    try {
      const intent = await supervisor.control.readIntent()
      if (!intent.pluginEnabled) return { started: false, reason: 'plugin_disabled' }
      if (intent.desiredState === 'stopped') return { started: false, reason: 'stop_intent_saved' }
    } catch (error) {
      return { started: false, reason: 'intent_unreadable', error: (error as Error).message }
    }
    const listener = await resolveBackendListener()
    if (await isPortOpen(listener.host, listener.port)) return { started: false, reason: 'listener_already_open' }
    try {
      await supervisor.start()
    } catch (error) {
      return { started: false, reason: 'start_failed', error: (error as Error).message }
    }
    return { started: true }
  }

  const modules = new DynamicModules(
    createManagerCoreRpc(configFile, credentialStore),
    options.plugins?.packageSourceRoot,
  )
  // supervisor 拉起的受管 Backend 纳入 controller 统一视图（isManaged/stop/stopAll），单层管理。
  controller.adopt('backend', supervisor.bridge())
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
            !/^\/api\/machine\/(status|connection|(?:backend|rathole)\/(?:start|stop|restart)|backend\/stop\/(?:cancel|force))$/.test(
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
      // Backend 离线时仍展示本地已安装的平级插件，避免插件页整体报错。
      if (path === '/api/plugins' && req.method === 'GET') {
        try {
          const result = await modules.plugins({
            method: 'GET',
            url: new URL(req.url ?? '/', origin),
          })
          json(res, result?.status ?? 200, result?.body ?? { data: {} })
        } catch (error) {
          // 只有后端不可用（无响应或 5xx）才退回本地只读列表；参数/协议错误照旧返回。
          if (error instanceof CapabilityError && error.status < 500) throw error
          const offline = await offlinePluginList(ingressRegistryFile).catch(() => undefined)
          if (!offline) throw error
          json(res, 200, { data: offline })
        }
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
          backendPlugin: await readBackendPluginStatus(false),
          backend: await detectBackendStatus(options.backendStatusFile, configFile, now(), supervisor.control.snapshot()?.backendInstanceId),
          relay: await relayStatus(),
          maintenance: maintenance.snapshot(),
          system: readSystemMetrics(),
        })
        return
      }
      if (path === '/api/backend-plugin/status' && req.method === 'GET') {
        json(res, 200, { data: await readBackendPluginStatus(true) })
        return
      }
      if (path === '/api/backend-plugin/start' && req.method === 'POST') {
        if (options.backendMode === 'external') {
          json(res, 409, {
            error: {
              code: 'backend_externally_managed',
              message: '后端由外部部署工具管理，请使用该工具启停',
            },
          })
          return
        }
        await supervisor.start()
        json(res, 200, { data: await readBackendPluginStatus(true) })
        return
      }
      if (path === '/api/backend-plugin/enabled' && req.method === 'PUT') {
        if (options.backendMode === 'external') throw new BackendControlConflict('后端由外部工具管理，不能在此停用')
        const { enabled } = await readJsonBody(req)
        if (typeof enabled !== 'boolean') throw new SyntaxError('enabled 必须为布尔值')
        if (enabled) {
          await supervisor.control.setPluginEnabled(true)
          pluginDisable = null
        } else {
          await supervisor.stop()
          const operationId = supervisor.control.snapshot()?.operationId ?? null
          pluginDisable = { operationId, status: 'waiting' }
          // No HTTP handler or state-transition lock waits for current Agent work.
          void supervisor.control.waitForExit().then(async () => {
            const state = supervisor.control.snapshot()
            if (state && (state.operationId !== operationId || state.phase !== 'stopped')) return
            if ((await supervisor.control.readIntent()).desiredState !== 'stopped') return
            await supervisor.control.setPluginEnabled(false)
            if (pluginDisable?.operationId === operationId) pluginDisable = { operationId, status: 'saved' }
          }).catch((error: unknown) => {
            if (pluginDisable?.operationId === operationId) pluginDisable = { operationId, status: 'failed', error: (error as Error).message }
          })
        }
        json(res, 200, { data: await readBackendPluginStatus(false) })
        return
      }
      if (/^\/api\/backend\/stop\/(cancel|force)$/.test(path) && req.method === 'POST') {
        if (options.backendMode === 'external') throw new BackendControlConflict('后端由外部工具管理，请使用该工具启停')
        const body = await readJsonBody(req)
        if (typeof body.backendInstanceId !== 'string' || typeof body.operationId !== 'string')
          throw new SyntaxError('请提供当前实例与关闭操作标识')
        if (path.endsWith('/cancel')) {
          await supervisor.control.cancel(body.backendInstanceId, body.operationId)
          pluginDisable = null
        } else await supervisor.control.force(body.backendInstanceId, body.operationId)
        json(res, 200, { data: await readBackendPluginStatus(false) })
        return
      }
      if (path === '/api/backend-plugin/cancel-retry' && req.method === 'POST') {
        // 只有在自动重试等待期才允许取消；运行中的后端不存在该阶段。
        if (!supervisor.cancelRetry()) {
          json(res, 409, {
            error: { code: 'not_retrying', message: '当前不在自动重试等待期，无需取消' },
          })
          return
        }
        json(res, 200, { data: await readBackendPluginStatus(true) })
        return
      }
      if (path === '/api/backend-plugin/config' && req.method === 'PUT') {
        try {
          json(res, 200, { data: await backendPluginConfig.save(await readJsonBody(req)) })
        } catch (error) {
          json(res, 400, {
            error: {
              code: 'invalid_backend_plugin_config',
              message: (error as Error).message,
            },
          })
        }
        return
      }
      if (path === '/api/business-login/config' && (req.method === 'GET' || req.method === 'PUT')) {
        try {
          const result =
            req.method === 'GET'
              ? await businessLoginConfig.view()
              : await businessLoginConfig.save(await readJsonBody(req))
          json(res, 200, result)
        } catch (error) {
          json(res, 400, {
            error: {
              code: 'invalid_business_login_config',
              message: (error as Error).message,
            },
          })
        }
        return
      }
      const match = /^\/api\/(backend|rathole)\/(start|stop|restart)$/.exec(path)
      if (match && (req.method === 'POST' || req.method === 'PUT')) {
        const name = match[1] as 'backend' | 'rathole'
        if (name === 'rathole') {
          json(res, 409, { error: { code: 'rathole_owned_by_backend', message: '隧道由 Backend 设备客户端管理，Manager 不单独启停' } })
          return
        }
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
        if (name === 'backend') {
          // Browser and machine requests share the same process owner and stop semantics.
          if (action === 'stop') await supervisor.stop()
          else if (action === 'restart') await supervisor.restart()
          else await supervisor.start()
          const snapshot = await supervisor.snapshot({ logs: false })
          json(res, 200, {
            name: 'backend',
            state: snapshot.state,
            running: snapshot.running,
            pid: snapshot.pid ?? undefined,
            managed: snapshot.running,
            lifecycle: snapshot.lifecycle,
          })
          return
        }
      }
      if (path === '/api/connection' && req.method === 'GET') {
        const backendSnapshot = await supervisor.snapshot({ logs: false })
        json(res, 200, {
          processes: [
            ...controller.state(),
            {
              name: 'backend',
              state: backendSnapshot.state,
              running: backendSnapshot.running,
              pid: backendSnapshot.pid ?? undefined,
            },
          ],
          backend: {
            name: 'backend',
            state: backendSnapshot.state,
            running: backendSnapshot.running,
            managed: backendSnapshot.running,
            pid: backendSnapshot.pid,
          },
          backendListener: await detectBackendStatus(options.backendStatusFile, configFile, now(), supervisor.control.snapshot()?.backendInstanceId),
          tunnel: await relayStatus(),
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
        json(res, 409, { error: { code: 'machine_credentials_deployment_required', message: '机器凭据须由部署者显式配置，不能通过浏览器轮换' } })
        return
      }
      if (path === '/api/relay/client-config' && (req.method === 'GET' || req.method === 'PUT')) {
        try {
          json(res, 200, req.method === 'GET' ? await relayClientConfig.view() : await relayClientConfig.save(await readJsonBody(req)))
        } catch {
          json(res, 400, { error: { code: 'invalid_relay_client_config', message: '设备配置无法读取或保存，请检查字段与部署文件位置' } })
        }
        return
      }
      if (path === '/api/relay/device-operation' && req.method === 'POST') {
        json(res, 200, await maintenance.call(false, await readJsonBody(req)))
        return
      }
      if (path === '/api/relay/config' && (req.method === 'GET' || req.method === 'PUT')) {
        try {
          const result =
            req.method === 'GET'
              ? await relayConfig.view()
              : await relayConfig.save(await readJsonBody(req))
          json(res, 200, result)
        } catch (error) {
          json(res, 400, { error: (error as Error).message })
        }
        return
      }
      if (path === '/api/relay/status' && req.method === 'GET') {
        const config = await relayConfig.view()
        const health = config.url ? await relayReachable(config.url) : false
        json(res, 200, {
          ...config,
          configured: Boolean(config.url && config.backendId),
          status: health ? 'reachable-not-verified' : 'not_connected',
          connection: health ? 'reachable-not-verified' : 'not_connected',
          binding: { status: 'unavailable', reason: 'device_maintenance_not_checked' },
          cooldown: { status: 'unavailable', reason: 'backend_cooldown_api_not_connected' },
        })
        return
      }
      if (path === '/api/relay/bindings' || path === '/api/relay/bindings/revoke') {
        json(res, 410, { error: 'relay_global_management_retired' })
        return
      }
      if (path === '/api/relay/bindings/request' && req.method === 'POST') {
        await readJsonBody(req)
        json(res, 201, await maintenance.call(true))
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
      if (error instanceof BackendControlConflict && !res.headersSent) {
        json(res, 409, { error: { code: error.code, message: error.message } })
        return
      }
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
    supervisor,
    backendPluginConfig,
    backendIntent,

    /** 按 `manager.backendPlugin.autoStart` 决定是否在启动时拉起 Backend。 */
    autoStartBackend,
    startBackend: () => supervisor.start(),

    listen: () =>
      new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(options.port ?? 39980, options.host ?? '127.0.0.1', () => resolve())
      }),
    address: () => server.address() as AddressInfo | null,
    close: async () => {
      maintenance.close()
      await modules.close()
      await supervisor.shutdown()
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

async function readJsonBody(
  req: import('node:http').IncomingMessage,
): Promise<Record<string, unknown>> {
  return readBody(req)
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
 * Current statistics require both a valid observation and matching open listener.
 * Missing evidence or a closed port cannot establish an external process exit.
 */
async function detectBackendStatus(
  statusFile: string | undefined,
  configFile: string | undefined,
  now: number,
  expectedInstanceId?: string,
): Promise<unknown> {
  const network = await readBackendNetworkFromConfig(configFile)
  const probeHost = network.host === '0.0.0.0' || network.host === '::' ? '127.0.0.1' : network.host
  const fileData = await readBackendStatus(statusFile, now, expectedInstanceId)
  const listening = await isPortOpen(probeHost, network.wsPort)
  const fallbackAddresses = {
    local: { httpPort: network.webPort, websocketPort: network.wsPort },
  }
  if (listening && fileData.status === 'running' &&
      fileData.addresses.local.httpPort === network.webPort && fileData.addresses.local.websocketPort === network.wsPort)
    return fileData
  return { status: listening ? 'reachable-not-verified' : 'unknown', addresses: fallbackAddresses,
    reason: fileData.status === 'unknown' ? fileData.reason : 'listener_not_verified' }
}

function json(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(body))
}
