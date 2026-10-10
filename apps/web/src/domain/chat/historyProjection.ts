import type { HistoryItem } from './projectionTypes'

export function dedupHistoryByMsgId(items: readonly HistoryItem[]): HistoryItem[] {
  const seen = new Map<string, HistoryItem>()
  const result: HistoryItem[] = []
  for (const source of items) {
    const item: HistoryItem = {
      ...source,
      ...(source.senseCalls ? { senseCalls: source.senseCalls.map((call) => ({ ...call })) } : {}),
      ...(source.mediaAssets
        ? { mediaAssets: source.mediaAssets.map((asset) => ({ ...asset })) }
        : {}),
    }
    if (!item.msgId) {
      result.push(item)
      continue
    }
    const existing = seen.get(item.msgId)
    if (!existing) {
      seen.set(item.msgId, item)
      result.push(item)
      continue
    }
    if ((item.thinking?.length ?? 0) > (existing.thinking?.length ?? 0)) {
      existing.thinking = item.thinking
    }
    if (item.content.length > existing.content.length) existing.content = item.content
    if (!existing.runtime && item.runtime) existing.runtime = item.runtime
    if (!existing.agentChatId && item.agentChatId) existing.agentChatId = item.agentChatId
    if (!existing.mediaAssets?.length && item.mediaAssets?.length)
      existing.mediaAssets = item.mediaAssets
    if (item.contextCompaction) existing.contextCompaction = true
    if (item.contextCompactionTokens !== undefined) {
      existing.contextCompactionTokens = item.contextCompactionTokens
    }
    if (item.createdAt !== undefined) {
      existing.createdAt =
        existing.createdAt === undefined
          ? item.createdAt
          : Math.min(existing.createdAt, item.createdAt)
    }
    if (item.senseCalls?.length) {
      const calls = [...(existing.senseCalls ?? [])]
      const callByFingerprint = new Map(calls.map((call) => [senseFingerprint(call), call]))
      for (const call of item.senseCalls) {
        const fingerprint = senseFingerprint(call)
        const existingCall = callByFingerprint.get(fingerprint)
        if (existingCall) {
          if (!existingCall.security && call.security) existingCall.security = call.security
          continue
        }
        callByFingerprint.set(fingerprint, call)
        calls.push(call)
      }
      existing.senseCalls = calls
    }
  }
  return result
}

function senseFingerprint(call: NonNullable<HistoryItem['senseCalls']>[number]): string {
  if (call.id) return `id:${call.id}`
  let args = ''
  try {
    args = typeof call.args === 'string' ? call.args : JSON.stringify(call.args)
  } catch {
    args = String(call.args)
  }
  return `legacy:${call.name}:${args}`
}

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
        candidate.content === returned.item.content && wasProducedBefore(candidate, returned.item)
      )
    })
    if (candidateIndices.length === 0) continue

    const nearest = candidateIndices
      .map((index) => ({ index, item: items[index]! }))
      .sort((a, b) => replyDistance(a.item, returned.item) - replyDistance(b.item, returned.item))
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
  return items.flatMap((item, index) => {
    if (usedReplies.has(index)) return []
    return [mergedByReturnIndex.get(index) ?? item]
  })
}

function buildMergedReply(returned: HistoryItem, childReply: HistoryItem): HistoryItem {
  return {
    ...childReply,
    createdAt: returned.createdAt ?? childReply.createdAt,
    msgId: returned.msgId ?? childReply.msgId,
    spawnSenseCallId: returned.spawnSenseCallId ?? childReply.spawnSenseCallId,
    mergedView: 'child-to-master',
  }
}

function wasProducedBefore(childReply: HistoryItem, returned: HistoryItem): boolean {
  if (childReply.createdAt === undefined || returned.createdAt === undefined) return true
  return childReply.createdAt <= returned.createdAt
}

function replyDistance(childReply: HistoryItem, returned: HistoryItem): number {
  if (childReply.createdAt === undefined || returned.createdAt === undefined) {
    return Number.MAX_SAFE_INTEGER
  }
  return returned.createdAt - childReply.createdAt
}

function compareHistoryTime(a: HistoryItem, b: HistoryItem): number {
  return (a.createdAt ?? 0) - (b.createdAt ?? 0)
}
