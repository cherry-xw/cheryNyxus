import { createRouter } from './message/router.js'
import { createWebSocketServer } from './websocket/index.js'
import { createHttpServer } from './http/index.js'
import { registerBrainHandlers } from './brain/list.js'
import { registerSenseHandlers } from './sense/list.js'
import { registerSkillHandlers } from './skill/list.js'
import { registerSkillImportHandlers } from './skill/import.js'
import { registerSkillSourceHandlers } from './skill/sources.js'
import { registerPluginHandlers } from './plugin/index.js'
import { registerCredentialsHandlers } from './credentials/handler.js'
import { registerPromptHandlers } from './prompt/list.js'
import { registerRuleHandlers } from './rule/list.js'
import { registerRuntimeSetHandlers } from './runtime/set.js'
import { registerSessionRuntimeHandlers } from './runtime/session.js'
import { registerChatHandlers } from './chat/send.js'
import { rebuildWaitedChildren } from './chat/wake.js'
import { registerChatManageHandlers } from './chat/handler.js'
import { registerConversationRouterHandlers } from './chat/conversationRouter.js'
import { registerConversationBranchHandlers } from './chat/conversationBranch.js'
import { registerInteractionHandlers } from './interaction/handler.js'
import { startInteractionLifecycle, stopInteractionLifecycle } from './interaction/lifecycle.js'
import { requestParkAfterTurn } from './chat/runtime.js'
import { disconnectGrace } from './websocket/disconnectGrace.js'
import { approvalManager } from './approval/manager.js'
import { registerBashHandlers } from './bash/handler.js'
import { registerMcpHandlers } from './mcp/handler.js'
import { registerRole } from './subagent/index.js'
import { registerConfigHandlers } from './config/handler.js'
import { registerHooksHandlers } from './hooks/handler.js'
import { registerUtilsHandlers } from './utils/handler.js'
import { registerBrowseHandlers } from './browse/handler.js'
import { registerCommandHandlers } from './command/handler.js'
import { startScheduleService, stopScheduleService } from './schedule/scheduler.js'
import { randomBytes } from 'node:crypto'
import { OAuth2Auth, type OAuth2Config } from './auth/index.js'

export { createWebSocketServer } from './websocket/index.js'
export { createHttpServer } from './http/index.js'
export { createRouter } from './message/router.js'
export * from './message/types.js'

export interface StartServiceOptions {
  /** WebSocket 服务端口（config.server.port） */
  port: number
  /** HTTP 静态服务端口（config.server.web_port） */
  webPort: number
  /**
   * 前端静态产物目录（web/dist/）。未提供或磁盘不存在时仅 serve /api/*，
   * 非 API 路径返回 JSON 404 提示前端未托管（让 vite proxy / 反向代理接管）。
   */
  staticDir?: string
  /** Allows tests/integrators to supply a stable local session capability. */
  sessionToken?: string
  /** Network binding. Defaults to loopback; set explicitly for an intranet deployment. */
  host?: string
  auth?: OAuth2Config
}

export interface ServiceHandle {
  wss: ReturnType<typeof createWebSocketServer>
  httpServer: ReturnType<typeof createHttpServer>
  /** 停止定时触发器（cron scheduler），测试/关闭时调用 */
  stopSchedule: () => void
}

/**
 * 启动 RPC 服务（WebSocket）+ HTTP 静态服务
 */
export function startService(options: StartServiceOptions): ServiceHandle {
  const router = createRouter()

  // 注册 handlers
  registerBrainHandlers(router)
  registerSenseHandlers(router)
  registerSkillHandlers(router)
  registerSkillImportHandlers(router)
  registerSkillSourceHandlers(router)
  registerPluginHandlers(router)
  registerCredentialsHandlers(router)
  registerPromptHandlers(router)
  registerRuleHandlers(router)
  registerRuntimeSetHandlers(router)
  registerSessionRuntimeHandlers(router)
  registerChatHandlers(router)
  registerChatManageHandlers(router)
  registerConversationRouterHandlers(router)
  registerConversationBranchHandlers(router)
  registerInteractionHandlers(router)
  registerBashHandlers(router)
  registerMcpHandlers(router)
  // CP3 + T9：spawn broadcaster 注入 + wait=true 看门狗超时回调（spawn_role sense 用）。
  // 历史 subagent.result RPC 已废弃（wait=true 改后端注入唤醒，无需前端回传）。
  registerRole()
  // T9.10：从持久化 metadata 重建 wait=true 唤醒链（finished 子补唤 / interrupted 子重建链+看门狗）。
  // 须在 registerRole（注入 asyncWakeHandler）之后，使重建的看门狗超时可触发 wakeParent。
  void rebuildWaitedChildren()
  // 定时触发器：为每个 schedule.enabled !== false 的预设注册 cron 任务（典型：「维护」预设定时派 curator 做 Dream）。
  // 须在 config 加载后、服务就绪前注册；重启后自动重建。
  startScheduleService()
  startInteractionLifecycle()
  // 断连宽限：宽限期到期调用 requestParkAfterTurn（runtime 层安全边界） + parkApproval（无 LLM 流时的 fallback）。
  // 必须在 createWebSocketServer 之前注入，否则 handleRequest 的 rebind 路径无法找到依赖。
  disconnectGrace.configure({
    requestParkAfterTurn,
    parkApproval: (approvalId) => approvalManager.park(approvalId),
  })
  // Config 设置面板：读写 .chery/config.yaml（除 server 段，重启生效）
  registerConfigHandlers(router)
  // Hooks 管理：读写 .chery/hooks/hooks.json（独立于 config.yaml）
  registerHooksHandlers(router)
  // Utils 工具：独立信息查询（utils.models 等，不依赖 chat/brain 运行时）
  registerUtilsHandlers(router)
  // 文件夹浏览协议：设置页工作区「浏览」（config.workspace.browse.*，根锚定 + 载荷加密）
  registerBrowseHandlers(router)
  // 内置命令系统：settings 「指令」tab 后端（读写 .chery/command/*.md）
  registerCommandHandlers(router)

  // 创建 WebSocket 服务器
  const auth = new OAuth2Auth(options.auth)
  const sessionToken = options.sessionToken ?? randomBytes(32).toString('base64url')
  const allowedOrigins = [
    `http://127.0.0.1:${options.webPort}`,
    `http://localhost:${options.webPort}`,
    // Vite development server (the socket is proxied, but browser Origin remains 5173).
    'http://127.0.0.1:5173',
    'http://localhost:5173',
    'file://',
  ]
  const wss = createWebSocketServer({
    port: options.port,
    host: options.host ?? '127.0.0.1',
    router,
    authToken: sessionToken,
    allowedOrigins,
    auth,
  })

  // 创建 HTTP 服务器（静态 serve + /api/config）
  const httpServer = createHttpServer({
    webPort: options.webPort,
    ...(options.staticDir ? { staticDir: options.staticDir } : {}),
    sessionToken,
    host: options.host ?? '127.0.0.1',
    auth,
  })

  return {
    wss,
    httpServer,
    stopSchedule: () => {
      stopInteractionLifecycle()
      stopScheduleService()
    },
  }
}
