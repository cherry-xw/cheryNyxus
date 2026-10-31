import { MachineMaintenanceSchema, MachineRelayOperationSchema } from '@chery/protocol'
import { CapabilityError, record, unavailable } from './modules/capabilities/errors.js'
import { readResponse } from './boundedHttp.js'

interface Options {
  target(): Promise<string>
  credentials(): Promise<{ username: string; password?: string; consistent?: boolean }>
  now?: () => number
  timeoutMs?: number
}
type MaintenanceStatus = { status: 'not_checked' | 'ready' | 'backend_auth_failed' | 'backend_version_unsupported' | 'unavailable'; checkedAt?: string; instanceId?: string }
const authFailed = () => new CapabilityError('backend_auth_failed', 502, '后端机器凭据或权限不可用；Manager 本地功能仍可使用')
const unsupported = () => new CapabilityError('backend_version_unsupported', 503, 'Backend 不支持所需维护接口；Manager 本地功能仍可使用')

/** Fixed, authenticated device operations only. A submitted operation is never retried. */
export class BackendMaintenance {
  private state: MaintenanceStatus = { status: 'not_checked' }
  private readonly aborts = new Set<AbortController>()
  private closed = false
  constructor(private readonly options: Options) {}
  snapshot(): MaintenanceStatus { return { ...this.state } }

  async call(binding: boolean, input?: unknown): Promise<unknown> {
    const parsed = binding ? undefined : MachineRelayOperationSchema.safeParse(input)
    if (parsed && !parsed.success) throw new CapabilityError('invalid_params', 400, '设备操作参数无效')
    const operation = parsed?.success ? parsed.data : undefined
    if (this.closed) throw unavailable()
    const abort = new AbortController()
    this.aborts.add(abort)
    const timer = setTimeout(() => abort.abort(), this.options.timeoutMs ?? 15_000)
    const checkedAt = () => new Date((this.options.now ?? Date.now)()).toISOString()
    let submitted = false
    const write = binding || ['binding.cancel', 'authorization.revoke', 'policy.set'].includes(operation?.type ?? '')
    try {
      const credentials = await this.options.credentials().catch(() => { throw authFailed() })
      if (!credentials.username || !credentials.password || credentials.consistent === false) throw authFailed()
      const target = new URL(await this.options.target())
      if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.pathname !== '/' || target.search || target.hash) throw unavailable()
      const request = async (path: string, body?: unknown, token?: string) => {
        const response = await fetch(new URL(path, target), {
          method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: abort.signal,
          headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
        try {
          if ([401, 403, 429].includes(response.status)) throw authFailed()
          if ([404, 405].includes(response.status)) throw unsupported()
          if (!response.ok) throw unavailable()
          const text = await readResponse(response)
          try { return JSON.parse(text) as unknown }
          catch { if (path === '/api/machine/capabilities' || path === '/api/machine/login') throw unsupported(); throw unavailable() }
        } finally { await response.body?.cancel().catch(() => {}) }
      }
      const login = await request('/api/machine/login', { username: credentials.username, password: credentials.password })
      if (!record(login) || typeof login.accessToken !== 'string' || !login.accessToken || login.accessToken.length > 8192) throw unsupported()
      const discovery = MachineMaintenanceSchema.safeParse(await request('/api/machine/capabilities', undefined, login.accessToken))
      if (!discovery.success || !discovery.data.operations.includes(binding ? 'relay.binding' : 'relay.operation')) throw unsupported()
      if (abort.signal.aborted || this.closed) throw unavailable()
      submitted = true
      const result = await request(binding ? '/api/machine/relay/binding' : '/api/machine/relay/operation', binding ? {} : operation, login.accessToken)
      this.state = { status: 'ready', checkedAt: checkedAt(), instanceId: discovery.data.instanceId }
      return result
    } catch (error) {
      const failure = error instanceof CapabilityError ? error : unavailable()
      this.state = { status: failure.code === 'backend_auth_failed' ? 'backend_auth_failed' : failure.code === 'backend_version_unsupported' ? 'backend_version_unsupported' : 'unavailable', checkedAt: checkedAt() }
      if (write && submitted && !['backend_auth_failed', 'backend_version_unsupported'].includes(failure.code))
        throw new CapabilityError('save_unconfirmed', 502, '设备操作结果未知，请先读回核对，不要直接重复操作')
      throw failure
    } finally {
      clearTimeout(timer)
      this.aborts.delete(abort)
    }
  }
  close(): void {
    this.closed = true
    for (const abort of this.aborts) abort.abort()
  }
}
