import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { readBackendNetworkFromConfig } from '../../server.js'
import type { CredentialStore } from '../../credentials.js'
import type { CoreMethod, CoreRpc } from '../contracts.js'
import { CapabilityError, record, unavailable } from './errors.js'

const METHODS: ReadonlySet<string> = new Set([
  'ingress.list', 'ingress.install', 'ingress.upgrade', 'ingress.enable',
  'ingress.disable', 'ingress.uninstall', 'ingress.config.get', 'ingress.config.save',
  'ingress.ui.list', 'ingress.ui.read', 'ingress.management.call',
  'search.test',
  'search.settings.get',
  'search.settings.save',
  'memory.qq.stats',
  'prompts.preset.get',
  'prompts.preset.save',
  'config.preview',
  'config.get',
  'config.save',
  'config.apply.status',
  'brain.list',
  'sense.list',
  'sense.tools',
  'utils.models',
  'utils.modelRecommendation',
  'qq.config.get',
  'qq.config.save',
  'qq.status.get',
  'qq.queue.get',
  'qq.history.get',
])
export interface BackendRpcOptions {
  /** Trusted server configuration, never supplied by an HTTP business request. */
  target(): Promise<{ http: string; ws: string }>
  credentials(): Promise<{ username: string; password?: string; consistent?: boolean }>
  timeoutMs?: number
}
/** Fresh authenticated connections avoid stale tokens after credential rotation.
 * Calls never retry a write: an ambiguous timeout must be resolved by a new read. */
