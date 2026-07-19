import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import config, { DEFAULT_PRESET_NAME } from '@/utils/config.js'
import { logger } from '@/utils/logger/index.js'
import { OAuth2Auth } from '../auth/index.js'
import { readMediaAsset, saveMediaAsset } from '../media/index.js'
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
  webPort: number
  staticDir: string
  /** Local bootstrap capability for the separately bound WebSocket server. */
  sessionToken?: string
  host?: string
  auth?: OAuth2Auth
}

/**
 * 创建 HTTP 服务器：
 * - GET /api/config → 返回 {wsPort, webPort, transport}，供前端自动构建 WS 连接地址
 * - 其余路径 → 静态 serve staticDir（SPA fallback 到 index.html）
 *
 * 协议规范见 docs/protocol.md「HTTP API」段。
 */
export function createHttpServer({
  webPort,
  staticDir,
  sessionToken,
  host = '127.0.0.1',
  auth,
}: CreateHttpServerOptions) {
  const root = resolve(staticDir)

  if (!existsSync(root)) {
    logger.info(`HTTP 静态目录不存在: ${root}（serve 时返回 404，请先 pnpm web:build）`)
  }

  const server = createServer((req, res) => {
    handleRequest(req, res, root, sessionToken, auth).catch((err) => {
      logger.info(`HTTP 错误: ${(err as Error).message}`)
      if (!res.headersSent) {
        res.writeHead(500)
        res.end('Internal Server Error')
      }
    })
  })

  server.listen(webPort, host)
  logger.info(`HTTP 服务启动，端口: ${webPort}（静态目录: ${root}）`)

  return server
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  root: string,
  sessionToken?: string,
  auth?: OAuth2Auth,
): Promise<void> {
  const url = req.url ?? '/'

  // Auth endpoints and the SPA shell remain public so the client can render a
  // login overlay. The control-plane bootstrap is never issued anonymously.
  if (auth && (await auth.handle(req, res))) return
  if (
    auth?.enabled &&
    (url === '/api/config' || url.startsWith('/api/config?')) &&
    !auth.getUser(req)
  ) {
    res.writeHead(401, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    res.end(JSON.stringify({ error: 'Authentication required', login: '/api/auth/login' }))
    return
  }

  const isMediaRequest = url.startsWith('/api/media/')
  if (isMediaRequest) {
    const authorized = auth?.enabled
      ? !!auth.getUser(req)
      : !!sessionToken && req.headers['x-chery-session-token'] === sessionToken
    if (!authorized) {
      res.writeHead(401)
      res.end('Unauthorized')
      return
    }
    if (req.method === 'POST' && url === '/api/media/upload') {
      const chunks: Buffer[] = []
      for await (const chunk of req)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      const asset = await saveMediaAsset(
        Buffer.concat(chunks),
        String(req.headers['content-type'] ?? ''),
        String(req.headers['x-filename'] ?? 'upload'),
      )
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ...asset, path: undefined, url: `/api/media/${asset.filename}` }))
      return
    }
    if (req.method === 'GET') {
      const file = url.split('?')[0]?.slice('/api/media/'.length) ?? ''
      const asset = await readMediaAsset(file)
      if (!asset) {
        res.writeHead(404)
        res.end('Not Found')
        return
      }
      res.writeHead(200, {
        'Content-Type': asset.mimeType,
        'Cache-Control': 'private, max-age=3600',
      })
      res.end(asset.data)
      return
    }
  }

  // POST /api/skills/import —— ZIP 上传导入（raw bytes，鉴权同 media）→ stage 候选 + 冲突
  // 协议规范见 docs/protocol.md；两阶段：前端拿到 stagingId+candidates 后用 skills.commit 落盘。
  if (url === '/api/skills/import' && req.method === 'POST') {
    const authorized = auth?.enabled
      ? !!auth.getUser(req)
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
    }))
    res.end(
      JSON.stringify({
        wsPort: config.server.port,
        webPort: Number(process.env.WEB_PORT ?? 8183),
        transport: config.server.transport,
        // Legacy local capability is not issued when OAuth2 is enabled: the
        // WebSocket authenticates with the HttpOnly browser session instead.
        ...(sessionToken && !auth?.enabled ? { sessionToken } : {}),
        senseGroups: senseGroupsList,
        presets: presetsList,
        ...(defaultCfg ? { default: defaultCfg } : {}),
      }),
    )
    return
  }

  // 静态文件 serve
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

  res.writeHead(404)
  res.end('Not Found')
}
