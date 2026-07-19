import { resolveApproval, rejectApproval } from '@/core/sense/approvalRegistry.js'
import { AgentAbortError } from '@/core/middleware/errors.js'

/**
 * 审批管理器（极简版）
 *
 * P1-11：不再存 resolve/reject 函数指针（解耦 core）。core 审批 Promise 由 approvalRegistry 管理，
 * 本 manager 仅记录待审批 id；confirm/abort 转调 core registry 触发 senseMiddleware 的 await Promise。
 * 无数据库持久化（pending sense 靠 messages.content 空判断，见 interaction.md）。
 */
export class ApprovalManager {
  private approvals = new Set<string>()

  /**
   * 注册待审批 id（service observer 收 sense_pending 时调用）
   */
  register(approvalId: string): void {
    this.approvals.add(approvalId)
  }

  /**
   * 确认审批：转调 core registry resolve，触发 senseMiddleware await 解除。
   */
  confirm(approvalId: string, action: 'accept' | 'reject', reason?: string): void {
    if (this.approvals.has(approvalId)) {
      resolveApproval(approvalId, action, reason)
      this.approvals.delete(approvalId)
    }
  }

  /**
   * 中止审批：转调 core registry reject，解除 senseMiddleware 的 await Promise.all，
   * 使挂起 generator 正常结束可被 GC（替代旧 remove 仅删 Map 依赖 GC 的不可靠方案）。
   * pending sense 在 DB 保持 content=NULL，重启后 chat.get 判定 canResume=true，
   * 前端可走 chat.resume 撤回重跑。
   */
  abort(approvalId: string): void {
    if (this.approvals.has(approvalId)) {
      rejectApproval(approvalId, new AgentAbortError())
      this.approvals.delete(approvalId)
    }
  }
}

export const approvalManager = new ApprovalManager()
