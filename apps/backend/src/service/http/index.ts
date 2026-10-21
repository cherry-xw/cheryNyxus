import { createManagedAppGateway } from '../managedApp/gateway.js'
import { MachineRelayOperationSchema, MachineMaintenanceSchema } from '@chery/protocol'
import { randomUUID } from 'node:crypto'
import type { BackendCapabilities } from '../capabilities.js'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import config, { DEFAULT_PRESET_NAME } from '@/utils/config.js'
import { logger } from '@/utils/logger/index.js'
import { OAuth2Auth } from '../auth/index.js'
import { reportFatalStartupError } from '../fatalStartup.js'
import { handleAssetHttp } from '../media/http.js'
import { handleFileServiceHttp } from '../fileServices/http.js'
import { stageSkillZipBuffer } from '../skill/import.js'

/**
 * MIME 类型映射（自写 minimal static serve，无新依赖）
 */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

export interface CreateHttpServerOptions {
  capabilities?: BackendCapabilities
  webPort: number
  /**
   * 前端静态产物目录。省略或磁盘不存在时：
   * - 仅 serve `/api/*`（config、auth、media、skills）
   * - 其他路径返回 JSON 404 + 提示（前端未托管，部署需在反向代理或 vite dev 中接管）
   *
   * 提供了但路径不存在 → logger.info 警告后退化为上述行为（不阻塞启动）。
   */
  staticDir?: string
  /** Local bootstrap capability for the separately bound WebSocket server. */
  sessionToken?: string
  host?: string
  auth?: OAuth2Auth
  /** Local keeps the existing loopback behavior; remote is tunnel-only. */
  listener?: 'local' | 'remote'
  /** The paired WebSocket port for local discovery. */
  relayOperation?: (type: string, input: Record<string, unknown>) => Promise<unknown>
  relayBinding?: () => Promise<unknown>
  wsPort?: number | (() => number)
}

/**
 * 创建 HTTP 服务器：
 * - GET /api/config → 返回 {wsPort, webPort, transport}，供前端自动构建 WS 连接地址
 * - 其余 `/api/*` → 业务端点（auth、media、skills）
 * - 非 API 路径 → 静态 serve `staticDir`（提供且存在）/ JSON 404（未提供）
 *
 * 协议规范见 docs/shared/protocol/websocket.md「HTTP API」段。
 */
