import { resolveApproval, rejectApproval } from '@/core/sense/approvalRegistry.js'
import { AgentAbortError, AgentParkError } from '@/core/middleware/errors.js'
import { logger } from '@/utils/logger/index.js'
import {
  getInteraction,
  transitionInteraction,
  upsertPendingInteraction,
} from '@/db/interaction.js'
import { broadcastInteractionChanged } from '../interaction/events.js'
import type { ToolAuthorization } from '@/core/security/rolePolicy.js'

/**
 * 审批管理器（极简版）
 *
 * P1-11：不再存 resolve/reject 函数指针（解耦 core）。core 审批 Promise 由 approvalRegistry 管理，
 * 本 manager 仅记录待审批 id；confirm/abort/park 转调 core registry 触发 senseMiddleware 的 await Promise。
 * manager 只持有当前进程的 Promise 桥接；持久 interactions 表是跨断线、刷新和重启的
 * 用户可见事实源。payload 同时供旧 chat.list 的轻量 pendingApproval 投影使用。
 */
export type ApprovalPayload = {
  chatId: string
  senseName: string
  /** 工具能力解释（sense 定义 description；config_manage 等用户可见。缺失时省略）。 */
  senseDescription?: string
  /** 审批窗口 ms（= global.approval_timeout，0 = 不限时）。与 interrupt 通知 waitTime 同源。 */
  waitTime: number
  /** interrupt 触发时间戳（ms，Date.now()）。与 interrupt 通知 createdAt 同源。 */
  createdAt: number
  arguments: string
  supervisionLevel: number
  security?: ToolAuthorization
}

export class ApprovalManager {
  private approvals = new Map<string, ApprovalPayload | undefined>()
  private expiryTimers = new Map<string, ReturnType<typeof setTimeout>>()

  private clearExpiry(approvalId: string): void {
    const timer = this.expiryTimers.get(approvalId)
    if (timer) clearTimeout(timer)
    this.expiryTimers.delete(approvalId)
  }

  /**
   * 注册待审批 id（service observer 收 sense_pending 时调用）。
   * payload 用于 chat.list 派生 pendingApproval，无需 hydration。
   */
  register(approvalId: string, payload?: ApprovalPayload): void {
    this.clearExpiry(approvalId)
    const existing = getInteraction(approvalId)
    if (existing && ['completed', 'expired', 'cancelled'].includes(existing.status)) {
      // A crash may happen after the durable decision but before the rebuilt
      // core promise observes it. Replay that terminal decision; never expose
      // an invisible in-memory approval or revive the inbox row.
      const action = existing.result?.action === 'accept' ? 'accept' : 'reject'
      const reason = typeof existing.result?.reason === 'string' ? existing.result.reason : undefined
      const previousSecurity = existing.payload.security as ToolAuthorization | undefined
      const sameGrant =
        action !== 'accept' ||
        (!!previousSecurity &&
          !!payload?.security &&
          previousSecurity.policyHash === payload.security.policyHash &&
          previousSecurity.assessmentHash === payload.security.assessmentHash)
      if (!sameGrant) {
        resolveApproval(approvalId, 'reject', '安全策略或工具参数已变化，旧批准已失效')
        return
      }
      resolveApproval(approvalId, action, reason)
      return
    }
    this.approvals.set(approvalId, payload)
    if (!payload) return
    const deadlineAt = payload.waitTime > 0 ? payload.createdAt + payload.waitTime : undefined
    {
      const interaction = upsertPendingInteraction({
        interactionId: approvalId,
        kind: 'approval',
        chatId: payload.chatId,
        anchorNodeId: approvalId,
        payload: {
          senseName: payload.senseName,
          senseDescription: payload.senseDescription,
          arguments: payload.arguments,
          supervisionLevel: payload.supervisionLevel,
          security: payload.security,
        },
        ...(deadlineAt !== undefined ? { deadlineAt } : {}),
      })
      broadcastInteractionChanged(interaction)
    }
    if (payload.waitTime > 0) {
      const remaining = Math.max(0, (deadlineAt ?? Date.now()) - Date.now())
      this.expiryTimers.set(
        approvalId,
        setTimeout(() => this.expire(approvalId), remaining),
      )
    }
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
      if (p?.chatId === chatId) return true
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
  ): { approvalId: string; senseName: string; waitTime: number; createdAt: number } | undefined {
    for (const [approvalId, p] of this.approvals) {
      if (p?.chatId === chatId) {
        return { approvalId, senseName: p.senseName, waitTime: p.waitTime, createdAt: p.createdAt }
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
      this.clearExpiry(approvalId)
      const interaction = transitionInteraction(approvalId, ['pending', 'resolving', 'blocked'], 'completed', {
        action,
        ...(reason ? { reason } : {}),
      })
      broadcastInteractionChanged(interaction)
      return true
    }
    logger.event('approval.confirm.unknown', { approvalId, action })
    return false
  }

  /** Business deadline: reject this tool and let the Agent continue. */
  expire(approvalId: string): void {
    if (!this.approvals.has(approvalId)) return
    const interaction = transitionInteraction(
      approvalId,
      ['pending', 'resolving'],
      'expired',
      { action: 'reject', reason: '审批超时，工具未执行' },
    )
    if (!interaction) return
    broadcastInteractionChanged(interaction)
    resolveApproval(approvalId, 'reject', '审批超时，工具未执行')
    this.approvals.delete(approvalId)
    this.clearExpiry(approvalId)
  }

  /**
   * 挂起审批（WS 断连触发，close(ws) 调用）：转调 core registry reject(AgentParkError)，
   * 解除 senseMiddleware await（复用 abort 的「throw 保 pending sense content=NULL」机制），
   * 但 observer 见 AgentParkError 静默不 wakeParent——chat 保持 canResume；持久 interactionId
   * 不变，收件箱审批时由服务端恢复原 pending sense 后继续。
   * 区别于 abort（用户主动 chat.abort，唤主报错）。
   */
  park(approvalId: string): void {
    if (this.approvals.has(approvalId)) {
      rejectApproval(approvalId, new AgentParkError())
      this.approvals.delete(approvalId)
      this.clearExpiry(approvalId)
    }
  }

  /**
   * 中止审批：转调 core registry reject，解除 senseMiddleware 的 await Promise.all，
   * 使挂起 generator 正常结束可被 GC（替代旧 remove 仅删 Map 依赖 GC 的不可靠方案）。
   * pending sense 在 DB 保持 content=NULL，重启后 chat.get 判定 canResume=true，
   * 前端可走 chat.resume 撤回重跑。用户主动 chat.abort 触发，observer 唤主报错。
   */
  abort(approvalId: string, reason = '用户停止运行'): boolean {
    if (!this.approvals.has(approvalId)) return false
    const interaction = transitionInteraction(
      approvalId,
      ['pending', 'resolving', 'blocked'],
      'cancelled',
      { action: 'reject', reason },
    )
    broadcastInteractionChanged(interaction)
    rejectApproval(approvalId, new AgentAbortError())
    this.approvals.delete(approvalId)
    this.clearExpiry(approvalId)
    return true
  }

  /** Abort every live approval owned by a chat, including detached input runs. */
  abortForChat(chatId: string, reason = '用户停止运行'): string[] {
    const approvalIds = [...this.approvals.entries()]
      .filter(([, payload]) => payload?.chatId === chatId)
      .map(([approvalId]) => approvalId)
    return approvalIds.filter((approvalId) => this.abort(approvalId, reason))
  }
}

export const approvalManager = new ApprovalManager()
