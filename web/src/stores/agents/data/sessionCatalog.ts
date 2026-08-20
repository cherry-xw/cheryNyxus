import { ref, type Ref } from 'vue'
import type { ChatSummary } from '@/services/agentApi'

export interface SessionCatalog {
  summaries: Ref<ChatSummary[]>
  replace(chats: readonly ChatSummary[]): void
  merge(chats: readonly ChatSummary[]): void
  replacePreset(presetName: string, chats: readonly ChatSummary[]): void
  upsert(chat: ChatSummary): void
  remove(chatIds: readonly string[]): void
}

/**
 * Canonical chat.list projection. List, piano, workbench and cards consume the
 * same ref; backend interactions update it only through these operations.
 */
export function createSessionCatalog(): SessionCatalog {
  const summaries = ref<ChatSummary[]>([])
  const deletedChatIds = new Set<string>()

  function replace(chats: readonly ChatSummary[]): void {
    summaries.value = chats.filter((chat) => !deletedChatIds.has(chat.chatId))
  }

  function merge(chats: readonly ChatSummary[]): void {
    const byId = new Map(summaries.value.map((chat) => [chat.chatId, chat]))
    for (const chat of chats) {
      if (deletedChatIds.has(chat.chatId)) continue
      const previous = byId.get(chat.chatId)
      byId.set(chat.chatId, previous ? { ...previous, ...chat } : chat)
    }
    summaries.value = [...byId.values()]
  }

  function replacePreset(presetName: string, chats: readonly ChatSummary[]): void {
    const incomingIds = new Set(chats.map((chat) => chat.chatId))
    summaries.value = [
      ...summaries.value.filter(
        (chat) => chat.preset !== presetName && !incomingIds.has(chat.chatId),
      ),
      ...chats.filter((chat) => !deletedChatIds.has(chat.chatId)),
    ]
  }

  function upsert(chat: ChatSummary): void {
    merge([chat])
  }

  function remove(chatIds: readonly string[]): void {
    const removed = new Set(chatIds)
    for (const chatId of removed) deletedChatIds.add(chatId)
    summaries.value = summaries.value.filter((chat) => !removed.has(chat.chatId))
  }

  return { summaries, replace, merge, replacePreset, upsert, remove }
}
