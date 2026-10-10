import { listAllChats, type ChatRow } from './chat.js'
import { getSoulDb } from './index.js'

export interface ChatFamily {
  rootChatId: string
  chats: ChatRow[]
  branchKinds: Map<string, 'original' | 'continuation' | 'detail'>
}

/** One ownership calculation for listing, archiving and permanent deletion. */
export function listChatFamilies(): ChatFamily[] {
  const rows = listAllChats()
  const byId = new Map(rows.map((row) => [row.id, row]))
  const branches = getSoulDb()
    .prepare(
      `SELECT b.chat_id, b.kind, t.original_chat_id FROM conversation_branches b
     JOIN conversation_tasks t ON t.task_id = b.task_id`,
    )
    .all() as Array<{
    chat_id: string
    kind: 'original' | 'continuation' | 'detail'
    original_chat_id: string
  }>
  const owner = new Map(branches.map((branch) => [branch.chat_id, branch.original_chat_id]))
  const kinds = new Map(branches.map((branch) => [branch.chat_id, branch.kind]))
  const groups = new Map<string, ChatFamily>()
  for (const row of rows) {
    let root = row
    const seen = new Set<string>()
    while (!seen.has(root.id)) {
      seen.add(root.id)
      const parent = root.parent_chat_id ? byId.get(root.parent_chat_id) : undefined
      if (parent) {
        root = parent
        continue
      }
      const originalId = owner.get(root.id)
      const original = originalId && originalId !== root.id ? byId.get(originalId) : undefined
      if (!original) break
      root = original
    }
    const rootChatId = root.id
    let family = groups.get(rootChatId)
    if (!family) {
      family = { rootChatId, chats: [], branchKinds: new Map() }
      groups.set(rootChatId, family)
    }
    family.chats.push(row)
    const kind = kinds.get(row.id)
    if (kind) family.branchKinds.set(row.id, kind)
  }
  return [...groups.values()]
}

export function getChatFamily(chatId: string): ChatFamily | undefined {
  return listChatFamilies().find((family) => family.chats.some((chat) => chat.id === chatId))
}
