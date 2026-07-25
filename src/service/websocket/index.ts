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
import { isAsyncGenerator } from '@/utils/generator.js'
import { logger } from '@/utils/logger/index.js'
import { LogLevel } from '@/utils/logger/types.js'
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
function sendChatEvent(ws: WebSocket, item: unknown): void {
  if (ws.readyState !== ws.OPEN) {
    logger.event('ws.event.skipped', { reason: 'socket-closed' })
    return
  }
  try {
    ws.send(transport.encode(item as Parameters<typeof transport.encode>[0]))
  } catch (err) {
    logger.event('ws.event.failed', { message: (err as Error).message }, 3)
  }
}

/**
 * 解析实时输出目标 ws：chat.attach 重定向命中（按 event.chatId）→ 新连接 ws；否则回落启动 run 的捕获 ws。
 * 使刷新后新连接能接管仍在运行的 run 的后续 chunk/notification（含终态 done/error）。
 */
function resolveOutputWs(item: { chatId?: string }, fallbackWs: WebSocket): WebSocket {
  if (item.chatId) {
    const redirected = connectionManager.getLiveOutput(item.chatId)
    if (redirected) return redirected
  }
  return fallbackWs
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

  wss.on('connection', (ws) => {
    const state = connectionManager.create(ws)
    logger.run({ connectionId: state.id }, () => logger.event('conn.open'))

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
    if (ws.readyState === ws.OPEN) ws.send(transport.serializeMessage(response))
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
      if (ws.readyState === ws.OPEN) ws.send(transport.serializeMessage(response))
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
    if (ws.readyState === ws.OPEN) ws.send(transport.serializeMessage(interrupted))
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
              sendChatEvent(resolveOutputWs(item, ws), item)
              continue
            }

            // Chunk 消息
            sendChatEvent(resolveOutputWs(item, ws), item)
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
    if (ws.readyState === ws.OPEN) ws.send(transport.serializeMessage(response))
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
