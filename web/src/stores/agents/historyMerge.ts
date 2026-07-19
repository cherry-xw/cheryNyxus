import type { HistoryItem } from './types'

/**
 * 取得以 rootChatId 为根的所有后代 chat id（广度优先、去重，容忍异常环）。
 * 主历史聚合用它收集全部层级；子 pet 的 direct 历史不调用此函数。
 */
export function collectDescendantChatIds(
  chats: readonly { chatId: string; parentChatId?: string | null }[],
  rootChatId: string,
): string[] {
  const childrenByParent = new Map<string, string[]>()
  for (const chat of chats) {
    if (!chat.parentChatId) continue
    const ids = childrenByParent.get(chat.parentChatId) ?? []
    ids.push(chat.chatId)
    childrenByParent.set(chat.parentChatId, ids)
  }

  const descendants: string[] = []
  const seen = new Set<string>([rootChatId])
  const pending = [...(childrenByParent.get(rootChatId) ?? [])]
  while (pending.length > 0) {
    const chatId = pending.shift()!
    if (seen.has(chatId)) continue
    seen.add(chatId)
    descendants.push(chatId)
    pending.push(...(childrenByParent.get(chatId) ?? []))
  }
  return descendants
}

/**
 * 主历史展示去重：数据库中保留两条独立记录，只有 UI 将其折叠为一项。
 *
 * A：主（或上层子）chat 中 role 回传，未带 subPetChatId。
 * B：子 chat 自身 assistant 映射后的 role，带 subPetChatId。
 *
 * 每个子 chat 仅最后一条 B 才可能是回传结果；A/B 必须正文完全一致，且 B
 * 不能晚于 A。一个 B 最多匹配一个 A，无法唯一安全配对时保留原始两条。
 */
export function mergeChildReplyHistory(items: readonly HistoryItem[]): HistoryItem[] {
  if (items.length === 0) return []

  const latestReplyByChild = new Map<string, number>()
  for (let index = 0; index < items.length; index++) {
    const item = items[index]!
    if (item.role !== 'role' || !item.subPetChatId || item.mergedView) continue
    const previous = latestReplyByChild.get(item.subPetChatId)
    if (previous === undefined || compareHistoryTime(items[previous]!, item) <= 0) {
      latestReplyByChild.set(item.subPetChatId, index)
    }
  }

  const finalReplyIndices = new Set(latestReplyByChild.values())
  if (finalReplyIndices.size === 0) return [...items]

  const usedReplies = new Set<number>()
  const mergedByReturnIndex = new Map<number, HistoryItem>()
  const returns = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.role === 'role' && !item.subPetChatId && !item.mergedView)
    .sort((a, b) => compareHistoryTime(a.item, b.item))

  for (const returned of returns) {
    const candidateIndices = [...finalReplyIndices].filter((candidateIndex) => {
      if (usedReplies.has(candidateIndex)) return false
      const candidate = items[candidateIndex]!
      return (
        sameReplyContent(returned.item.content, candidate.content) &&
        wasProducedBefore(candidate, returned.item)
      )
    })
    if (candidateIndices.length === 0) continue

    const nearest = candidateIndices
      .map((index) => ({ index, item: items[index]! }))
      .sort((a, b) => replyDistance(a.item, returned.item) - replyDistance(b.item, returned.item))

    // 完全相同的距离意味着无法可靠确定来源，保留两条而不是误合并。
    if (
      nearest.length > 1 &&
      replyDistance(nearest[0]!.item, returned.item) ===
        replyDistance(nearest[1]!.item, returned.item)
    ) {
      continue
    }

    const childReplyIndex = nearest[0]!.index
    usedReplies.add(childReplyIndex)
    mergedByReturnIndex.set(
      returned.index,
      buildMergedReply(returned.item, items[childReplyIndex]!),
    )
  }

  if (mergedByReturnIndex.size === 0) return [...items]

  const mergedChildIndices = new Set(usedReplies)
  return items.flatMap((item, index) => {
    if (mergedChildIndices.has(index)) return []
    return [mergedByReturnIndex.get(index) ?? item]
  })
}

function buildMergedReply(returned: HistoryItem, childReply: HistoryItem): HistoryItem {
  return {
    ...childReply,
    // 展示位置和时间属于「子 pet 回传给父 pet」这件事，而非子 chat 内原始生成时刻。
    createdAt: returned.createdAt ?? childReply.createdAt,
    msgId: returned.msgId ?? childReply.msgId,
    spawnSenseCallId: returned.spawnSenseCallId ?? childReply.spawnSenseCallId,
    mergedView: 'child-to-master',
  }
}

function sameReplyContent(a: string, b: string): boolean {
  return a === b
}

function wasProducedBefore(childReply: HistoryItem, returned: HistoryItem): boolean {
  if (childReply.createdAt === undefined || returned.createdAt === undefined) return true
  return childReply.createdAt <= returned.createdAt
}

function replyDistance(childReply: HistoryItem, returned: HistoryItem): number {
  if (childReply.createdAt === undefined || returned.createdAt === undefined)
    return Number.MAX_SAFE_INTEGER
  return returned.createdAt - childReply.createdAt
}

function compareHistoryTime(a: HistoryItem, b: HistoryItem): number {
  return (a.createdAt ?? 0) - (b.createdAt ?? 0)
}
