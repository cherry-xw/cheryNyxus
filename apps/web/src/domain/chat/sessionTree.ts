/**
 * Pure chat-tree algorithms shared by the chat application and visual projections.
 *
 * This module deliberately owns no Vue, Pinia, transport, or presentation types.
 * Callers only need to provide the stable identity and parent relationship.
 */
export interface ChatTreeNode {
  chatId: string
  parentChatId?: string | null
}

/** Breadth-first descendants, de-duplicated and resilient to malformed cycles. */
export function collectDescendantChatIds(
  chats: readonly ChatTreeNode[],
  rootChatId: string,
): string[] {
  const childrenByParent = new Map<string, string[]>()
  for (const chat of chats) {
    if (!chat.parentChatId) continue
    const children = childrenByParent.get(chat.parentChatId) ?? []
    children.push(chat.chatId)
    childrenByParent.set(chat.parentChatId, children)
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

/** Resolve the root of a node. Cycles and missing parents stop at the last safe node. */
export function resolveRootChatId(chats: readonly ChatTreeNode[], chatId: string): string {
  const parentById = new Map(chats.map((chat) => [chat.chatId, chat.parentChatId]))
  const seen = new Set<string>()
  let current = chatId
  while (!seen.has(current)) {
    seen.add(current)
    const parent = parentById.get(current)
    if (!parent) return current
    current = parent
  }
  return current
}
