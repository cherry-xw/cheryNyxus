import type { ArchiveChat, ArchiveGroup } from '@chery/protocol'

export interface ArchiveNode {
  chat: ArchiveChat
  label: string
  relation: string
  children: ArchiveNode[]
  matched: boolean
  expand: boolean
}

export function archiveTree(group: ArchiveGroup, query: string): ArchiveNode {
  const term = query.trim().toLocaleLowerCase()
  const nodes = new Map<string, ArchiveNode>(
    group.chats.map((chat) => [
      chat.chatId,
      {
        chat,
        label:
          chat.agentType ||
          (chat.chatId === group.rootChatId ? chat.preset || '主 Agent' : 'Agent'),
        relation:
          chat.chatId === group.rootChatId
            ? '主 Agent'
            : chat.branchKind === 'continuation'
              ? '继续分支'
              : chat.branchKind === 'detail'
                ? '解释分支'
                : '子 Agent',
        children: [],
        matched:
          !!term &&
          [chat.chatId, chat.agentType, chat.preset, chat.preview].some((value) =>
            value?.toLocaleLowerCase().includes(term),
          ),
        expand: false,
      },
    ]),
  )
  const root = nodes.get(group.rootChatId)!
  for (const node of nodes.values()) {
    if (node === root) continue
    let parent = nodes.get(node.chat.parentChatId ?? '') ?? root
    const seen = new Set([node.chat.chatId])
    let cursor: ArchiveNode | undefined = parent
    while (cursor && cursor !== root) {
      if (seen.has(cursor.chat.chatId)) {
        parent = root
        break
      }
      seen.add(cursor.chat.chatId)
      cursor = nodes.get(cursor.chat.parentChatId ?? '')
    }
    parent.children.push(node)
  }
  function mark(node: ArchiveNode): boolean {
    const childMatches = node.children.map(mark).some(Boolean)
    node.expand = node === root || childMatches
    return node.matched || childMatches
  }
  mark(root)
  return root
}

export function deletionImpact(groups: ArchiveGroup[]): string {
  const related = groups.reduce((count, group) => count + group.chats.length - 1, 0)
  return `将永久删除 ${groups.length} 个主会话及 ${related} 个关联会话（包括子 Agent、后代及分支）的全部消息与历史记录。无法恢复。`
}
