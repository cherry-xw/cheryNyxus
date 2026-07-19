import type { Ref } from 'vue'
import type { PetInstance } from '@/features/pets/types'
import type { StreamState } from './types'

/**
 * 立即清 pending 审批（ApprovalCard submit 后调用，不等 accept/rejected notification 回来）。
 * 自动从 queue head pop 下一个进 approval（多审批堆叠连续处理）。
 * 后续 accept/rejected notification 仍会清（已 undefined 无害）。
 */
function dismissApproval(streams: Ref<Record<string, StreamState>>) {
  return (chatId: string): void => {
    const stream = streams.value[chatId]
    if (!stream) return
    stream.approval = undefined
    if (stream.approvalQueue.length > 0) {
      const next = stream.approvalQueue.shift()
      if (next) stream.approval = next
    }
  }
}

/**
 * 把当前 approval 移到 queue（用户点 ✕ 关闭审批卡片时调用）。
 * 移到 queue 后 PetIcons 渲染闪烁 icon；用户可点击 icon 重新唤起。
 * 自动从 queue head pop 下一个进 approval（多审批堆叠连续推进）。
 */
function dismissApprovalToQueue(streams: Ref<Record<string, StreamState>>) {
  return (chatId: string): void => {
    const stream = streams.value[chatId]
    if (!stream) return
    if (stream.approval) {
      stream.approvalQueue.push(stream.approval)
      stream.approval = undefined
    }
    if (stream.approvalQueue.length > 0) {
      const next = stream.approvalQueue.shift()
      if (next) stream.approval = next
    }
  }
}

/**
 * 从 queue 中按 approvalId 找回指定审批，重新进入 approval 槽（PetIcons icon 点击时调用）。
 * 找不到（id 已不在 queue）→ console.warn 静默忽略。
 */
function resummonApproval(streams: Ref<Record<string, StreamState>>) {
  return (chatId: string, approvalId: string): void => {
    const stream = streams.value[chatId]
    if (!stream) return
    const idx = stream.approvalQueue.findIndex((a) => a.approvalId === approvalId)
    if (idx < 0) {
      console.warn('[agents] resummonApproval: queue 中未找到', { chatId, approvalId })
      return
    }
    const target = stream.approvalQueue[idx]
    if (!target) return
    // 若当前已有 approval → 把现有的移到 queue 末尾（保留连续处理能力）
    if (stream.approval) stream.approvalQueue.push(stream.approval)
    // 从 queue 移除并置为当前
    stream.approvalQueue.splice(idx, 1)
    stream.approval = target
  }
}

export function createApprovalActions(
  streams: Ref<Record<string, StreamState>>,
  _pets: Ref<PetInstance[]>,
) {
  return {
    dismissApproval: dismissApproval(streams),
    dismissApprovalToQueue: dismissApprovalToQueue(streams),
    resummonApproval: resummonApproval(streams),
  }
}
