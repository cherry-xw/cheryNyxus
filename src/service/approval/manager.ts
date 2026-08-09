import { resolveApproval, rejectApproval } from '@/core/sense/approvalRegistry.js'
import { AgentAbortError, AgentParkError } from '@/core/middleware/errors.js'
import { logger } from '@/utils/logger/index.js'

/**
 * 审批管理器（极简版）
 *
 * P1-11：不再存 resolve/reject 函数指针（解耦 core）。core 审批 Promise 由 approvalRegistry 管理，
 * 本 manager 仅记录待审批 id；confirm/abort/park 转调 core registry 触发 senseMiddleware 的 await Promise。
 * 无数据库持久化（pending sense 靠 messages.content 空判断，见 interaction.md）。
 *
 * manager 自存 payload（chatId/senseName/waitTime/createdAt）：chat.list 据此派生 per-chat pendingApproval
 * 「琴键」闪烁态（含未 hydration 的 chat），免扫事件。与 computeCurrentState（扫事件，单 chat 已 hydration
 * 快照）同为 approval 生命周期派生，两者必一致。
 */
export type ApprovalPayload = {
  chatId: string
  senseName: string
  /** 审批窗口 ms（= global.approval_timeout，0 = 不限时）。与 interrupt 通知 waitTime 同源。 */
  waitTime: number
  /** interrupt 触发时间戳（ms，Date.now()）。与 interrupt 通知 createdAt 同源。 */
  createdAt: number
}

export class ApprovalManager {
  private approvals = new Map<string, ApprovalPayload>()

  /**
   * 注册待审批 id（service observer 收 sense_pending 时调用）。
   * payload 用于 chat.list 派生 pendingApproval，无需 hydration。
   */
  register(approvalId: string, payload: ApprovalPayload): void {
    this.approvals.set(approvalId, payload)
  }

  /**
   * 审批是否仍存活（未被 confirm/park/abort/超时清出）。currentState 快照用：
   * 判定挂起审批是否仍可审批（run 在跑=存活；已 park=不在）。
   */
  has(approvalId: string): boolean {
    return this.approvals.has(approvalId)
  }

  /**
   * chat 是否有 in-flight 审批。chat.list 「琴键」闪烁判定（轻量，免扫事件）。
   */
  hasForChat(chatId: string): boolean {
    for (const p of this.approvals.values()) {
      if (p.chatId === chatId) return true
    }
    return false
  }

  /**
   * 取 chat 首个 in-flight 审批（approvals-per-chat 典型 0-1 in-flight，或小队列）。
   * 返回裁剪形态（无 chatId/approvalId）。chat.list pendingApproval 字段源。
   * 无则 undefined（调用方 ?? null）。
   */
  getForChat(
    chatId: string,
  ): { senseName: string; waitTime: number; createdAt: number } | undefined {
    for (const p of this.approvals.values()) {
      if (p.chatId === chatId) {
        return { senseName: p.senseName, waitTime: p.waitTime, createdAt: p.createdAt }
      }
    }
    return undefined
  }

  /**
   * 确认审批：转调 core registry resolve，触发 senseMiddleware await 解除。
   * @returns true=命中并 resolve；false=approvalId 失效（已被 abort/park/超时清出）。
   *   规则12 fail loud：调用方（handleSenseApproval）据 false 抛错让前端感知，不静默丢弃。
   */
  confirm(approvalId: string, action: 'accept' | 'reject', reason?: string): boolean {
    if (this.approvals.has(approvalId)) {
      resolveApproval(approvalId, action, reason)
      this.approvals.delete(approvalId)
      return true
    }
    logger.event('approval.confirm.unknown', { approvalId, action })
    return false
  }

  /**
   * 挂起审批（WS 断连触发，close(ws) 调用）：转调 core registry reject(AgentParkError)，
   * 解除 senseMiddleware await（复用 abort 的「throw 保 pending sense content=NULL」机制），
   * 但 observer 见 AgentParkError 静默不 wakeParent——子 chat 保持 canResume Case1，
   * 重连 chat.resume/chat.startSpawn 重建 pending sense（新 approvalId），用户重新审批后子正常完成唤主。
   * 区别于 abort（用户主动 chat.abort，唤主报错）。
   */
  park(approvalId: string): void {
    if (this.approvals.has(approvalId)) {
      rejectApproval(approvalId, new AgentParkError())
      this.approvals.delete(approvalId)
    }
  }

  /**
   * 中止审批：转调 core registry reject，解除 senseMiddleware 的 await Promise.all，
   * 使挂起 generator 正常结束可被 GC（替代旧 remove 仅删 Map 依赖 GC 的不可靠方案）。
   * pending sense 在 DB 保持 content=NULL，重启后 chat.get 判定 canResume=true，
   * 前端可走 chat.resume 撤回重跑。用户主动 chat.abort 触发，observer 唤主报错。
   */
  abort(approvalId: string): void {
    if (this.approvals.has(approvalId)) {
      rejectApproval(approvalId, new AgentAbortError())
      this.approvals.delete(approvalId)
    }
  }
}

export const approvalManager = new ApprovalManager()
