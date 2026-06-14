interface PendingApproval {
  resolve: (action: "accept" | "reject", reason?: string) => void;
  reject: (err: Error) => void;
}

/**
 * 审批管理器（极简版）
 * 只存储 resolve/reject 回调，无数据库持久化
 */
export class ApprovalManager {
  private approvals = new Map<string, PendingApproval>();

  /**
   * 注册审批 resolve + reject（service 层使用）
   */
  register(
    approvalId: string,
    resolve: (action: "accept" | "reject", reason?: string) => void,
    reject: (err: Error) => void,
  ): void {
    this.approvals.set(approvalId, { resolve, reject });
  }

  /**
   * 确认审批（调用 resolve）
   */
  confirm(
    approvalId: string,
    action: "accept" | "reject",
    reason?: string,
  ): void {
    const approval = this.approvals.get(approvalId);
    if (approval) {
      approval.resolve(action, reason);
      this.approvals.delete(approvalId);
    }
  }

  /**
   * 中止审批：调用 reject 解除 senseMiddleware 的 await Promise.all，
   * 使挂起 generator 正常结束可被 GC（替代旧 remove 仅删 Map 依赖 GC 的不可靠方案）。
   * pending sense 在 DB 保持 content=NULL，重启后 chat.get 判定 canResume=true，
   * 前端可走 chat.resume 撤回重跑。reject 后 generator catch 并 yield sense_reject，不写 content，pending 语义不变。
   */
  abort(approvalId: string): void {
    const approval = this.approvals.get(approvalId);
    if (approval) {
      approval.reject(new Error("approval aborted"));
      this.approvals.delete(approvalId);
    }
  }

  /**
   * 获取 pending approvals（仅内存中）
   */
  getPendingApprovals(): string[] {
    return Array.from(this.approvals.keys());
  }

  /**
   * 按 approvalId 判断是否存在（仅内存中）
   */
  getApproval(approvalId: string): boolean {
    return this.approvals.has(approvalId);
  }
}

export const approvalManager = new ApprovalManager();