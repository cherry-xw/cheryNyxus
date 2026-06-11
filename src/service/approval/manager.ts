/**
 * 审批管理器（极简版）
 * 只存储 approvalResolve 回调，无数据库持久化
 */
export class ApprovalManager {
  private approvalResolves = new Map<string, (action: "accept" | "reject", reason?: string) => void>();

  /**
   * 注册 approvalResolve（service 层使用）
   */
  register(
    approvalId: string,
    resolve: (action: "accept" | "reject", reason?: string) => void,
  ): void {
    this.approvalResolves.set(approvalId, resolve);
  }

  /**
   * 确认审批（调用 approvalResolve）
   */
  confirm(
    approvalId: string,
    action: "accept" | "reject",
    reason?: string,
  ): void {
    const resolve = this.approvalResolves.get(approvalId);
    if (resolve) {
      resolve(action, reason);
      this.approvalResolves.delete(approvalId);
    }
  }

  /**
   * 获取 pending approvals（仅内存中）
   */
  getPendingApprovals(): string[] {
    return Array.from(this.approvalResolves.keys());
  }

  /**
   * 按 approvalId 获取 approval（仅内存中）
   */
  getApproval(approvalId: string): boolean {
    return this.approvalResolves.has(approvalId);
  }
}

export const approvalManager = new ApprovalManager();