let sessionExpired: (() => void) | undefined
export function onManagerSessionExpired(callback: () => void): void { sessionExpired = callback }

const messages: Record<string, string> = {
  invalid_password_change: '新密码须为 12–1024 字符。',
  current_password_invalid: '当前密码不正确。',
  account_changed: '账号已发生变化，请重新登录。',
  unauthorized: 'Manager 登录已失效，请重新登录。',
  invalid_login: '用户名或密码不正确。', login_limited: '登录尝试过多，请稍后再试。',
  setup_unavailable: '首次创建入口已关闭，请重新读取状态。', setup_limited: '创建尝试过多，请稍后再试。',
  invalid_setup: '用户名或密码不符合要求。',
  host_rejected: '访问地址未被允许，请检查 Manager 可信访问地址。',
  origin_rejected: '请求来源未被允许，请检查 Manager 可信访问地址。',
  backend_auth_failed: '内部管理连接认证失败，请检查部署状态或联系管理员修复；无需再次登录或填写后端凭据。',
  unavailable: '后端管理接口不可用，请检查后端运行状态、连接地址和接口版本。',
  request_failed: 'Manager 处理请求失败，请检查服务日志；提交过的修改须先回读核对。',
  backend_externally_managed: '后端由 Docker 或其他部署工具管理，不能在此启停。',
  revision_conflict: '配置已被其他操作修改。草稿已保留，请重新读取后再保存。',
  already_exists: '同名资源已存在，请选择编辑。', not_found: '资源或接口不存在，请刷新目录并检查模块是否启用。',
  validation_failed: '配置校验未通过，请检查字段与引用关系。', invalid_params: '提交字段或配置版本无效，请检查输入并重新读取。',
  models_failed: '获取模型列表失败，请检查模型服务地址和 Key。',
  save_unconfirmed: '保存结果未确认，请读取最新配置核对，不要直接重复提交。',
  saved_readback_failed: '配置已保存，但回读失败，请恢复连接后读取同名资源。',
  saved_revision_changed: '已保存，但回读前版本再次变化，请重新读取。',
  relay_binding_api_not_connected: '中转授权接口尚未接入；当前不能申请或撤销授权。',
  backend_cooldown_api_not_connected: '后端冷却状态接口尚未接入。',
}
export class ManagerApiError extends Error {
  constructor(public code: string, public status: number, public path: string, message: string) {
    super(`${message}（${status ? `HTTP ${status} · ` : ''}${code} · ${path.split('?')[0]}）`)
    this.name = 'ManagerApiError'
  }
}
/** Preserve HTTP/error codes; never expose raw upstream bodies or retry writes. */
export async function managerRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 10000)
  try {
    let response: Response
    try {
      response = await fetch(path, { ...init, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: abort.signal,
        headers: { Accept: 'application/json', ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...init.headers } })
    } catch {
      throw new ManagerApiError(abort.signal.aborted ? 'timeout' : 'network_error', 0, path,
        abort.signal.aborted ? '请求超时。若正在保存，请先回读核对，不要重复提交。' : '无法连接 Manager，请检查网络和访问地址。若正在保存，请先回读核对。')
    }
    if (response.status === 401 && !['/api/auth/login', '/api/auth/setup'].includes(path)) sessionExpired?.()
    let result: any
    try { result = await response.json() }
    catch { throw new ManagerApiError('invalid_response', response.status, path, '服务未返回有效 JSON，请检查接口版本或反向代理。') }
    if (!response.ok || result?.error) {
      const raw = result?.error
      const code = typeof raw === 'string' ? raw : typeof raw?.code === 'string' ? raw.code : `http_${response.status}`
      const safeCode = /^[a-zA-Z0-9_-]{1,80}$/.test(code) ? code : 'request_failed'
      const detail = safeCode === 'reference_protected' && typeof raw?.message === 'string' ? raw.message.slice(0,1000) : messages[safeCode]
      throw new ManagerApiError(safeCode, response.status, path, detail ?? '操作未完成，请检查输入和服务状态；已提交的修改须回读核对。')
    }
    if (!result || typeof result !== 'object') throw new ManagerApiError('invalid_response', response.status, path, '服务响应格式无效。')
    return result as T
  } finally { clearTimeout(timer) }
}
