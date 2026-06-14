/**
 * Approval Registry（P1-11：core 层审批 Promise 管理，解耦 core↔service）。
 *
 * 原设计：SenseTriggerChunk/SensePendingChunk 携带 approvalResolve/approvalReject 函数指针，
 * core middleware 依赖 service 层 ApprovalManager 的回调 —— 分层违反。
 *
 * 解耦后：core（senseMiddleware）在此 registry 创建审批 Promise 并 await；
 * chunk 只产 {approvalId, needsApproval} 事实；service ApprovalManager 通过
 * resolveApproval/rejectApproval 触发对应 Promise，结果经独立 channel 回填到 await。
 */
export type ApprovalDecision = {
  action: "accept" | "reject";
  reason?: string;
};

interface PendingApproval {
  resolve: (decision: ApprovalDecision) => void;
  reject: (error: Error) => void;
}

const registry = new Map<string, PendingApproval>();

/**
 * 创建审批 Promise 并注册 resolve/reject（core senseMiddleware 调用）。
 * @returns senseMiddleware await 的 Promise；service confirm/abort 触发其 resolve/reject
 */
export function createApproval(id: string): Promise<ApprovalDecision> {
  return new Promise<ApprovalDecision>((resolve, reject) => {
    registry.set(id, { resolve, reject });
  });
}

/**
 * 确认审批（service ApprovalManager.confirm 调用）：resolve senseMiddleware 的 await Promise。
 */
export function resolveApproval(
  id: string,
  action: "accept" | "reject",
  reason?: string,
): void {
  const entry = registry.get(id);
  if (entry) {
    entry.resolve({ action, reason });
    registry.delete(id);
  }
}

/**
 * 中止审批（service ApprovalManager.abort 调用）：reject senseMiddleware 的 await Promise，
 * 解除 await 使挂起 generator 正常结束可被 GC。
 */
export function rejectApproval(id: string, error: Error): void {
  const entry = registry.get(id);
  if (entry) {
    entry.reject(error);
    registry.delete(id);
  }
}
