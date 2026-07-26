import type { WebSocket } from 'ws'
import { randomUUID } from 'crypto'
import { logger } from '@/utils/logger/index.js'
import { LogLevel } from '@/utils/logger/types.js'

/**
 * 待处理请求
 */
interface PendingRequest {
  approvalId?: string
}

/**
 * 连接状态
 */
export interface ConnectionState {
  id: string
  ws: WebSocket
  pendingRequests: Map<string, PendingRequest>
}

/**
 * 连接管理器
 */
export class ConnectionManager {
  private connections = new Map<WebSocket, ConnectionState>()
  /** chatId → 最近一次启动该 chat run 的 connectionId（仅供 eager spawn 取 fallback ws）。 */
  private activeChatConnections = new Map<string, string>()
  /**
   * chatId → connectionId：持久 owner 映射（T9 role_reply 唤醒通知用）。
   * bindChatConnection 同步设；releaseChatConnection **不清**（turn 结束仍记 owner，供后端 turn 后推 notification）；
   * 仅 connection.close / chat delete（forceReleaseChatConnection）清。
   */
  private chatOwnerConnections = new Map<string, Set<string>>()
  /**
   * chatId → 当前实时输出目标 ws。仅 chat.attach（F5 重连运行中 run）写入、run 结束清除；
   * 平时为空。流式循环发送时用 `getLiveOutput(item.chatId) ?? 捕获 ws` 解析目标，
   * 使刷新后新连接能接管仍在运行的 run 的后续 chunk/notification（含终态 done/error）。
   * 按 chatId 寻址（非 requestId）：startSpawn 子 run params 无 chatId、不被 disconnectGrace 跟踪，
   * 仍可经此统一重定向。
   */
  private liveOutputByChat = new Map<string, Set<WebSocket>>()

  /**
   * 创建连接状态
   */
  create(ws: WebSocket): ConnectionState {
    const state: ConnectionState = {
      id: randomUUID(),
      ws,
      pendingRequests: new Map(),
    }
    this.connections.set(ws, state)
    return state
  }

  /**
   * 获取连接状态
   */
  get(ws: WebSocket): ConnectionState | undefined {
    return this.connections.get(ws)
  }

  /**
   * 添加待处理请求
   */
  addPendingRequest(ws: WebSocket, requestId: string): PendingRequest {
    const state = this.connections.get(ws)
    if (!state) {
      logger.event('conn.notfound', { available: this.connections.size }, LogLevel.error)
      throw new Error('连接丢了，请重连')
    }

    const pending: PendingRequest = {}

    state.pendingRequests.set(requestId, pending)
    return pending
  }

  /**
   * 设置请求的审批 ID（供 close(ws) 时 park 该审批）
   */
  setRequestApprovalId(ws: WebSocket, requestId: string, approvalId: string): void {
    const state = this.connections.get(ws)
    if (!state) return

    const pending = state.pendingRequests.get(requestId)
    if (pending) {
      pending.approvalId = approvalId
    }
  }

  /**
   * 移除待处理请求
   */
  removePendingRequest(ws: WebSocket, requestId: string): void {
    const state = this.connections.get(ws)
    if (!state) return

    state.pendingRequests.delete(requestId)
  }

  /**
   * 绑定运行发起者，并将连接加入该 chat 的实时订阅集合。
   * 多页面可以同时控制；具体审批/问答/abort 的首个有效请求由各自服务端状态机原子仲裁。
   */
  bindChatConnection(chatId: string, connectionId: string): void {
    this.activeChatConnections.set(chatId, connectionId)
    this.subscribeChat(chatId, connectionId)
  }

  /**
   * 释放 chatId 绑定（仅当 connectionId 匹配才解绑，避免误释放后绑定的 owner）
   */
  releaseChatConnection(chatId: string, connectionId: string): void {
    if (this.activeChatConnections.get(chatId) === connectionId) {
      this.activeChatConnections.delete(chatId)
    }
  }

  /**
   * 强制释放 chatId 绑定（不校验 owner）。
   * chat.abort 场景：跨连接重连后旧 owner 仍占用绑定，校验 owner 会清不掉导致 busy 死锁，
   * abort 是清内存操作，须无条件解绑。
   */
  forceReleaseChatConnection(chatId: string): void {
    this.activeChatConnections.delete(chatId)
    this.chatOwnerConnections.delete(chatId)
    this.liveOutputByChat.delete(chatId)
  }

  /**
   * 持久 owner 反查（T9 role_reply 唤醒通知用）。
   * 与 findWsByChatId 区别：activeChatConnections turn 结束即释放；chatOwnerConnections 持续到连接关闭/chat 删除。
   * 主 turn 已结束（activeChatConnections 已释放）时仍可据此推送 role_reply notification。
   * @returns owner 所属 ws；未绑定或已断开返回 undefined
   */
  findOwnerWsByChatId(chatId: string): WebSocket | undefined {
    return this.getChatOutputs(chatId)[0]
  }