export class BackendRpcClient implements CoreRpc {
  private closed = false
  private readonly sockets = new Set<WebSocket>()
  private readonly aborts = new Set<AbortController>()
  constructor(private readonly options: BackendRpcOptions) {}
  async call(method: CoreMethod, params: unknown = {}): Promise<unknown> {
    if (!METHODS.has(method))
      throw new CapabilityError('method_not_allowed', 400, '不允许调用此后端方法')
    if (this.closed) throw unavailable()
    const abort = new AbortController()
    this.aborts.add(abort)
    const timer = setTimeout(() => abort.abort(), this.options.timeoutMs ?? 8000)
    try {
      const target = await this.options.target()
      const http = new URL(target.http)
      const ws = new URL(target.ws)
      if (
        !['http:', 'https:'].includes(http.protocol) ||
        !['ws:', 'wss:'].includes(ws.protocol) ||
        http.username ||
        http.password ||
        ws.username ||
        ws.password ||
        http.search ||
        ws.search ||
        http.hash ||
        ws.hash ||
        http.pathname !== '/' ||
        ws.pathname !== '/' ||
        http.hostname !== ws.hostname ||
        (http.protocol === 'https:') !== (ws.protocol === 'wss:')
      )
        throw unavailable()
      const credentials = await this.options.credentials().catch(() => {
        throw new CapabilityError('backend_auth_failed', 502, '后端机器凭据无法读取；Manager 本地功能仍可使用')
      })
      if (!credentials.username || !credentials.password)
        throw new CapabilityError('backend_auth_failed', 502, '后端管理凭据未配置或已失效')
      if (credentials.consistent === false)
        throw new CapabilityError('backend_auth_failed', 502, '后端管理凭据未配置或已失效')
      const login = await this.post(
        http.origin,
        '/api/machine/login',
        { username: credentials.username, password: credentials.password },
        abort.signal,
      )
      if (
        !record(login) ||
        typeof login.accessToken !== 'string' ||
        !login.accessToken ||
        login.accessToken.length > 8192
      )
        throw unavailable()
      if (this.closed || abort.signal.aborted) throw unavailable()
      return await this.request(
        ws.href,
        login.accessToken,
        method,
        params,
        abort.signal,
      )
    } catch (error) {
      if (error instanceof CapabilityError) throw error
      throw unavailable()
    } finally {
      clearTimeout(timer)
      this.aborts.delete(abort)
    }
  }
  private async post(
    base: string,
    path: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
    if ([401, 403, 429].includes(response.status))
      throw new CapabilityError('backend_auth_failed', 502, '后端认证失败，请检查服务端凭据')
    if ([404, 405].includes(response.status))
      throw new CapabilityError('backend_version_unsupported', 503, 'Backend 版本不支持所需机器维护接口；Manager 本地功能仍可使用')
    if (!response.ok) throw unavailable()
    const chunks: Uint8Array[] = []
    let size = 0
    if (!response.body) throw unavailable()
    for await (const chunk of response.body) {
      size += chunk.byteLength
      if (size > 65536) {
        await response.body.cancel().catch(() => {})
        throw unavailable()
      }
      chunks.push(chunk)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }
  private request(
    url: string,
    token: string,
    method: CoreMethod,
    params: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: { Authorization: `Bearer ${token}` },
        followRedirects: false,
        maxPayload: 4 * 1024 * 1024,
        handshakeTimeout: this.options.timeoutMs ?? 8000,
      })
      this.sockets.add(ws)
      const id = randomUUID()
      let done = false
      const finish = (error?: CapabilityError, data?: unknown) => {
        if (done) return
        done = true
        signal.removeEventListener('abort', onAbort)
        this.sockets.delete(ws)
        if (ws.readyState === WebSocket.OPEN) ws.close()
        else if (ws.readyState !== WebSocket.CLOSED) ws.terminate()
        if (error) reject(error)
        else resolve(data)
      }
      const onAbort = () => finish(unavailable())
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
      ws.on('open', () => {
        if (!done) ws.send(JSON.stringify({ id, kind: 'request', method, params }))
      })
      ws.on('message', (raw, binary) => {
        // Core broadcasts config.apply.changed as a binary JSON frame (0x02).
        // This client consumes only request responses, not notifications/chunks.
        if (binary) return
        try {
          const data = JSON.parse(raw.toString()) as unknown
          if (!record(data) || data.kind !== 'response' || data.requestId !== id) return
          if (typeof data.success !== 'boolean') return finish(unavailable())
          if (data.success) return finish(undefined, data.data)
          const message =
            record(data.error) && typeof data.error.message === 'string' ? data.error.message : ''
          const code = record(data.error) ? data.error.code : ''
          if (method.startsWith('ingress.') && typeof code === 'string' && !['UNAUTHORIZED', 'FORBIDDEN'].includes(code)) {
            const status = ['API_VERSION_MISMATCH', 'REVISION_CONFLICT', 'REQUEST_ID_CONFLICT'].includes(code) ? 409
              : code === 'INVALID_PARAMS' ? 400 : code === 'CAPABILITY_DENIED' ? 502 : 503
            return finish(new CapabilityError(code === 'CAPABILITY_DENIED' ? 'backend_auth_failed' : code.toLowerCase(), status, '插件操作未完成，请核对版本、授权与后端状态'))
          }
          if (code === 'CONFLICT' || message.includes('baseRevision 已过期'))
            return finish(
              new CapabilityError('revision_conflict', 409, '配置已被修改，请重新读取后保存'),
            )
          if (code === 'INVALID_PARAMS')
            return finish(
              new CapabilityError(
                'validation_failed',
                400,
                '核心配置校验未通过，请检查资源字段与引用',
              ),
            )
          if (code === 'METHOD_NOT_FOUND')
            return finish(new CapabilityError('unavailable', 503, '后端版本不支持所需管理接口'))
          if (code === 'UNAUTHORIZED' || code === 'FORBIDDEN')
            return finish(new CapabilityError('backend_auth_failed', 502, '后端拒绝管理权限'))
          finish(unavailable())
        } catch {
          finish(unavailable())
        }
      })
      ws.on('unexpected-response', (_request, response) => {
        response.resume()
        finish(
          [401, 403].includes(response.statusCode ?? 0)
            ? new CapabilityError('backend_auth_failed', 502, '后端拒绝认证连接')
            : unavailable(),
        )
      })
      ws.on('error', () => finish(unavailable()))
      ws.on('close', () => finish(unavailable()))
    })
  }
  close(): void {
    this.closed = true
    for (const abort of this.aborts) abort.abort()
    for (const socket of this.sockets) socket.terminate()
    this.sockets.clear()
  }
}
/** Reuses the existing Manager network and credential sources. No business file reads. */
export function createManagerCoreRpc(
  configFile: string,
  credentials: Pick<CredentialStore, 'auth'>,
): BackendRpcClient {
  return new BackendRpcClient({
    target: async () => {
      const network = await readBackendNetworkFromConfig(configFile)
      const host = network.host === '0.0.0.0' || network.host === '::' ? '127.0.0.1' : network.host
      if (
        !Number.isInteger(network.webPort) ||
        !Number.isInteger(network.wsPort) ||
        network.webPort < 1 ||
        network.wsPort < 1 ||
        network.webPort > 65535 ||
        network.wsPort > 65535 ||
        /[\/@?#]/.test(host)
      )
        throw unavailable()
      const address = host.includes(':') ? `[${host}]` : host
      return {
        http: `http://${address}:${network.webPort}`,
        ws: `ws://${address}:${network.wsPort}`,
      }
    },
    credentials: () => credentials.auth(),
  })
}
