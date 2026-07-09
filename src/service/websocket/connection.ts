import type { WebSocket } from "ws";
import { randomUUID } from "crypto";
import { approvalManager } from "../approval/manager.js";
import { logger } from "@/utils/logger/index.js";
import { LogLevel } from "@/utils/logger/types.js";

/**
 * 待处理请求
 */
interface PendingRequest {
  approvalId?: string;
  /** 审批超时计时器（interrupt 发出后启动） */
  approvalTimeoutTimer?: NodeJS.Timeout;
  /** 审批超时时间（毫秒） */
  approvalTimeoutMs: number;
}

/**
 * 连接状态
 */
export interface ConnectionState {
  id: string;
  ws: WebSocket;
  pendingRequests: Map<string, PendingRequest>;
}

/**
 * 连接管理器
 */
export class ConnectionManager {
  private connections = new Map<WebSocket, ConnectionState>();
  /** chatId → connectionId：同 chat 活跃流期间绑定，拒绝跨连接并发（P0-3） */
  private activeChatConnections = new Map<string, string>();
  /** 审批超时时间（默认 15 分钟） */
  private defaultApprovalTimeout = 900000;

  /**
   * 创建连接状态
   */
  create(ws: WebSocket): ConnectionState {
    const state: ConnectionState = {
      id: randomUUID(),
      ws,
      pendingRequests: new Map(),
    };
    this.connections.set(ws, state);
    return state;
  }

  /**
   * 获取连接状态
   */
  get(ws: WebSocket): ConnectionState | undefined {
    return this.connections.get(ws);
  }

  /**
   * 添加待处理请求
   */
  addPendingRequest(
    ws: WebSocket,
    requestId: string,
    approvalTimeoutMs?: number,
  ): PendingRequest {
    const state = this.connections.get(ws);
    if (!state) {
      logger.event("conn.notfound", { available: this.connections.size }, LogLevel.error);
      throw new Error("Connection not found");
    }

    const pending: PendingRequest = {
      approvalTimeoutMs: approvalTimeoutMs || this.defaultApprovalTimeout,
    };

    state.pendingRequests.set(requestId, pending);
    return pending;
  }

  /**
   * 设置请求的审批 ID（同时启动审批超时）
   */
  setRequestApprovalId(
    ws: WebSocket,
    requestId: string,
    approvalId: string,
  ): void {
    const state = this.connections.get(ws);
    if (!state) return;

    const pending = state.pendingRequests.get(requestId);
    if (pending) {
      pending.approvalId = approvalId;
    }
  }

  /**
   * 启动审批超时计时器（interrupt 发出后调用）
   */
  startApprovalTimeout(
    ws: WebSocket,
    requestId: string,
    onTimeout: () => void,
  ): void {
    const state = this.connections.get(ws);
    if (!state) return;

    const pending = state.pendingRequests.get(requestId);
    if (pending && !pending.approvalTimeoutTimer) {
      pending.approvalTimeoutTimer = setTimeout(() => {
        onTimeout();
      }, pending.approvalTimeoutMs);
    }
  }

  /**
   * 清除审批超时计时器（审批通过后调用）
   */
  clearApprovalTimeout(ws: WebSocket, requestId: string): void {
    const state = this.connections.get(ws);
    if (!state) return;

    const pending = state.pendingRequests.get(requestId);
    if (pending?.approvalTimeoutTimer) {
      clearTimeout(pending.approvalTimeoutTimer);
      pending.approvalTimeoutTimer = undefined;
    }
  }

  /**
   * 移除待处理请求
   */
  removePendingRequest(ws: WebSocket, requestId: string): void {
    const state = this.connections.get(ws);
    if (!state) return;

    const pending = state.pendingRequests.get(requestId);
    if (pending) {
      this.clearApprovalTimeout(ws, requestId);
      state.pendingRequests.delete(requestId);
    }
  }

  /**
   * 绑定 chatId 到 connection（同 chat 活跃流期间拒绝其他连接并发 send/resume，P0-3）
   * @throws Error 若 chatId 已被其他活跃 connection 绑定
   */
  bindChatConnection(chatId: string, connectionId: string): void {
    const owner = this.activeChatConnections.get(chatId);
    if (owner && owner !== connectionId) {
      throw new Error(`Chat "${chatId}" is busy (active on another connection)`);
    }
    this.activeChatConnections.set(chatId, connectionId);
  }

  /**
   * 释放 chatId 绑定（仅当 connectionId 匹配才解绑，避免误释放后绑定的 owner）
   */
  releaseChatConnection(chatId: string, connectionId: string): void {
    if (this.activeChatConnections.get(chatId) === connectionId) {
      this.activeChatConnections.delete(chatId);
    }
  }

  /**
   * 强制释放 chatId 绑定（不校验 owner）。
   * chat.abort 场景：跨连接重连后旧 owner 仍占用绑定，校验 owner 会清不掉导致 busy 死锁，
   * abort 是清内存操作，须无条件解绑。
   */
  forceReleaseChatConnection(chatId: string): void {
    this.activeChatConnections.delete(chatId);
  }

  /**
   * 按 chatId 反查所属 ws（spawnBroker 推 subagent_created notification 用）。
   * 通过 activeChatConnections 找 connectionId，再在 connections 反查 ws。
   * 主 chat 流活跃期间 chatId 一定有绑定（chat.send/resume 入口 bindChatConnection）。
   * @returns 所属 ws；未绑定或已断开返回 undefined
   */
  findWsByChatId(chatId: string): WebSocket | undefined {
    const connId = this.activeChatConnections.get(chatId);
    if (!connId) return undefined;
    for (const state of this.connections.values()) {
      if (state.id === connId) return state.ws;
    }
    return undefined;
  }

  /**
   * 关闭连接（持久化 pending approvals）
   */
  async close(ws: WebSocket): Promise<void> {
    const state = this.connections.get(ws);
    if (!state) return;

    logger.event("conn.closing", { pendingRequests: state.pendingRequests.size }, LogLevel.debug);

// 终止所有 pending requests 的 generator
    for (const [, pending] of state.pendingRequests) {
      // 不调 gen.return()：await 态（审批/LLM stream）无法立即终止；
      // 且 return 传播与 senseMiddleware catch 的 yield 交互会导致链条死锁——
      // generator suspended 在 return completion 下的 yield，外层 checkpoint/observer finally
      // 永不执行，assistant 无法落库（恢复回滚失效）。改靠下方 abort reject 让 senseMiddleware
      // 正常 catch 结束，链条自然 done，finally 正常执行。

      // 中止 pending approval：调用 reject 解除 senseMiddleware 的 await Promise.all，
      // 使挂起 generator 正常结束可被 GC（P0-1）。pending sense 保持 NULL 待重连 chat.resume。
      if (pending.approvalId) {
        approvalManager.abort(pending.approvalId);
      }

      // 清除审批超时
      if (pending.approvalTimeoutTimer) {
        clearTimeout(pending.approvalTimeoutTimer);
      }
    }

// 释放该 connection 绑定的所有 chatId（P0-3）
for (const [chatId, connId] of this.activeChatConnections) {
  if (connId === state.id) {
    this.activeChatConnections.delete(chatId);
  }
}

this.connections.delete(ws);
}

  /**
   * 获取所有连接
   */
  getAll(): ConnectionState[] {
    return Array.from(this.connections.values());
  }
}

/**
 * 导出连接管理器实例
 */
export const connectionManager = new ConnectionManager();