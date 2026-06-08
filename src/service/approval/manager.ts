import type { MiddlewareContext, SenseTriggerChunk } from "@/core/middleware/types.js";
import { approvalRepo, type ApprovalEntity, type ApprovalSenseCall } from "@/db/approval.js";

/**
 * 待处理审批条目（简化版）
 * approvalId 直接使用 trigger.id
 */
export interface PendingApprovalEntry {
  approvalId: string;
  soulId: string;
  chatId: string;
  sc: ApprovalSenseCall;
  createdAt: number;
  /** 审批 resolve 函数（confirm/manual 时使用，用于通知 generator 继续执行） */
  approvalResolve?: ((action: "accept" | "reject", reason?: string) => void) | null;
}

/**
 * 审批管理器（简化版）
 */
export class ApprovalManager {
  private pendingApprovals = new Map<string, PendingApprovalEntry>();

  /**
   * 从 sense_trigger 注册审批（service 层使用）
   * 不需要完整 ctx，从 trigger 提取信息
   */
  registerFromTrigger(
    trigger: SenseTriggerChunk,
    soulId: string,
    chatId: string,
  ): Promise<void> {
    const approvalId = trigger.id;
    const createdAt = Date.now();

    // 存储 approvalResolve
    this.pendingApprovals.set(approvalId, {
      approvalId,
      soulId,
      chatId,
      sc: {
        id: trigger.id,
        name: trigger.name,
        arguments: trigger.arguments,
        approved: false,
        triggeredAt: createdAt,
      },
      createdAt,
      approvalResolve: trigger.approvalResolve,
    });

    return this.persistRuntimeApproval(approvalId, soulId, chatId, trigger, createdAt);
  }

  /**
   * 创建单个感官审批（middleware 层使用）
   */
  async createSingleApproval(
    ctx: MiddlewareContext,
    trigger: SenseTriggerChunk,
  ): Promise<string> {
    const approvalId = trigger.id;

    const entity: ApprovalEntity = {
      id: approvalId,
      chatId: ctx.soul.chatId,
      soulId: ctx.soul.soulId,
      status: "pending",
      senseCalls: [{
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

    await approvalRepo.create(entity);

    this.pendingApprovals.set(approvalId, {
      approvalId,
      soulId: ctx.soul.soulId,
      chatId: ctx.soul.chatId,
      sc: entity.senseCalls[0]!,
      createdAt: entity.createdAt,
      approvalResolve: trigger.approvalResolve,
    });

    return approvalId;
  }

  /**
   * 获取 pending approvals
   */
  getPendingApprovals(): PendingApprovalEntry[] {
    return Array.from(this.pendingApprovals.values());
  }

  /**
   * 按 approvalId 获取 approval
   */
  getApproval(approvalId: string): PendingApprovalEntry | undefined {
    return this.pendingApprovals.get(approvalId);
  }

  /**
   * 确认审批
   */
  async confirmApproval(
    approvalId: string,
    action: "accept" | "reject",
    reason?: string,
  ): Promise<void> {
    const entry = this.pendingApprovals.get(approvalId);
    if (!entry) {
      const approval = await approvalRepo.findById(approvalId);
      if (approval && approval.status === "pending") {
        await approvalRepo.update(approvalId, {
          status: "acknowledged",
          updatedAt: Date.now(),
        });
      }
      return;
    }

    // 调用 approvalResolve 通知 generator 继续执行
    if (entry.approvalResolve) {
      entry.approvalResolve(action, reason);
    }

    this.pendingApprovals.delete(approvalId);

    await approvalRepo.update(approvalId, {
      status: "acknowledged",
      updatedAt: Date.now(),
    });
  }

  /**
   * 清理 soul 的所有 pending approvals
   */
  async cleanupSoul(soulId: string): Promise<void> {
    const toDelete: string[] = [];

    for (const entry of this.pendingApprovals.values()) {
      if (entry.soulId === soulId) {
        toDelete.push(entry.approvalId);
        continue;
      }

      const approval = await approvalRepo.findById(entry.approvalId);
      if (approval?.soulId === soulId) {
        toDelete.push(entry.approvalId);
      }
    }

    for (const approvalId of toDelete) {
      this.pendingApprovals.delete(approvalId);
    }
  }

  /**
   * 恢复审批 handles（从数据库加载到内存）
   */
  async loadApprovalHandles(approvalId: string): Promise<PendingApprovalEntry[]> {
    const entity = await approvalRepo.findById(approvalId);
    if (!entity || entity.status !== "pending") {
      return [];
    }

    for (const sc of entity.senseCalls) {
      if (!this.pendingApprovals.has(approvalId)) {
        this.pendingApprovals.set(approvalId, {
          approvalId,
          soulId: entity.soulId,
          chatId: entity.chatId,
          sc,
          createdAt: entity.createdAt,
        });
      }
    }

    return this.getPendingApprovals().filter(h => h.approvalId === approvalId);
  }

  /**
   * 按 soulId 加载所有 pending approval handles
   */
  async loadSoulApprovals(soulId: string): Promise<PendingApprovalEntry[]> {
    const approvals = await approvalRepo.findBySoulId(soulId);
    const pendingApprovals = approvals.filter(a => a.status === "pending");

    for (const approval of pendingApprovals) {
      for (const sc of approval.senseCalls) {
        if (!this.pendingApprovals.has(approval.id)) {
          this.pendingApprovals.set(approval.id, {
            approvalId: approval.id,
            soulId: approval.soulId,
            chatId: approval.chatId,
            sc,
            createdAt: approval.createdAt,
          });
        }
      }
    }

    return this.getPendingApprovals().filter(h =>
      pendingApprovals.some(a => a.id === h.approvalId),
    );
  }

  /**
   * 标记审批完成
   */
  async completeApproval(approvalId: string): Promise<void> {
    await approvalRepo.update(approvalId, {
      status: "completed",
      updatedAt: Date.now(),
    });

    this.pendingApprovals.delete(approvalId);
  }

  /**
   * 创建上下文快照
   */
  private snapshotContext(ctx: MiddlewareContext): ApprovalEntity["contextSnapshot"] {
    return {
      messages: ctx.soul.messages ? JSON.stringify(ctx.soul.messages) : null,
      userInputs: ctx.soul.userInputs.slice(),
      brain: {
        provider: ctx.brain.provider ?? "",
        model: ctx.brain.model ?? "",
      },
    };
  }

  private async persistRuntimeApproval(
    approvalId: string,
    soulId: string,
    chatId: string,
    trigger: SenseTriggerChunk,
    createdAt: number,
  ): Promise<void> {
    const existing = await approvalRepo.findById(approvalId);
    if (existing) {
      await approvalRepo.update(approvalId, {
        status: "pending",
        updatedAt: Date.now(),
      });
      return;
    }

    await approvalRepo.create({
      id: approvalId,
      chatId,
      soulId,
      status: "pending",
      senseCalls: [{
        id: trigger.id,
        name: trigger.name,
        arguments: trigger.arguments,
        approved: false,
        triggeredAt: createdAt,
      }],
      contextSnapshot: null,
      createdAt,
      updatedAt: createdAt,
    });
  }
}

export const approvalManager = new ApprovalManager();
