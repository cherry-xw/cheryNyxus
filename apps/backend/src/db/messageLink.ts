import { getSoulDb } from './index.js'
import { getChat, getRootChat } from './chat.js'
import type { MessageData } from './message.js'

export type MessageLinkRelation =
  | 'root_input'
  | 'agent_output'
  | 'tool_result'
  | 'spawn_request'
  | 'child_input'
  | 'child_output'
  | 'child_return'
  | 'system'
  | 'legacy_unknown'

export interface MessageLinkData {
  rootChatId?: string
  sourceChatId?: string
  parentChatId?: string
  spawnId?: string
  spawnCallId?: string
  relatedMessageId?: string
  causationNodeId?: string
  relation: MessageLinkRelation
}

export interface MessageLinkRow extends MessageLinkData {
  messageId: string
  rootChatId: string
  sourceChatId: string
  createdAt: number
}

export function defaultMessageLink(chatId: string, role: MessageData['role']): MessageLinkData {
  const root = getRootChat(chatId)
  return {
    rootChatId: root.id,
    sourceChatId: chatId,
    parentChatId: root.id === chatId ? undefined : (getChat(chatId)?.parent_chat_id ?? undefined),
    relation:
      role === 'user'
        ? root.id === chatId
          ? 'root_input'
          : 'child_input'
        : role === 'sense'
          ? 'tool_result'
          : role === 'system'
            ? 'system'
            : root.id === chatId
              ? 'agent_output'
              : 'child_output',
  }
}

export function upsertMessageLink(messageId: string, chatId: string, link: MessageLinkData): void {
  const chat = getChat(chatId)
  if (!chat) throw new Error(`Chat ${chatId} not found`)
  const root = link.rootChatId ? getChat(link.rootChatId) : getRootChat(chatId)
  const now = Date.now()
  getSoulDb()
    .prepare(
      `INSERT INTO message_links
        (message_id, root_chat_id, source_chat_id, parent_chat_id, spawn_id, spawn_call_id, related_message_id, causation_node_id, relation, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(message_id) DO UPDATE SET
         root_chat_id=excluded.root_chat_id,
         source_chat_id=excluded.source_chat_id,
         parent_chat_id=excluded.parent_chat_id,
         spawn_id=excluded.spawn_id,
         spawn_call_id=excluded.spawn_call_id,
         related_message_id=excluded.related_message_id,
         causation_node_id=excluded.causation_node_id,
         relation=excluded.relation`,
    )
    .run(
      messageId,
      root?.id ?? chat.id,
      link.sourceChatId ?? chatId,
      link.parentChatId ?? chat.parent_chat_id ?? null,
      link.spawnId ?? null,
      link.spawnCallId ?? null,
      link.relatedMessageId ?? null,
      link.causationNodeId ?? null,
      link.relation,
      now,
    )
}

export function getMessageLinksForRoot(rootChatId: string): MessageLinkRow[] {
  const rows = getSoulDb()
    .prepare(
      'SELECT * FROM message_links WHERE root_chat_id = ? ORDER BY created_at ASC, message_id ASC',
    )
    .all(rootChatId) as Record<string, unknown>[]
  return rows.map((row) => ({
    messageId: String(row.message_id),
    rootChatId: String(row.root_chat_id),
    sourceChatId: String(row.source_chat_id),
    parentChatId: row.parent_chat_id ? String(row.parent_chat_id) : undefined,
    spawnId: row.spawn_id ? String(row.spawn_id) : undefined,
    spawnCallId: row.spawn_call_id ? String(row.spawn_call_id) : undefined,
    relatedMessageId: row.related_message_id ? String(row.related_message_id) : undefined,
    causationNodeId: row.causation_node_id ? String(row.causation_node_id) : undefined,
    relation: String(row.relation) as MessageLinkRelation,
    createdAt: Number(row.created_at),
  }))
}

/**
 * 取注入本 chat 的 child_return 角色回复消息 id（wakeParent 注入的子返回/超时）。
 * 前端 hydration 据此标记 mergedView=child-to-master，从主轴过滤（与 live reducer 一致）--
 * 否则 DB 重新加载后子返回 role 消息丢失 live 标记，被误认作主轴消息渲染到 lane 0。
 */
export function getChildReturnMessageIds(parentChatId: string): Set<string> {
  const rows = getSoulDb()
    .prepare('SELECT message_id FROM message_links WHERE parent_chat_id = ? AND relation = ?')
    .all(parentChatId, 'child_return') as { message_id: string }[]
  return new Set(rows.map((r) => r.message_id))
}