  /**
   * 按 chatId 反查所属 ws（spawnBroker 推 role_created notification 用）。
   * 通过 activeChatConnections 找 connectionId，再在 connections 反查 ws。
   * 主 chat 流活跃期间 chatId 一定有绑定（chat.send/resume 入口 bindChatConnection）。
   * @returns 所属 ws；未绑定或已断开返回 undefined
   */
  findWsByChatId(chatId: string): WebSocket | undefined {
    const connId = this.activeChatConnections.get(chatId)
    if (!connId) return undefined
    for (const state of this.connections.values()) {
      if (state.id === connId) return state.ws
    }
    return undefined
  }

  /**
   * 按 connectionId 反查 ws（chat.attach 用：handler 只有 ctx.connectionId，需拿 ws 设为实时输出目标）。
   * @returns 所属 ws；未找到返回 undefined
   */
  getWsByConnectionId(connectionId: string): WebSocket | undefined {
    for (const state of this.connections.values()) {
      if (state.id === connectionId) return state.ws
    }
    return undefined
  }

  /** 将连接加入 chat 的实时事件订阅（运行中 attach 与 idle chat 订阅共用）。 */
  subscribeChat(chatId: string, connectionId: string): void {
    const ws = this.getWsByConnectionId(connectionId)
    if (!ws) return
    let owners = this.chatOwnerConnections.get(chatId)
    if (!owners) {
      owners = new Set()
      this.chatOwnerConnections.set(chatId, owners)
    }
    owners.add(connectionId)
    let outputs = this.liveOutputByChat.get(chatId)
    if (!outputs) {
      outputs = new Set()
      this.liveOutputByChat.set(chatId, outputs)
    }
    outputs.add(ws)
  }

  /** chat.attach 命中运行中 run：兼容旧调用，语义改为加入订阅而非抢占。 */
  setLiveOutput(chatId: string, ws: WebSocket): void {
    const state = this.connections.get(ws)
    if (state) this.subscribeChat(chatId, state.id)
  }

  /** 返回所有仍 OPEN 的订阅者；没有订阅者时保留运行发起 ws 作为 fallback。 */
  getChatOutputs(chatId: string, fallbackWs?: WebSocket): WebSocket[] {
    const targets = new Set<WebSocket>()
    for (const ws of this.liveOutputByChat.get(chatId) ?? []) {
      if (ws.readyState === ws.OPEN) targets.add(ws)
    }
    if (fallbackWs && fallbackWs.readyState === fallbackWs.OPEN) targets.add(fallbackWs)
    return [...targets]
  }

  /** run 结束不清订阅；连接关闭时才移除，以接收后续 role_reply 等 chat 事件。 */
  clearLiveOutput(chatId: string): void {
    void chatId
  }

  /**
   * 关闭连接（持久化 pending approvals）
   */
  async close(ws: WebSocket): Promise<void> {
    const state = this.connections.get(ws)
    if (!state) return

    logger.event('conn.closing', { pendingRequests: state.pendingRequests.size }, LogLevel.debug)

    // 不在此处 park 挂起审批 / 不 abort generator：disconnectGrace 拥有断连生命周期（G1 改造C）。
    // 宽限期（disconnect_grace_ms）内 approval Promise 存活、generator 悬挂——同 requestId 重连
    // 或 chat.attach 按 chatId 重连即迁移输出目标继续当前 loop（含用原 approvalId 审批续跑）；
    // 宽限期到期 disconnectGrace.expireRun 才 requestParkAfterTurn + parkApproval（service 启动期注入式 deps）。
    // 不调 gen.return()：与 senseMiddleware catch 的 yield 交互会致链条死锁（详见 disconnectGrace 注释）。
    // pendingRequests Map 随下方 connections.delete(ws) 一并释放，无需逐项清理。

    // 释放该 connection 绑定的所有 chatId（P0-3）
    for (const [chatId, connId] of this.activeChatConnections) {
      if (connId === state.id) {
        this.activeChatConnections.delete(chatId)
      }
    }
    // T9：同步清持久 owner（连接关闭 → 该连接 owner 的 chat 不再可达）
    for (const [chatId, owners] of this.chatOwnerConnections) {
      owners.delete(state.id)
      if (owners.size === 0) this.chatOwnerConnections.delete(chatId)
    }
    // 清实时输出重定向：本连接是某 chat 的 attach 目标 → 移除（下次 sendChatEvent 回落捕获 ws / 被跳过）
    for (const [chatId, targets] of this.liveOutputByChat) {
      targets.delete(ws)
      if (targets.size === 0) this.liveOutputByChat.delete(chatId)
    }

    this.connections.delete(ws)
  }

  /**
   * 获取所有连接
   */
  getAll(): ConnectionState[] {
    return Array.from(this.connections.values())
  }
}

/**
 * 导出连接管理器实例
 */
export const connectionManager = new ConnectionManager()
