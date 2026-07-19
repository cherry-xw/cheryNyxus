import { computed, type ComputedRef } from 'vue'
import { useAgentsStore } from '@/stores'
import type { HistoryItem } from '@/stores/agents'
import type { PetInstance } from '@/features/pets/types'

/**
 * useSubPetResolution：子 pet 解析辅助函数集合。
 * 从 HistoryDrawer 拆出，访问 agents.pets 内部状态。
 * 保持原函数签名（接收 HistoryItem，非分离参数）。
 */

export function useSubPetResolution(history: ComputedRef<HistoryItem[]>): {
  subPetOf: (item: HistoryItem) => PetInstance | undefined
  subPetName: (item: HistoryItem) => string
  subPetFace: (item: HistoryItem) => string
  subPetType: (item: HistoryItem) => string
  callerPetOf: (item: HistoryItem) => PetInstance | undefined
  callerIsMaster: (item: HistoryItem) => boolean
  callerPetFace: (item: HistoryItem) => string
  callerPetName: (item: HistoryItem) => string
  lastSubReplyAt: ComputedRef<Map<string, number>>
  isLastSubReply: (item: HistoryItem) => boolean
} {
  const agents = useAgentsStore()

  /** 子 pet 查询（master/role 合并式按 subPetChatId 查 pets；注入式 role 无 chatId → undefined） */
  function subPetOf(item: HistoryItem): PetInstance | undefined {
    if (!item.subPetChatId) return undefined
    return agents.pets.find((p) => p.chatId === item.subPetChatId)
  }

  /** 子 pet name（pet.name；注入式 fallback item.petName=type） */
  function subPetName(item: HistoryItem): string {
    return subPetOf(item)?.name ?? item.petName ?? ''
  }

  /** 子 pet face emoji：ghost 用灵魂 emoji 兜底；缺则空 → MessageBubble 内 🤖 fallback */
  function subPetFace(item: HistoryItem): string {
    const sub = subPetOf(item)
    if (!sub) return ''
    if (sub.isGhost) return sub.ghostFace ?? '👻'
    return sub.face.calm
  }

  /** 子 pet agentType（senseGroup；注入式 fallback item.petName） */
  function subPetType(item: HistoryItem): string {
    return subPetOf(item)?.runtime?.senseGroup ?? item.petName ?? ''
  }

  /** caller pet 查询：优先用历史记录写入的实际父 chatId，再退化到当前 pet 树。 */
  function callerPetOf(item: HistoryItem): PetInstance | undefined {
    if (item.callerSubPetChatId) {
      return agents.pets.find((p) => p.chatId === item.callerSubPetChatId)
    }
    const sub = subPetOf(item)
    if (!sub?.parentChatId) return undefined
    return agents.pets.find((p) => p.chatId === sub.parentChatId)
  }

  function callerIsMaster(item: HistoryItem): boolean {
    return callerPetOf(item)?.isMaster ?? !item.callerSubPetChatId
  }

  /** caller pet face emoji：ghost 用灵魂 emoji 兜底；缺则空 */
  function callerPetFace(item: HistoryItem): string {
    const caller = callerPetOf(item)
    if (!caller) return ''
    if (caller.isGhost) return caller.ghostFace ?? '👻'
    return caller.face.calm
  }

  /** caller pet name（hover 详情面板 + caller 徽章 tooltip 用） */
  function callerPetName(item: HistoryItem): string {
    return callerPetOf(item)?.name ?? ''
  }

  // 每个子 pet（subPetChatId）最后一条 role 回复的 createdAt；
  // 仅这些条目显示主 pet 引用徽章（"回复给主 pet" 标识，中间回复不重复引用）。
  // 兼容旧 role=subagent（历史兼容）+ 新 role=role。
  const lastSubReplyAt = computed<Map<string, number>>(() => {
    const m = new Map<string, number>()
    for (const item of history.value) {
      if ((item.role !== 'subagent' && item.role !== 'role') || !item.subPetChatId) continue
      const t = item.createdAt ?? 0
      if (t > (m.get(item.subPetChatId) ?? -1)) m.set(item.subPetChatId, t)
    }
    return m
  })

  /** 该 role 是否为其子 pet 的最后一条回复（决定是否显示主 pet 引用徽章） */
  function isLastSubReply(item: HistoryItem): boolean {
    if ((item.role !== 'subagent' && item.role !== 'role') || !item.subPetChatId) return false
    return (lastSubReplyAt.value.get(item.subPetChatId) ?? -1) === (item.createdAt ?? 0)
  }

  return {
    subPetOf,
    subPetName,
    subPetFace,
    subPetType,
    callerPetOf,
    callerIsMaster,
    callerPetFace,
    callerPetName,
    lastSubReplyAt,
    isLastSubReply,
  }
}
