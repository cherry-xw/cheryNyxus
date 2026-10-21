import { PublicAuthCapabilitiesSchema, BrowserSessionSchema, WsTicketSchema, type BrowserSession } from '@chery/protocol'

export class BrowserSessionApi {
  private csrf = ''
  constructor(private readonly base: string) {}
  async discover(): Promise<{ password: boolean; oidc: boolean; service: 'backend' | 'relay'; csrfToken: string; trustedLocal?: boolean }> {
    const value = PublicAuthCapabilitiesSchema.parse(await this.request('/api/auth/capabilities'))
    this.csrf = value.csrfToken; return value
  }
  async local(): Promise<BrowserSession> { const value = BrowserSessionSchema.parse(await this.request('/api/browser-session/local', 'POST', {})); this.csrf = value.csrfToken; return value }
  async read(): Promise<BrowserSession> { const value = BrowserSessionSchema.parse(await this.request('/api/browser-session')); this.csrf = value.csrfToken; return value }
  async password(username: string, password: string, backendId?: string, expectedRevision?: number): Promise<BrowserSession> {
    const value = BrowserSessionSchema.parse(await this.request('/api/browser-session/password', 'POST', { username, password, backendId, expectedRevision, operationId: operationId() })); this.csrf = value.csrfToken; return value
  }
  async target(backendId: string, expectedRevision: number): Promise<BrowserSession> { return BrowserSessionSchema.parse(await this.request('/api/browser-session/target', 'PUT', { backendId, expectedRevision, operationId: operationId() })) }
  async refresh(expectedRevision: number): Promise<BrowserSession> { const value = BrowserSessionSchema.parse(await this.request('/api/browser-session/refresh', 'POST', { expectedRevision, operationId: operationId() })); this.csrf = value.csrfToken; return value }
  async logout(expectedRevision: number): Promise<void> { await this.request('/api/browser-session', 'DELETE', { expectedRevision, operationId: operationId() }) }
  async list(): Promise<Array<{ backendId: string; displayName: string; status: string }>> { const value = await this.request('/api/backends') as { backends?: Array<{ backendId: string; displayName: string; status: string }> }; if (!Array.isArray(value.backends)) throw new Error('设备列表格式不兼容'); return value.backends }
  async ticket(expectedRevision: number): Promise<{ ticket: string; wsPath: string }> { return WsTicketSchema.parse(await this.request('/api/browser-session/ws-ticket', 'POST', { expectedRevision })) }
  private async request(path: string, method = 'GET', body?: unknown): Promise<unknown> {
    const url = new URL(`${this.base.replace(/\/$/, '')}${path}`, window.location.href)
    if (url.origin !== window.location.origin) throw new Error('请先打开目标服务的同源工作台地址')
    const privateHost = /^(?:localhost|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|\[::1\])$/.test(url.hostname)
    if (body && url.protocol !== 'https:' && !privateHost) throw new Error('公网密码与会话操作必须使用HTTPS')
    const response = await fetch(url, { method, credentials: 'include', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(8000), headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrf }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    if (response.status === 204) return undefined
    const value = await response.json() as { error?: { code?: string } }
    if (!response.ok) throw Object.assign(new Error(value.error?.code ?? `HTTP_${response.status}`), { status: response.status })
    return value
  }
}
function operationId(): string { const bytes = new Uint8Array(24); crypto.getRandomValues(bytes); return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('') }
