import { AgentParkError } from '@/core/middleware/errors.js'

/**
 * Approval Registry（P1-11：core 层审批 Promise 管理，解耦 core↔service）。
 *
 * 原设计：SenseTriggerChunk/SensePendingChunk 携带 approvalResolve/approvalReject 函数指针，
 * core middleware 依赖 service 层 ApprovalManager 的回调 —— 分层违反。
 *
 * 解耦后：core（senseMiddleware）在此 registry 创建审批 Promise 并 await；
 * chunk 只产 {approvalId, needsApproval} 事实；service ApprovalManager 通过
 * resolveApproval/rejectApproval 触发对应 Promise，结果经独立 channel 回填到 await。
 *
 * 审批超时：createApproval 接 timeoutMs，超时 park（不是用户拒绝）。
 *   - 用户未在窗口内操作 → pending sense 保持可恢复，停止自动向下运行
 *   - 断连 abort → rejectApproval(AgentAbortError) → throw → pending NULL → resume Case1 重跑
 *
 * 不限时审批资源上限（G2 改造D）：approval_timeout=0 时由 hardTimeoutMs（global.approval_hard_timeout，
 *   默认 30min）兜底，到点 rejectApproval(AgentParkError) 归 paused 可续（非用户拒绝）——
 *   释放 generator/内存，避免无限挂起。
 */
export type ApprovalDecision = {
  action: 'accept' | 'reject'
  reason?: string
}

interface PendingApproval {
  resolve: (decision: ApprovalDecision) => void
  reject: (error: Error) => void
  timeoutTimer?: ReturnType<typeof setTimeout>
  /** 不限时审批的 hard-timeout timer（approval_timeout=0 时由 global.approval_hard_timeout 起此 timer） */
  hardTimer?: ReturnType<typeof setTimeout>
}

const registry = new Map<string, PendingApproval>()

/**
 * 创建审批 Promise 并注册 resolve/reject（core senseMiddleware 调用）。
 * @param timeoutMs 用户超时毫秒（来自 `global.approval_timeout`，校验 `>= 0`）。
 *                  `> 0` → 到点 reject AgentParkError，保留为可恢复交互。
 *                  `undefined` 或 `<= 0` = 不限时（无用户超时）。
 * @param hardTimeoutMs 不限时审批的资源上限毫秒（来自 `global.approval_hard_timeout`，默认 30min）。
 *                      **仅当 timeoutMs<=0（不限时）生效**：到点 reject(AgentParkError) 归 paused 可续。
 *                      timeoutMs>0 时用户超时已界顶，hard-timeout 不叠加。
 * @returns senseMiddleware await 的 Promise；service confirm/abort/超时/hard-timeout 触发其 resolve/reject
 */
export function createApproval(
  id: string,
  timeoutMs?: number,
  hardTimeoutMs?: number,
): Promise<ApprovalDecision> {
  return new Promise<ApprovalDecision>((resolve, reject) => {
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined
    let hardTimer: ReturnType<typeof setTimeout> | undefined
    if (timeoutMs && timeoutMs > 0) {
      // 超时只是用户未响应，不等价于明确拒绝；park 后由用户重新打开会话继续。
      timeoutTimer = setTimeout(() => {
        const entry = registry.get(id)
        if (entry) {
          entry.reject(new AgentParkError())
          registry.delete(id)
        }
      }, timeoutMs)
    } else if (hardTimeoutMs && hardTimeoutMs > 0) {
      // 不限时审批资源上限：reject(AgentParkError) 归 paused 可续（非用户拒绝），释放 generator/内存
      hardTimer = setTimeout(() => {
        const entry = registry.get(id)
        if (entry) {
          entry.reject(new AgentParkError())
          registry.delete(id)
        }
      }, hardTimeoutMs)
    }
    registry.set(id, { resolve, reject, timeoutTimer, hardTimer })
  })
}

/**
 * 确认审批（service ApprovalManager.confirm 调用）：resolve senseMiddleware 的 await Promise。
 */
export function resolveApproval(id: string, action: 'accept' | 'reject', reason?: string): void {
  const entry = registry.get(id)
  if (entry) {
    if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer)
    if (entry.hardTimer) clearTimeout(entry.hardTimer)
    entry.resolve({ action, reason })
    registry.delete(id)
  }
}

/**
 * 中止审批（service ApprovalManager.abort 调用）：reject senseMiddleware 的 await Promise，
 * 解除 await 使挂起 generator 正常结束可被 GC。
 */
export function rejectApproval(id: string, error: Error): void {
  const entry = registry.get(id)
  if (entry) {
    if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer)
    if (entry.hardTimer) clearTimeout(entry.hardTimer)
    entry.reject(error)
    registry.delete(id)
  }
}

/**
 * 清理所有待处理审批（应用关闭时调用）。
 * 清除所有超时定时器 + 拒绝所有待处理审批（视为 abort）。
 */
export function clearAllApprovals(): void {
  for (const [id, entry] of registry) {
    if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer)
    if (entry.hardTimer) clearTimeout(entry.hardTimer)
    entry.reject(new Error('应用关闭，审批被中止'))
    registry.delete(id)
  }
}
