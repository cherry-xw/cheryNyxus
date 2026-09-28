import { createServer } from 'node:http'
import { connect, type AddressInfo } from 'node:net'
import { readFile } from 'node:fs/promises'
import { freemem, loadavg, totalmem, uptime } from 'node:os'
import yaml from 'js-yaml'
import { ProcessController } from './processController.js'
import { CredentialStore } from './credentials.js'
import { isTokenValid, loadOrCreateToken } from './tokenStore.js'
import { verifyLogin } from './verifyLogin.js'
import { writeManagerPage as writeRetroManagerPage } from './page.js'

export interface ManagerOptions {
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
}

export function createManager(options: ManagerOptions = {}) {
  const controller = new ProcessController()
  const cheryDir = process.env.CHERY_DIR ?? process.cwd()
  // 管理控制密钥：显式配置（CHERY_MANAGER_TOKEN）优先；否则持久化到 .chery/manager-token.json，
  // 重启后保持稳定，超过轮换周期（7 天）在启动时自动轮换，旧密钥 24 小时内仍可用（读取/续期）。
  const tokenState = loadOrCreateToken(
    options.tokenFile ?? `${cheryDir}/.chery/manager-token.json`,
    options.controlToken,
  )
  const controlToken = tokenState.token
  const backendCommand = options.backendCommand ?? process.execPath
  const backendArgs = options.backendArgs ?? ['dist/index.js']
  const ratholeCommand = options.ratholeCommand ?? 'rathole'
  const ratholeArgs = options.ratholeArgs ?? ['--config', 'rathole-client.toml']
  const credentialStore = new CredentialStore({
    configFile: options.configFile ?? `${cheryDir}/.chery/config.yaml`,
    credentialsFile: options.credentialsFile ?? `${cheryDir}/.chery/manager-credentials.json`,
  })
  const server = createServer(async (req, res) => {
    const presented = readPresentedToken(req)
    const tokenAuthorized = isTokenValid(tokenState, presented)
    // 已认证（当前或宽限期旧密钥）的请求：下发续期密钥响应头与可读 Cookie，
    // 供页面记忆新密钥、刷新后无需再带 URL 密钥即可重新进入。
    if (tokenAuthorized) {
      res.setHeader('X-Chery-Manager-Token', controlToken)
      res.setHeader(
        'Set-Cookie',
        `chery-manager-token=${controlToken}; Path=/; Max-Age=7776000; SameSite=Strict`,
      )
    }
    // 内网（非本机）访问一律要求有效管理密钥：页面与全部 /api/* 都需携带
    //（URL ?token= 查询参数 / X-Chery-Manager-Token 请求头 / 密钥 Cookie）。
    // 本机回环保持原行为：只读接口免密钥、控制接口仍需当前密钥（Electron 本地发现依赖此豁免）。
    if (!isLoopbackAddress(req.socket.remoteAddress) && !tokenAuthorized) {
      res.writeHead(401, { 'Cache-Control': 'no-store' })
      res.end('Unauthorized')
      return
    }
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    if (path === '/api/status' && req.method === 'GET') {
      json(res, 200, {
        manager: 'running',
        processes: controller.state(),
        backend: await detectBackendStatus(options.backendStatusFile, options.configFile),
        relay: await readRelayStatus(options.relayStatusFile),
        system: readSystemMetrics(),
      })
      return
    }
    const match = /^\/api\/(backend|rathole)\/(start|stop|restart)$/.exec(path)
    if (match && (req.method === 'POST' || req.method === 'PUT')) {
      if (presented !== controlToken) {
        res.writeHead(401, { 'Cache-Control': 'no-store' })
        res.end('Unauthorized')
        return
      }
      const name = match[1] as 'backend' | 'rathole'
      const action = match[2]
      const result =
        action === 'stop'
          ? await controller.stop(name)
          : action === 'restart'
            ? await controller.restart(
                name,
                name === 'backend' ? backendCommand : ratholeCommand,
                name === 'backend' ? backendArgs : ratholeArgs,
              )
            : controller.start(
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
    if (path === '/api/credentials' && req.method === 'GET') {
      if (presented !== controlToken) {
        unauthorized(res)
        return
      }
      json(res, 200, await credentialStore.status())
      return
    }
    if (path === '/api/credentials/rotate' && (req.method === 'POST' || req.method === 'PUT')) {
      if (presented !== controlToken) {
        unauthorized(res)
        return
      }
      const body = await readJsonBody(req)
      const credentials = await credentialStore.rotate({
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
        credentials.username,
        credentials.password ?? '',
      )
      json(res, 200, { credentials, backend, verification })
      return
    }
    if (path === '/' || path === '/index.html') {
       writeRetroManagerPage(res, !isLoopbackHost(options.host))
      return
    }
    res.writeHead(404)
    res.end('Not Found')
  })
  return {
    controller,
    token: controlToken,
    listen: () =>
      new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(options.port ?? 39980, options.host ?? '127.0.0.1', () => resolve())
      }),
    address: () => server.address() as AddressInfo | null,
    close: async () => {
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

/** 请求携带的管理密钥：优先 X-Chery-Manager-Token 请求头，其次 URL ?token= 查询参数。 */
export function readControlToken(req: import('node:http').IncomingMessage): string {
  const header = req.headers['x-chery-manager-token']
  if (typeof header === 'string' && header) return header
  return new URL(req.url ?? '/', 'http://localhost').searchParams.get('token') ?? ''
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

/** 完整取密钥来源：请求头 / URL 查询参数 / 密钥 Cookie（顺序取第一个非空）。 */
function readPresentedToken(req: import('node:http').IncomingMessage): string {
  const header = readControlToken(req)
  if (header) return header
  return readCookie(req, 'chery-manager-token')
}

function readCookie(req: import('node:http').IncomingMessage, name: string): string {
  const header = req.headers.cookie
  if (!header) return ''
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() === name) {
      const value = part.slice(eq + 1).trim()
      try {
        return decodeURIComponent(value)
      } catch {
        return value
      }
    }
  }
  return ''
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

async function readJsonBody(req: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 16 * 1024) throw new Error('Request body is too large')
    chunks.push(buffer)
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {}
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
      wsPort: typeof s.port === 'number' ? s.port : 8182,
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
