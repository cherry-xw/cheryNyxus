import type { WebSocket } from 'ws'
import { logger } from '@/utils/logger/index.js'
import config from '@/utils/config.js'

/**
 * 断连宽限调度器（见 docs/service/websocket.md「断连宽限」）。
 *
 * 监听 owner WebSocket 关闭事件：
 * - 宽限期内同 requestId 在新 ws 重连 → rebind output target，继续当前 loop，不暂停。
 * - 宽限期到期仍无新 owner → 标记当前 run 在“下一轮 loop 决策前”抛 AgentParkError
 *   （不直接 `builder.abort()`，等当前 `runChain()` 输出结束），pending approval 才 park。
 *
 * 状态机：
 * - `connected`：原 ws 持有，输出正常投递。
 * - `grace`：owner ws 断开，等待 `disconnect_grace_ms` 期间同 requestId 重连。
 * - `rebound`：同 requestId 在 grace 内被新 ws 接管，继续当前 loop。
 * - `stop_requested`：宽限期到期，调用 `requestParkAfterTurn`（有 pending approval 时再 park）。
 * - `paused`：当前 runChain 输出结束后在 loop 边界抛 park，由 service finally 释放资源。
 *
 * 注意：tracker 依赖 service 启动期被注入。模块级单例；不在多进程间共享。
 */
interface TrackedRun {
  chatId: string
  runId: string
  connectionId: string
  /**
   * 当前 generator 输出目标（WebSocket），重连可被 rebind。
   * 引用 connectionManager.connections 查到的 ConnectionState.ws。
   */
  outputWs: WebSocket | null
  state: 'connected' | 'grace' | 'rebound' | 'stop_requested' | 'paused'
  /**
   * owner ws 断开时间（performance.now()），用于日志；不再用于决策。
   */
  disconnectedAt?: number
  /**
   * 宽限期到期 timer；rebound/finished 时清除。
   */
  timer: NodeJS.Timeout | null
  /**
   * 注册时记录的 pending approvalId；宽限期到期时 park（不立即 park）。
   * 若无 pending approval 仅标记安全边界。
   */
  pendingApprovalId?: string
}

export interface DisconnectGraceDeps {
  /**
   * 标记该 chat/run 在“下一轮 loop 决策前”抛 AgentParkError。
   * 由 service 层根据 requestId 找到当前 AgentBuilder（runtime.ts ensureChat）后调用。
   */
  requestParkAfterTurn(chatId: string, runId: string): void
  /**
   * 让挂起的 approval 立即抛 AgentParkError（grace 期满仍有挂起审批）。
   * 由 approval manager.park 实现；与安全边界解耦。
   */
  parkApproval(approvalId: string): void
}

class DisconnectGrace {
  /** requestId → tracking */
  private readonly byRequest = new Map<string, TrackedRun>()
  /** connectionId → 该连接上的所有 tracking（close 时统一处理） */
  private readonly byConnection = new Map<string, Set<TrackedRun>>()
  private deps: DisconnectGraceDeps | null = null

  /** 注入依赖（service 启动期调用一次） */
  configure(deps: DisconnectGraceDeps): void {
    this.deps = deps
  }

  /**
   * 记录一个新启动的流式 RPC。handleRequest 入口确认 `claim.state === 'new'` 后调用。
   */
  track(args: {
    requestId: string
    chatId: string
    runId: string
    connectionId: string
    outputWs: WebSocket
  }): void {
    const run: TrackedRun = {
      chatId: args.chatId,
      runId: args.runId,
      connectionId: args.connectionId,
      outputWs: args.outputWs,
      state: 'connected',
      timer: null,
    }
    this.byRequest.set(args.requestId, run)
    let set = this.byConnection.get(args.connectionId)
    if (!set) {
      set = new Set()
      this.byConnection.set(args.connectionId, set)
    }
    set.add(run)
  }

  /**
   * rebind 跟踪条目到新 ws：用于同 requestId 在新 connection 接管（active join 分支）。
   * 不重启 grace timer；不写日志级别日志。
   */
  rebind(args: { requestId: string; connectionId: string; outputWs: WebSocket }): void {
    const run = this.byRequest.get(args.requestId)
    if (!run) return
    this.unlinkFromConnection(run)
    run.connectionId = args.connectionId
    run.outputWs = args.outputWs
    run.state = 'rebound'
    if (run.timer) {
      clearTimeout(run.timer)
      run.timer = null
    }
    let set = this.byConnection.get(args.connectionId)
    if (!set) {
      set = new Set()
      this.byConnection.set(args.connectionId, set)
    }
    set.add(run)
    logger.event('disconnect.grace.cancel', {
      chatId: run.chatId,
      runId: run.runId,
      newConnectionId: args.connectionId,
    })
    // next tick 回到 connected 便于后续状态稳定
    queueMicrotask(() => {
      if (this.byRequest.get(args.requestId) === run) run.state = 'connected'
    })
  }