export function createHttpServer({
  relayBinding,
  relayOperation,
  capabilities,
  webPort,
  staticDir,
  sessionToken,
  host = '127.0.0.1',
  auth,
  listener = 'local',
  wsPort,
}: CreateHttpServerOptions) {
  // 静态目录解析：未提供 → null（不挂文件 handler，所有非 API 路径返回 JSON 404 提示）
  const root = staticDir ? resolve(staticDir) : null
  if (root && !existsSync(root)) {
    logger.info(
      `HTTP 静态目录不存在: ${root}（仅 serve API，其他路径返回 JSON 404，请先 pnpm web:build）`,
    )
  }

  const managedApps = createManagedAppGateway()
  const maintenanceInstance = randomUUID()
  const server = createServer((req, res) => {
    const operationPath = new URL(req.url ?? '/', 'http://internal.invalid').pathname
    if (operationPath === '/api/machine/capabilities' && req.method === 'GET') {
      if (listener !== 'local' || !auth?.getMachineUser(req)) { res.writeHead(403); res.end(); return }
      const value = MachineMaintenanceSchema.parse({ protocolVersion: 1, instanceId: maintenanceInstance, protocolRange: { min: 1, max: 1 }, operations: [...(relayBinding ? ['relay.binding'] : []), ...(relayOperation ? ['relay.operation'] : [])], listener: 'local', diagnostic: auth.maintenanceDiagnostic() })
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); return
    }
    if (operationPath === '/api/machine/relay/operation' && req.method === 'POST') {
      if (listener !== 'local' || !auth?.getMachineUser(req) || !relayOperation) { res.writeHead(403); res.end(); return }
      void (async () => {
        const chunks: Buffer[] = []; let size = 0
        for await (const value of req) { const chunk = Buffer.from(value); size += chunk.length; if (size > 16384) throw new Error('body_too_large'); chunks.push(chunk) }
        const body = MachineRelayOperationSchema.parse(JSON.parse(Buffer.concat(chunks).toString()))
        const result = await relayOperation(body.type, body.input ?? {})
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(result))
      })().catch(() => { if (!res.headersSent) res.writeHead(503); res.end() })
      return
    }
    if (new URL(req.url ?? '/', 'http://internal.invalid').pathname === '/api/machine/relay/binding' && req.method === 'POST') {
      if (listener !== 'local' || !auth?.getMachineUser(req) || !relayBinding) { res.writeHead(403); res.end(); return }
      void relayBinding().then((request) => { res.writeHead(201, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ request })) }).catch(() => { res.writeHead(503); res.end() })
      return
    }
    (async () => {
      if (listener === 'local' && await managedApps.handle(req, res)) return
      await handleRequest(req, res, root, sessionToken, auth, listener, wsPort, capabilities)
    })().catch((err) => {
      logger.info(`HTTP 错误: ${(err as Error).message}`)
      if (!res.headersSent) {
        res.writeHead(500)
        res.end('Internal Server Error')
      }
    })
  })

  const closeServer = server.close.bind(server)
  server.close = ((callback?: (error?: Error) => void) => {
    managedApps.drain()
    return closeServer(callback)
  }) as typeof server.close
  server.on('upgrade', (req, socket, head) => {
    if (listener !== 'local') { socket.destroy(); return }
    void managedApps.upgrade(req, socket, head).then(handled => { if (!handled) socket.destroy() }).catch(() => socket.destroy())
  })
  server.listen(webPort, host)
  // 端口监听失败（EADDRINUSE）→ fatal 上报（guardian 停止重试，见 docs/backend/service/README.md）。
  // 无监听会直接崩溃 worker；挂上后 EADDRINUSE 走报告路径，其他错误仅日志。
  server.on('error', (err) => {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EADDRINUSE') {
      reportFatalStartupError({ code, port: webPort })
    } else {
      logger.info(`HTTP 服务启动失败: ${(err as Error).message}`)
    }
  })
  if (root && existsSync(root)) {
    logger.info(`HTTP 服务启动，端口: ${webPort}（静态目录: ${root}）`)
  } else {
    logger.info(`HTTP 服务启动，端口: ${webPort}（仅 API 模式，未托管前端 SPA）`)
  }

  return server
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  root: string | null,
  sessionToken?: string,
  auth?: OAuth2Auth,
  listener: 'local' | 'remote' = 'local',
  wsPort?: number | (() => number),
  capabilities?: BackendCapabilities,
): Promise<void> {
  if (listener === 'local' && auth?.browserDeployment() && ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method ?? '') && req.headers['sec-fetch-site'] === 'cross-site') { res.writeHead(403); res.end(); return }
  const publicPrefix = listener === 'local' ? auth?.browserDeployment()?.basePath ?? '' : ''
  if (publicPrefix && req.url?.startsWith(publicPrefix + '/')) req.url = req.url.slice(publicPrefix.length)
  const url = req.url ?? '/'
  if (auth && listener === 'local' && !url.startsWith('/api/browser-session') && !['GET', 'HEAD'].includes(req.method ?? 'GET') && req.headers.cookie?.includes('chery_business_session=')) {
    if (!auth.isTrustedOrigin(req.headers.origin, req)) { res.writeHead(403); res.end('Origin rejected'); return }
    try { auth.browser.store.checkCsrf(req.headers.cookie.split(/;\s*/).find((s) => s.startsWith('chery_business_session='))?.slice('chery_business_session='.length), String(req.headers['x-csrf-token'] ?? '')) } catch { res.writeHead(403); res.end('CSRF rejected'); return }
  }
  const authOptions =
    listener === 'remote'
      ? { allowLoopback: false, trustForwardedPrefix: true }
      : { allowLoopback: true, trustForwardedPrefix: false }

  // Auth endpoints and the SPA shell remain public so the client can render a
  // login overlay. The control-plane bootstrap is never issued anonymously.
  if (auth && listener === 'local' && await auth.browser.handle(req, res, typeof wsPort === 'function' ? wsPort() : (wsPort ?? config.server.port))) return
  if (auth && (await auth.handle(req, res, authOptions))) return
  if (
    (listener === 'remote' || auth?.enabled) &&
    (url === '/api/config' || url.startsWith('/api/config?')) &&
    !auth?.getUser(req, authOptions)
  ) {
    res.writeHead(401, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    res.end(JSON.stringify({ error: 'Authentication required', login: '/api/auth/login' }))
    return
  }

  if (url.startsWith('/api/assets/') || url.startsWith('/api/file-services/') || url.startsWith('/api/file-operations/')) {
    const authorized =
      listener === 'remote'
        ? !!auth?.getUser(req, authOptions)
        : auth?.enabled
          ? !!auth.getUser(req, authOptions)
          : !!sessionToken && req.headers['x-chery-session-token'] === sessionToken
    if (!authorized) {
      res.writeHead(401)
      res.end('Unauthorized')
      return
    }
    if (capabilities && !capabilities.has('media.attach')) { res.writeHead(403); res.end('当前服务未启用文件操作'); return }
    if ((url.startsWith('/api/assets/claim-history') || url.startsWith('/api/file-services/try')) && capabilities && !capabilities.has('settings.manage')) { res.writeHead(403); res.end('当前服务未启用设置管理'); return }
    const ownerId = auth?.getUser(req, authOptions)?.sub ?? (listener === 'local' ? 'local' : undefined)
    if (!ownerId) { res.writeHead(401); res.end('Unauthorized'); return }
    if (await handleAssetHttp(req, res, ownerId)) return
    if (await handleFileServiceHttp(req, res, ownerId)) return
  }

  // POST /api/skills/import —— ZIP 上传导入（raw bytes，鉴权同 media）→ stage 候选 + 冲突
  // 协议规范见 docs/shared/protocol/websocket.md；两阶段：前端拿到 stagingId+candidates 后用 skills.commit 落盘。
  if (url === '/api/skills/import' && req.method === 'POST') {
    const authorized =
      listener === 'remote'
        ? !!auth?.getUser(req, authOptions)
        : auth?.enabled
          ? !!auth.getUser(req, authOptions)
          : !!sessionToken && req.headers['x-chery-session-token'] === sessionToken
    if (!authorized) {
      res.writeHead(401)
      res.end('Unauthorized')
      return
    }
    try {
      const chunks: Buffer[] = []
      for await (const chunk of req)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      const result = stageSkillZipBuffer(Buffer.concat(chunks))
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(result))
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: (err as Error).message }))
    }
    return
  }

  // GET /api/config —— 前端 fetch 自动构建 WS 地址（见 protocol.md）
  if (url === '/api/config' || url.startsWith('/api/config?')) {
    // sessionToken 随 worker 重启轮换；客户端重连必须拿到最新值，禁止 HTTP 缓存旧响应。
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    // default 派生自「默认」预设 leader 角色（AgentDialog 无 runtime 时预选用）；
    // senseGroups 暴露全名单 + default 标记（= 是否等于「默认」预设 leader 角色的 senseGroup，供前端 AgentDialog 渲染单选 + 预选默认项）；
    // presets 暴露预设名单（name + leader + leader 角色 brain + 选中角色 type 列表），供 FAB 预设选择；
    // roles 不暴露（敏感配置留服务端）。无「默认」预设时不返 default 字段。
    const defaultPreset = config.presets?.[DEFAULT_PRESET_NAME]
    const defaultLeader = defaultPreset?.leader ? config.roles?.[defaultPreset.leader] : undefined
    const defaultCfg = defaultLeader
      ? {
          brain: defaultLeader.brain,
          senseGroup: defaultLeader.senseGroup,
          mcpServers: defaultLeader.mcpServers ?? [],
        }
      : undefined
    const defaultGroups = new Set(defaultCfg?.senseGroup ? [defaultCfg.senseGroup] : [])
    const senseGroupsList = Object.keys(config.sense_groups ?? {}).map((name) => ({
      name,
      default: defaultGroups.has(name),
    }))
    const presetsList = Object.entries(config.presets ?? {}).map(([name, p]) => ({
      name,
      leader: p.leader,
      brain: p.leader ? (config.roles?.[p.leader]?.brain ?? '') : '',
      roles: p.roles ?? [],
      ...(p.shadows ? { shadows: p.shadows } : {}),
    }))
    const remote = listener === 'remote'
    const requestHost = req.headers.host ?? '127.0.0.1'
    const wsHost = formatHost(new URL(`http://${requestHost}`).hostname)
    const deployment = !remote ? auth?.browserDeployment() : undefined
    const forwardedProto =
      String(remote ? req.headers['x-forwarded-proto'] ?? 'http' : deployment?.origin.startsWith('https:') ? 'https' : 'http')
        .split(',')[0]
        ?.trim() || 'http'
    const discovery = remote
      ? {
          remote: true,
          transport: config.server.transport,
          httpPath: '/api',
          wsPath: '/ws',
          ...(String(req.headers['x-forwarded-prefix'] ?? '').trim()
            ? { publicBasePath: String(req.headers['x-forwarded-prefix']).split(',')[0]?.trim() }
            : {}),
        }
      : {
          wsPort: typeof wsPort === 'function' ? wsPort() : (wsPort ?? config.server.port),
          webPort: config.server.webPort,
          transport: config.server.transport,
          httpBaseUrl: `${forwardedProto}://${requestHost}`,
          ...(deployment ? { httpBasePath: deployment.basePath, wsUrl: deployment.origin.replace(/^http/, 'ws') + deployment.basePath + '/ws' } : { wsUrl: `${forwardedProto === 'https' ? 'wss' : 'ws'}://${wsHost}:${typeof wsPort === 'function' ? wsPort() : (wsPort ?? config.server.port)}` }),
          httpPath: '/api',
          wsPath: '/ws',
        }
    res.end(
      JSON.stringify({
        ...discovery,
        ...(capabilities ? { bootstrap: capabilities.snapshot() } : {}),
        // Legacy local capability is not issued when OAuth2 is enabled: the
        // WebSocket authenticates with the HttpOnly browser session instead.
        // Browser authentication never exposes a long-lived local token.
        senseGroups: senseGroupsList,
        presets: presetsList,
        ...(defaultCfg ? { default: defaultCfg } : {}),
      }),
    )
    return
  }

  // 静态文件 serve（仅 root 存在时）
  if (root) {
    const pathname = decodeURIComponent(url.split('?')[0] ?? '/')
    const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, '')
    const filePath = join(root, safe)

    // 防目录越界
    if (!filePath.startsWith(root)) {
      res.writeHead(403)
      res.end('Forbidden')
      return
    }

    const stats = await stat(filePath).catch(() => null)
    if (stats?.isFile()) {
      const data = await readFile(filePath)
      res.writeHead(200, {
        'Content-Type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      })
      res.end(data)
      return
    }

    // SPA fallback —— hash 路由下未知路径回 index.html
    const indexData = await readFile(join(root, 'index.html')).catch(() => null)
    if (indexData) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(indexData)
      return
    }
  }

  // 未托管前端：非 API 路径返回 JSON 404 + 提示，便于浏览器/CLI 排查
  res.writeHead(404, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(
    JSON.stringify({
      error: 'Not Found',
      hint: root
        ? '静态资源未找到，请先 pnpm web:build 生成 apps/web/dist/，或将前端通过 vite dev / 反向代理托管'
        : '后端未托管前端 SPA（server.serve_frontend=false）。请通过 vite dev（:5173）或反向代理访问前端',
      path: url,
    }),
  )
}

function formatHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}
