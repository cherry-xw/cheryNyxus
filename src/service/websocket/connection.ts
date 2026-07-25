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
  /** chatId → connectionId：同 chat 活跃流期间绑定，拒绝跨连接并发（P0-3） */
  private activeChatConnections = new Map<string, string>()
  /**
   * chatId → connectionId：持久 owner 映射（T9 role_reply 唤醒通知用）。
   * bindChatConnection 同步设；releaseChatConnection **不清**（turn 结束仍记 owner，供后端 turn 后推 notification）；
   * 仅 connection.close / chat delete（forceReleaseChatConnection）清。
   */
  private chatOwnerConnections = new Map<string, string>()
  /**
   * chatId → 当前实时输出目标 ws。仅 chat.attach（F5 重连运行中 run）写入、run 结束清除；
   * 平时为空。流式循环发送时用 `getLiveOutput(item.chatId) ?? 捕获 ws` 解析目标，
   * 使刷新后新连接能接管仍在运行的 run 的后续 chunk/notification（含终态 done/error）。
   * 按 chatId 寻址（非 requestId）：startSpawn 子 run params 无 chatId、不被 disconnectGrace 跟踪，
   * 仍可经此统一重定向。
   */
  private liveOutputByChat = new Map<string, WebSocket>()

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
   * 绑定 chatId 到 connection（同 chat 活跃流期间拒绝其他连接并发 send/resume，P0-3）
   * @throws Error 若 chatId 已被其他活跃 connection 绑定
   */
  bindChatConnection(chatId: string, connectionId: string): void {
    const owner = this.activeChatConnections.get(chatId)
    if (owner && owner !== connectionId) {
      throw new Error('这个会话正在别处使用')
    }
    this.activeChatConnections.set(chatId, connectionId)
    // T9：同步记持久 owner（turn 结束 activeChatConnections 释放后，role_reply 仍可反查推送）
    this.chatOwnerConnections.set(chatId, connectionId)
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
  }

  /**
   * 持久 owner 反查（T9 role_reply 唤醒通知用）。
   * 与 findWsByChatId 区别：activeChatConnections turn 结束即释放；chatOwnerConnections 持续到连接关闭/chat 删除。
   * 主 turn 已结束（activeChatConnections 已释放）时仍可据此推送 role_reply notification。
   * @returns owner 所属 ws；未绑定或已断开返回 undefined
   */
  findOwnerWsByChatId(chatId: string): WebSocket | undefined {
    const connId = this.chatOwnerConnections.get(chatId)
    if (!connId) return undefined
    for (const state of this.connections.values()) {
      if (state.id === connId) return state.ws
    }
    return undefined
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

  /** chat.attach 命中运行中 run：重定向该 chat 后续实时输出到指定 ws。 */
  setLiveOutput(chatId: string, ws: WebSocket): void {
    this.liveOutputByChat.set(chatId, ws)
  }

  /** 流式循环解析实时输出目标（无重定向 → undefined，调用方回落捕获 ws）。 */
  getLiveOutput(chatId: string): WebSocket | undefined {
    return this.liveOutputByChat.get(chatId)
  }

  /** run 结束清除重定向（send/resume/startSpawn finally 调用）。 */
  clearLiveOutput(chatId: string): void {
    this.liveOutputByChat.delete(chatId)
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
    for (const [chatId, connId] of this.chatOwnerConnections) {
      if (connId === state.id) {
        this.chatOwnerConnections.delete(chatId)
      }
    }
    // 清实时输出重定向：本连接是某 chat 的 attach 目标 → 移除（下次 sendChatEvent 回落捕获 ws / 被跳过）
    for (const [chatId, target] of this.liveOutputByChat) {
      if (target === ws) {
        this.liveOutputByChat.delete(chatId)
      }
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
