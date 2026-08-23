import { WebSocketServer, WebSocket } from 'ws'
import { timingSafeEqual } from 'node:crypto'
import {
  RpcRouter,
  createResponse,
  createError,
  ErrorCode,
  isRequest,
  type Request,
  type Response as RpcResponse,
} from '../message/index.js'
import { connectionManager, type ConnectionState } from './connection.js'
import { transport } from './transport.js'
import { SUPPORTED_LITE_VERSIONS, applyLiteResponse, type LiteProfile } from './liteProjection.js'
import { isAsyncGenerator } from '@/utils/generator.js'
import { logger } from '@/utils/logger/index.js'
import { LogLevel } from '@/utils/logger/types.js'
import { reportFatalStartupError } from '../fatalStartup.js'
import { OAuth2Auth } from '../auth/index.js'
import { appendChatEvent, claimRequest, completeRequest } from '@/db/delivery.js'
import { disconnectGrace } from './disconnectGrace.js'

/** Requests still executing in this process. A reconnect joins this promise instead of rerunning a handler. */
const inFlightRequests = new Map<string, Promise<RpcResponse>>()

function shouldPersistChatEvent(method: string): boolean {
  return method === 'chat.send' || method === 'chat.resume' || method === 'chat.startSpawn'
}

function persistChatEvent<T extends { chatId?: string; seq?: number }>(
  method: string,
  event: T,
): T {
  if (shouldPersistChatEvent(method) && event.chatId) {
    event.seq = appendChatEvent(event.chatId, event as Record<string, unknown>)
  }
  return event
}

/**
 * 发送单个 chat event（chunk/notification）。当前 output ws 不可写时仅记日志，
 * 不抛出影响 generator；重连后新 ws 接管后续事件，断连窗口由 `chat.sync` 回放补齐。
 */
function sendChatEvent(targets: readonly WebSocket[], item: unknown): void {
  for (const ws of targets) {
    if (ws.readyState !== ws.OPEN) continue
    for (const routed of connectionManager.prepareSessionEvent(ws, item)) {
      try {
        ws.send(transport.encode(routed as Parameters<typeof transport.encode>[0]))
      } catch (err) {
        logger.event('ws.event.failed', { message: (err as Error).message }, 3)
      }
    }
  }
}

/**
 * 解析实时输出目标 ws：chat.attach 重定向命中（按 event.chatId）→ 新连接 ws；否则回落启动 run 的捕获 ws。
 * 使刷新后新连接能接管仍在运行的 run 的后续 chunk/notification（含终态 done/error）。
 */
function resolveOutputWss(item: { chatId?: string }, fallbackWs: WebSocket): WebSocket[] {
  return item.chatId ? connectionManager.getChatOutputs(item.chatId, fallbackWs) : [fallbackWs]
}

/**
 * WebSocket 服务器配置
 */
interface WebSocketServerConfig {
  port: number
  router: RpcRouter
  /** Binding is supplied by the service entrypoint. */
  host?: string
  /** Per-process capability, distributed only through the local HTTP/IPC bootstrap. */
  authToken?: string
  /** Browser origins allowed to use an authenticated control-plane socket. */
  allowedOrigins?: readonly string[]
  /** Cookie-session authentication used for intranet OAuth2 deployments. */
  auth?: OAuth2Auth
}

/**
 * 创建 WebSocket 服务器
 */
