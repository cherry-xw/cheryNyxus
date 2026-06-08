import type { WebSocket } from "ws";
import { randomUUID } from "crypto";
import type { ApprovalEntity } from "@/db/approval.js";
import { approvalRepo } from "@/db/approval.js";
import { approvalManager } from "@/service/approval/manager.js";

/**
 * 待处理请求
 */
interface PendingRequest {
  requestId: string;
  startTime: number;
  generator?: AsyncGenerator;
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
  soulId?: string;
  pendingRequests: Map<string, PendingRequest>;
}

/**
 * 连接管理器
 */
export class ConnectionManager {
  private connections = new Map<WebSocket, ConnectionState>();
  /** 审批超时时间（默认 15 分钟） */
  private defaultApprovalTimeout = 900000;

  /**
   * 创建连接状态
   */
  create(ws: WebSocket): ConnectionState {
    const state: ConnectionState = {
      id: randomUUID(),
      ws,
      soulId: undefined,
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
   * 设置 soul
   */
  setSoul(ws: WebSocket, soulId: string): void {
    const state = this.connections.get(ws);
    if (state) {
      state.soulId = soulId;
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
        console.log(`审批超时触发: requestId=${requestId}, approvalId=${pending.approvalId}`);
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
   * 关闭连接（持久化 pending approvals）
   */
  async close(ws: WebSocket): Promise<void> {
    const state = this.connections.get(ws);
    if (!state) return;

    console.log(`关闭连接: ${state.id}, pendingRequests=${state.pendingRequests.size}`);

    // 持久化未完成的审批
    for (const [requestId, pending] of state.pendingRequests) {
      if (pending.approvalId) {
        await approvalRepo.update(pending.approvalId, {
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

    // 清理 soul 的所有 pending approvals
    if (state.soulId) {
      await approvalManager.cleanupSoul(state.soulId);
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
   * 按 soulId 获取连接
   */
  getBySoulId(soulId: string): ConnectionState | undefined {
    for (const state of this.connections.values()) {
      if (state.soulId === soulId) {
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