import type { WebSocket } from "ws";
import { randomUUID } from "crypto";
import type { InterruptEntity } from "@/db/interrupt.js";
import { interruptRepo } from "@/db/interrupt.js";
import { interruptManager } from "@/service/agent/interrupt.js";

/**
 * 待处理请求
 */
interface PendingRequest {
  requestId: string;
  startTime: number;
  generator?: AsyncGenerator;
  interruptId?: string;
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
  sessionId?: string;
  pendingRequests: Map<string, PendingRequest>;
}

/**
 * 连接管理器
 */
export class ConnectionManager {
  private connections = new Map<WebSocket, ConnectionState>();
  /** 审批超时时间（默认 5 分钟） */
  private defaultApprovalTimeout = 300000;

  /**
   * 创建连接状态
   */
  create(ws: WebSocket): ConnectionState {
    const state: ConnectionState = {
      id: randomUUID(),
      ws,
      sessionId: undefined,
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
   * 设置 session
   */
  setSession(ws: WebSocket, sessionId: string): void {
    const state = this.connections.get(ws);
    if (state) {
      state.sessionId = sessionId;
    }
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
      console.error(`Connection not found for ws, available connections: ${this.connections.size}`);
      throw new Error("Connection not found");
    }

    const pending: PendingRequest = {
      requestId,
      startTime: Date.now(),
      approvalTimeoutMs: approvalTimeoutMs || this.defaultApprovalTimeout,
    };

    state.pendingRequests.set(requestId, pending);
    return pending;
  }

  /**
   * 设置请求的 generator
   */
  setRequestGenerator(
    ws: WebSocket,
    requestId: string,
    generator: AsyncGenerator,
  ): void {
    const state = this.connections.get(ws);
    if (!state) return;

    const pending = state.pendingRequests.get(requestId);
    if (pending) {
      pending.generator = generator;
    }
  }

  /**
   * 设置请求的中断 ID（同时启动审批超时）
   */
  setRequestInterruptId(
    ws: WebSocket,
    requestId: string,
    interruptId: string,
  ): void {
    const state = this.connections.get(ws);
    if (!state) return;

    const pending = state.pendingRequests.get(requestId);
    if (pending) {
      pending.interruptId = interruptId;
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
        console.log(`审批超时触发: requestId=${requestId}, interruptId=${pending.interruptId}`);
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
   * 关闭连接（持久化 pending interrupts）
   */
  async close(ws: WebSocket): Promise<void> {
    const state = this.connections.get(ws);
    if (!state) return;

    console.log(`关闭连接: ${state.id}, pendingRequests=${state.pendingRequests.size}`);

    // 持久化未完成的中断
    for (const [requestId, pending] of state.pendingRequests) {
      if (pending.interruptId) {
        await interruptRepo.update(pending.interruptId, {
          status: "pending",
          updatedAt: Date.now(),
        });
      }

      // 终止 generator
      if (pending.generator) {
        pending.generator.return(undefined);
      }

      // 清除审批超时
      if (pending.approvalTimeoutTimer) {
        clearTimeout(pending.approvalTimeoutTimer);
      }
    }

    // 清理 session 的所有 pending handles
    if (state.sessionId) {
      await interruptManager.cleanupSession(state.sessionId);
    }

    this.connections.delete(ws);
    console.log(`连接已从 Map 删除: ${state.id}, 剩余连接数: ${this.connections.size}`);
  }

  /**
   * 获取所有连接
   */
  getAll(): ConnectionState[] {
    return Array.from(this.connections.values());
  }

  /**
   * 按 sessionId 获取连接
   */
  getBySessionId(sessionId: string): ConnectionState | undefined {
    for (const state of this.connections.values()) {
      if (state.sessionId === sessionId) {
        return state;
      }
    }
    return undefined;
  }
}

/**
 * 导出连接管理器实例
 */
export const connectionManager = new ConnectionManager();