export function createWebSocketServer(config: WebSocketServerConfig): WebSocketServer {
  const { port, router, host, authToken, allowedOrigins = [], auth } = config
  const wss = new WebSocketServer({
    port,
    ...(host ? { host } : {}),
    verifyClient:
      authToken || auth?.enabled
        ? (info, done) => {
            const origin = info.origin
            if (
              !origin ||
              !(auth?.isTrustedOrigin(origin, info.req) || allowedOrigins.includes(origin))
            ) {
              done(false, 403, 'WebSocket origin is not allowed')
              return
            }
            if (auth?.enabled) {
              if (!auth.getUser(info.req)) done(false, 401, 'WebSocket authentication required')
              else done(true)
              return
            }
            const token =
              new URL(info.req.url ?? '/', 'ws://localhost').searchParams.get('token') ?? ''
            if (!constantTimeTokenEqual(token, authToken!)) {
              done(false, 401, 'WebSocket authentication failed')
              return
            }
            done(true)
          }
        : undefined,
  })

  // 端口监听失败（EADDRINUSE）→ fatal 上报（guardian 停止重试，见 docs/service/README.md）。
  // ws 库把底层 _server 的 error 转发到 wss 实例的 'error' 事件（见 ws lib/websocket-server.js
  // addListeners: `error: this.emit.bind(this, 'error')`）；若 wss 无 error listener，
  // Node 视为 unhandled 'error' 直接 throw crash worker。挂上后 EADDRINUSE 走报告路径，
  // 其他错误仅日志（不退出）。
  let reported = false
  wss.on('error', (err) => {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EADDRINUSE' && !reported) {
      reported = true
      reportFatalStartupError({ code, port })
    } else if (code !== 'EADDRINUSE') {
      logger.info(`WebSocket 服务启动失败: ${(err as Error).message}`)
    }
  })

  wss.on('connection', (ws, req) => {
    // lite profile 声明（canonical §3.6.1）：?profile=lite&v=1（与 ?token= 同风格）。
    // 未知版本按 D14 在握手期拒绝——close frame 携带 JSON{supportedVersions}，设备可机读判定。
    const liteProfile = parseLiteProfile(req?.url)
    if (liteProfile === 'unsupported') {
      ws.close(4001, JSON.stringify({ supportedVersions: SUPPORTED_LITE_VERSIONS }))
      logger.event('conn.lite_rejected', { supported: SUPPORTED_LITE_VERSIONS })
      return
    }
    const state = connectionManager.create(ws, liteProfile ?? undefined)
    logger.run(
      { connectionId: state.id },
      () =>
        logger.event('conn.open', liteProfile ? { profile: 'lite', v: liteProfile.v } : undefined),
    )

    ws.on('message', async (data) => {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
      try {
        await handleMessage(ws, state, buffer, router)
      } catch (err) {
        const error = err as Error
        logger.run({ connectionId: state.id }, () =>
          logger.event('req.error', { message: error.message }, LogLevel.error),
        )
        try {
          const raw = transport.parseMessage(buffer) as { id?: string }
          const requestId = raw.id || ''
          sendError(ws, error.message, requestId)
        } catch {
          sendError(ws, error.message)
        }
      }
    })

    ws.on('close', async () => {
      logger.run({ connectionId: state.id }, () => logger.event('conn.close'))
      // 进入断连宽限期：grace 期内同 requestId 在新 ws 重连 → rebind 继续当前 loop。
      // 超过 disconnect_grace_ms 仍无新 owner → 由 disconnectGrace 标记安全边界暂停 + park 挂起审批。
      disconnectGrace.onConnectionClosed(state.id)
      await connectionManager.close(ws)
    })

    ws.on('error', (err) => {
      logger.run({ connectionId: state.id }, () =>
        logger.event('conn.error', { message: err.message }, LogLevel.error),
      )
    })
  })

  logger.info(`WebSocket 服务启动，地址: ${host ?? 'default'}:${port}`)
  return wss
}

