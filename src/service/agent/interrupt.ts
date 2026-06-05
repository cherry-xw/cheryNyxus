import type { MiddlewareContext, ToolTriggerChunk } from "@/core/middleware/types.js";
import { interruptRepo, type InterruptEntity, type InterruptToolCall } from "@/db/interrupt.js";

/**
 * 待处理 Handle 条目（简化版）
 * interruptId 直接使用 trigger.id
 */
export interface PendingHandleEntry {
  interruptId: string;
  tc: InterruptToolCall;
  createdAt: number;
}

/**
 * 中断管理器（简化版）
 */
export class InterruptManager {
  private pendingHandles = new Map<string, PendingHandleEntry>();

  /**
   * 创建单个工具中断
   */
  async createSingleInterrupt(
    ctx: MiddlewareContext,
    trigger: ToolTriggerChunk,
  ): Promise<string> {
    const interruptId = trigger.id;

    const entity: InterruptEntity = {
      id: interruptId,
      threadId: ctx.session.threadId,
      sessionId: ctx.session.sessionId,
      status: "pending",
      toolCalls: [{
        id: trigger.id,
        name: trigger.name,
        arguments: trigger.arguments,
        approved: false,
        triggeredAt: Date.now(),
      }],
      contextSnapshot: this.snapshotContext(ctx),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await interruptRepo.create(entity);

    this.pendingHandles.set(interruptId, {
      interruptId,
      tc: entity.toolCalls[0]!,
      createdAt: entity.createdAt,
    });

    return interruptId;
  }

  /**
   * 获取 pending handles
   */
  getPendingHandles(): PendingHandleEntry[] {
    return Array.from(this.pendingHandles.values());
  }

  /**
   * 按 interruptId 获取 handle
   */
  getHandle(interruptId: string): PendingHandleEntry | undefined {
    return this.pendingHandles.get(interruptId);
  }

  /**
   * 确认中断
   */
  async confirmInterrupt(
    interruptId: string,
    action: "accept" | "reject",
    _reason?: string,
  ): Promise<void> {
    const entry = this.pendingHandles.get(interruptId);
    if (!entry) {
      const interrupt = await interruptRepo.findById(interruptId);
      if (interrupt && interrupt.status === "pending") {
        await interruptRepo.update(interruptId, {
          status: "acknowledged",
          updatedAt: Date.now(),
        });
      }
      return;
    }

    this.pendingHandles.delete(interruptId);

    await interruptRepo.update(interruptId, {
      status: "acknowledged",
      updatedAt: Date.now(),
    });
  }

  /**
   * 清理 session 的所有 pending handles
   */
  async cleanupSession(sessionId: string): Promise<void> {
    const toDelete: string[] = [];

    for (const entry of this.pendingHandles.values()) {
      const interrupt = await interruptRepo.findById(entry.interruptId);
      if (interrupt?.sessionId === sessionId) {
        toDelete.push(entry.interruptId);
      }
    }

    for (const interruptId of toDelete) {
      this.pendingHandles.delete(interruptId);
    }
  }

  /**
   * 恢复中断 handles（从数据库加载到内存）
   */
  async loadInterruptHandles(interruptId: string): Promise<PendingHandleEntry[]> {
    const entity = await interruptRepo.findById(interruptId);
    if (!entity || entity.status !== "pending") {
      return [];
    }

    for (const tc of entity.toolCalls) {
      if (!this.pendingHandles.has(interruptId)) {
        this.pendingHandles.set(interruptId, {
          interruptId,
          tc,
          createdAt: entity.createdAt,
        });
      }
    }

    return this.getPendingHandles().filter(h => h.interruptId === interruptId);
  }

  /**
   * 按 sessionId 加载所有 pending interrupt handles
   */
  async loadSessionInterrupts(sessionId: string): Promise<PendingHandleEntry[]> {
    const interrupts = await interruptRepo.findBySessionId(sessionId);
    const pendingInterrupts = interrupts.filter(i => i.status === "pending");

    for (const interrupt of pendingInterrupts) {
      for (const tc of interrupt.toolCalls) {
        if (!this.pendingHandles.has(interrupt.id)) {
          this.pendingHandles.set(interrupt.id, {
            interruptId: interrupt.id,
            tc,
            createdAt: interrupt.createdAt,
          });
        }
      }
    }

    return this.getPendingHandles().filter(h =>
      pendingInterrupts.some(i => i.id === h.interruptId),
    );
  }

  /**
   * 标记中断完成
   */
  async completeInterrupt(interruptId: string): Promise<void> {
    await interruptRepo.update(interruptId, {
      status: "completed",
      updatedAt: Date.now(),
    });

    this.pendingHandles.delete(interruptId);
  }

  /**
   * 创建上下文快照
   */
  private snapshotContext(ctx: MiddlewareContext): InterruptEntity["contextSnapshot"] {
    return {
      messages: ctx.session.messages ? JSON.stringify(ctx.session.messages) : null,
      userInputs: ctx.session.userInputs.slice(),
      aiServer: {
        provider: ctx.aiServer.provider ?? "",
        model: ctx.aiServer.model ?? "",
      },
    };
  }
}

export const interruptManager = new InterruptManager();