  /**
   * 按 chatId rebind（chat.attach 用：F5 后新页面无原 requestId，只能按 chatId 找运行中 run）。
   * 找到 chatId 匹配的跟踪条目 → 复用 rebind 语义（迁移到新连接、取消 grace timer、状态 rebound）。
   * 子 run（startSpawn，params 无 chatId → 未 track）无匹配条目 → no-op；其输出重定向仅靠 liveOutputByChat。
   */
  rebindByChatId(chatId: string, connectionId: string, outputWs: WebSocket): void {
    for (const [requestId, run] of this.byRequest) {
      if (run.chatId === chatId) {
        this.rebind({ requestId, connectionId, outputWs })
      }
    }
  }

  /** 按 requestId 查跟踪条目的 chatId（同页重连 active-join 后设 liveOutput 重定向用）。 */
  getChatId(requestId: string): string | undefined {
    return this.byRequest.get(requestId)?.chatId
  }

  /**
   * 按 requestId 查当前 pending approvalId。
   * chat.abort 用：abort 在 approval.wait 挂起时，须先 rejectApproval 才能可靠中断
   * `await Promise.all`（gen.throw 注入外部 pending promise 不可靠，见 handleChatAbort）。
   * 无跟踪条目或无 pending approval → undefined。
   */
  getPendingApprovalId(requestId: string): string | undefined {
    return this.byRequest.get(requestId)?.pendingApprovalId
  }

  /**
   * 设置 pending approval（仅记录，宽限期到期才 park）。
   */
  setPendingApproval(requestId: string, approvalId: string | undefined): void {
    const run = this.byRequest.get(requestId)
    if (!run) return
    run.pendingApprovalId = approvalId
  }

  /**
   * owner ws 关闭：进入 grace。
   * 对每个 owned run：启动宽限 timer；不立即 park approval / 不 abort builder。
   * `connectionId` 可能在 close 之后被 connectionManager 移除，本方法不依赖 connectionMap。
   */
  onConnectionClosed(connectionId: string): void {
    const runs = this.byConnection.get(connectionId)
    if (!runs || runs.size === 0) return
    const delayMs = this.getDelayMs()
    for (const run of runs) {
      // 已处于 paused/rebound/stop_requested：跳过（避免重连后的 ws 关闭误触）
      if (run.state === 'paused' || run.state === 'rebound' || run.state === 'stop_requested') {
        continue
      }
      run.outputWs = null
      run.disconnectedAt = Date.now()
      if (delayMs <= 0) {
        // 0 = 不等待；同步进入 stop_requested
        this.expireRun(run)
        continue
      }
      run.state = 'grace'
      run.timer = setTimeout(() => this.expireRun(run), delayMs)
      logger.event('disconnect.grace.start', {
        connectionId,
        chatId: run.chatId,
        runId: run.runId,
        delayMs,
      })
    }
  }

  /**
   * 流式 RPC 正常结束（done / abort / error）后清理。
   */
  onRequestFinished(requestId: string): void {
    const run = this.byRequest.get(requestId)
    if (!run) return
    if (run.timer) {
      clearTimeout(run.timer)
      run.timer = null
    }
    this.unlinkFromConnection(run)
    this.byRequest.delete(requestId)
  }

  /**
   * 调试/观测：当前跟踪条目数。
   */
  size(): number {
    return this.byRequest.size
  }

  private unlinkFromConnection(run: TrackedRun): void {
    const set = this.byConnection.get(run.connectionId)
    if (set) {
      set.delete(run)
      if (set.size === 0) this.byConnection.delete(run.connectionId)
    }
  }

  private expireRun(run: TrackedRun): void {
    run.timer = null
    if (run.state === 'paused') return
    run.state = 'stop_requested'
    logger.event('disconnect.grace.expired', {
      chatId: run.chatId,
      runId: run.runId,
    })
    if (!this.deps) {
      // 依赖未注入（启动期不完整）：保守保留 run 状态，下次 onRequestFinished 清理
      return
    }
    if (run.pendingApprovalId) {
      // 仍有挂起审批：必须立即 park，否则 await 永远不解。
      try {
        this.deps.parkApproval(run.pendingApprovalId)
      } catch (err) {
        logger.event(
          'disconnect.park.approval.failed',
          { approvalId: run.pendingApprovalId, message: (err as Error).message },
          3,
        )
      }
      run.pendingApprovalId = undefined
    }
    // 标记安全边界：当前 runChain 结束后 loop 抛 AgentParkError
    try {
      this.deps.requestParkAfterTurn(run.chatId, run.runId)
    } catch (err) {
      logger.event(
        'disconnect.park.request.failed',
        { chatId: run.chatId, runId: run.runId, message: (err as Error).message },
        3,
      )
    }
  }

  private getDelayMs(): number {
    const v = config.global.disconnect_grace_ms
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      // 校验失败/缺省：15000。已废字段名（如 graceTimeoutMs）不识别。
      return 15000
    }
    return v
  }
}

export const disconnectGrace = new DisconnectGrace()