function constantTimeTokenEqual(actual: string, expected: string): boolean {
  const a = Buffer.from(actual)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * 处理消息
 */
async function handleMessage(
  ws: WebSocket,
  state: ConnectionState,
  data: Buffer | string,
  router: RpcRouter,
): Promise<void> {
  const raw = transport.parseMessage(data)

  // 心跳探测：前端定时发纯 JSON {kind:'ping'}（浏览器 WebSocket 无法主动发协议层
  // ping 帧），原样回 {kind:'pong'}，不进 RPC 路由、不产生 req.start/req.end 日志。
  if ((raw as { kind?: string }).kind === 'ping') {
    ws.send(transport.serializeMessage({ kind: 'pong' }))
    return
  }

  if (isRequest(raw)) {
    await handleRequest(ws, state, raw, router)
  } else {
    sendError(ws, '收到了看不懂的消息')
  }
}

/**
 * 处理 Request
 *
 * als.run 边界：整个请求处理（handler → agent → 中间件链 → observer/streamMapper）
 * 在此 scope 内执行。注意必须包「迭代」而非「创建」—— async generator 的 body 在
 * `.next()` 时运行，而最外层 `.next()` 就在本函数（普通 async 函数，非 generator）内，
 * 故整条流式链（含中间件深层日志）携带此 scope。跨审批挂起亦保持（本函数停在 await next）。
 */
async function handleRequest(
  ws: WebSocket,
  state: ConnectionState,
  request: Request,
  router: RpcRouter,
): Promise<void> {
  const claim = claimRequest(request.id, request.method, request.params)
  if (claim.state === 'mismatch') {
    const response = createResponse(
      request.id,
      false,
      undefined,
      createError(ErrorCode.CONFLICT, '请求重复了，请重试'),
    )
    sendResponse(ws, response)
    return
  }
  if (claim.state === 'completed') {
    if (ws.readyState === ws.OPEN) ws.send(claim.responseJson)
    return
  }
  if (claim.state === 'active') {
    const running = inFlightRequests.get(request.id)
    if (running) {
      // 同一 requestId 在新 connection 上重连：迁移输出目标到新 ws，
      // 取消 grace timer，继续当前 loop（不再启第二个 generator）。
      disconnectGrace.rebind({
        requestId: request.id,
        connectionId: state.id,
        outputWs: ws,
      })
      // 同页瞬断重连：把仍在跑的 run 后续实时输出重定向到新 ws（sendChatEvent 按 chatId 解析 liveOutput）。
      const reboundChatId = disconnectGrace.getChatId(request.id)
      if (reboundChatId) connectionManager.setLiveOutput(reboundChatId, ws)
      const response = await running
      sendResponse(ws, response)
      return
    }
    // An active row without a local promise means the process restarted. Do
    // not risk replaying side effects; make the stored terminal outcome
    // explicit so this id stays safe and callers can use chat.resume/new id.
    const interrupted = createResponse(
      request.id,
      false,
      undefined,
      createError(ErrorCode.CONFLICT, '我刚重启了一下，重新打开会话试试'),
    )
    completeRequest(request.id, interrupted)
    sendResponse(ws, interrupted)
    return
  }

  connectionManager.addPendingRequest(ws, request.id)

  let settle!: (response: RpcResponse) => void
  const completion = new Promise<RpcResponse>((resolve) => {
    settle = resolve
  })
  inFlightRequests.set(request.id, completion)

  // 创建 handler context
  const ctx = {
    requestId: request.id,
    connectionId: state.id,
    log: logger,
  }

  const scope = {
    connectionId: state.id,
    requestId: request.id,
    traceId: extractChatId(request.params),
  }

  // 断连宽限：跟踪该 in-flight request；rebinds/cancel 由 disconnectGrace 控制。
  // 仅对持久化事件（chat.send/resume/startSpawn）跟踪以减状态表体积。
  if (shouldPersistChatEvent(request.method)) {
    const chatId = scope.traceId
    if (chatId) {
      disconnectGrace.track({
        requestId: request.id,
        chatId,
        runId: request.id,
        connectionId: state.id,
        outputWs: ws,
      })
    }
  }

  let finalResponse: RpcResponse | undefined
  try {
    // 执行 handler（在 scope 内迭代流式输出）
    await logger.run(scope, async () => {
      logger.event('req.start', { method: request.method })
      let outcome: { success: boolean; error?: string } | undefined
      try {
        const result = await router.handle(request, ctx)

        // 处理结果
        if (isAsyncGenerator(result)) {
          while (true) {
            const iter = await result.next()
            if (iter.done) {
              finalResponse = iter.value
              break
            }
            const item = persistChatEvent(request.method, iter.value)

            // Notification 消息
            if (item.kind === 'notification') {
              // interrupt：记 approvalId→requestId 映射（供 close(ws) park；限时超时由 core approvalRegistry 管）
              if (item.type === 'interrupt' && item.data && 'approvalId' in item.data) {
                // 仅记 approvalId→requestId 映射，供 close(ws) 时 park 该审批（WS 断连路径）。
                // 限时超时由 core approvalRegistry 独占管理（createApproval(id, global.approval_timeout)，
                // 见 tool.ts:266）：超时 resolve as reject→sense_reject→rejected notification→子 loop 继续
                // （= 用户点 Reject）。service 层不再起重复 timer——旧 startApprovalTimeout 超时
                // ws.send(TIMEOUT)+close(ws) 拆连接是 bug 源（覆盖 registry 的正确 reject），已废。
                const interrupt = item.data as { approvalId: string }
                connectionManager.setRequestApprovalId(ws, request.id, interrupt.approvalId)
                // 同步给断连宽限调度器：宽限期到期时 park。
                disconnectGrace.setPendingApproval(request.id, interrupt.approvalId)
              }
              sendChatEvent(resolveOutputWss(item, ws), item)
              continue
            }

            // Chunk 消息
            sendChatEvent(resolveOutputWss(item, ws), item)
          }
          outcome = { success: finalResponse?.success !== false }
        } else {
          finalResponse = result
          outcome = { success: result.success !== false }
        }
      } catch (e) {
        outcome = { success: false, error: (e as Error).message }
        throw e
      } finally {
        logger.event('req.end', outcome)
      }
    })
  } catch (error) {
    const err = error as Error
    logger.event('req.error', { method: request.method, message: err.message }, LogLevel.error)
    finalResponse = createResponse(
      request.id,
      false,
      undefined,
      createError(ErrorCode.INTERNAL, err.message),
    )
  } finally {
    const response =
      finalResponse ??
      createResponse(
        request.id,
        false,
        undefined,
        createError(ErrorCode.INTERNAL, '系统出了点小问题'),
      )
    completeRequest(request.id, response)
    settle(response)
    inFlightRequests.delete(request.id)
    // 宽限期跟踪清理（rebound/finished 都用同一入口）
    disconnectGrace.onRequestFinished(request.id)
    // 若当前 ws 还活着：发终态 response + 释放 pending。rebinds 场景下 ws 已替换，
    // 仍允许向新 ws 投递。
    sendResponse(ws, response)
    // chat.open releases its snapshot fence before returning. Flush events that
    // arrived after the captured boundary only after the RPC response is visible.
    if (request.method === 'chat.open' && response.success) {
      const subscriptionId =
        response.data && typeof response.data === 'object' && 'subscriptionId' in response.data
          ? (response.data as { subscriptionId?: unknown }).subscriptionId
          : undefined
      if (typeof subscriptionId === 'string') {
        for (const buffered of connectionManager.drainSessionBuffer(subscriptionId)) {
          sendChatEvent(resolveOutputWss(buffered as { chatId?: string }, ws), buffered)
        }
      }
    }
    connectionManager.removePendingRequest(ws, request.id)
  }
}

/**
 * 从 RPC params 提取 chatId（若存在且为 string）—— 用作 traceId（会话关联）。
 * 仅 chat.* / sense.approval 等携带 chatId 的方法会产生 traceId；其余方法 traceId 缺省。
 */
function extractChatId(params: unknown): string | undefined {
  if (params && typeof params === 'object' && 'chatId' in params) {
    const v = (params as Record<string, unknown>).chatId
    if (typeof v === 'string') return v
  }
  return undefined
}

/**
 * 解析连接 URL 的 lite profile 查询参数（?profile=lite&v=1[&maxFrameBytes=N][&turnDelta=1]）。
 * - 非 lite 连接 → undefined（行为零变化）
 * - profile=lite 但 v 未知 → 'unsupported'（调用方握手期 close 4001）
 */
export function parseLiteProfile(url: string | undefined): LiteProfile | 'unsupported' | undefined {
  if (!url) return undefined
  let query: URLSearchParams
  try {
    query = new URL(url, 'ws://localhost').searchParams
  } catch {
    return undefined
  }
  if (query.get('profile') !== 'lite') return undefined
  const vRaw = query.get('v') ?? '1'
  const v = Number(vRaw)
  if (!Number.isInteger(v) || !(SUPPORTED_LITE_VERSIONS as readonly number[]).includes(v)) {
    return 'unsupported'
  }
  const maxFrameRaw = Number(query.get('maxFrameBytes'))
  const turnDeltaRaw = query.get('turnDelta')
  return {
    kind: 'lite',
    v,
    maxFrameBytes:
      Number.isInteger(maxFrameRaw) && maxFrameRaw >= 512 && maxFrameRaw <= 65536
        ? maxFrameRaw
        : 4096,
    turnDelta: turnDeltaRaw === '1' || turnDeltaRaw === 'true',
  }
}

/**
 * 发送 RPC Response（T7 旁路二收口）：lite 连接上先做传输层投影
 * （timeline.get/open 的 LeanTimelineNode 投影等），非 lite 原样直出。
 * 不改 handler 响应结构本身（serverNow/maxItems/node.get 等增强归 handler 侧）。
 */
function sendResponse(ws: WebSocket, response: RpcResponse): void {
  if (ws.readyState !== ws.OPEN) return
  const profile = connectionManager.get(ws)?.profile
  const out = profile ? applyLiteResponse(profile, response) : response
  ws.send(transport.serializeMessage(out))
}

/**
 * 发送错误
 */
function sendError(ws: WebSocket, message: string, requestId?: string): void {
  const response = createResponse(
    requestId || '',
    false,
    undefined,
    createError(ErrorCode.INTERNAL, message),
  )
  ws.send(transport.serializeMessage(response))
}

/**
 * 关闭所有 WebSocket 连接（应用关闭时调用）。
 * WebSocketServer.close() 只停止接受新连接，不关闭现有连接。
 * 需先调用本函数关闭所有客户端，再调用 wss.close()。
 */
export function closeAllConnections(wss: WebSocketServer): void {
  wss.clients.forEach((ws) => {
    // 移除所有监听器，避免关闭时触发 close/error 事件处理
    ws.removeAllListeners()
    ws.close()
  })
}
