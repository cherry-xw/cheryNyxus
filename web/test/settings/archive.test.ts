import { describe, expect, it } from 'vitest'
import type { ArchiveGroup } from '@chery/protocol'
import { archiveTree, deletionImpact } from '../../src/features/agent/settings/tabs/archive/model'

const group: ArchiveGroup = {
  rootChatId: 'root',
  chats: [
    { chatId: 'root', parentChatId: null, preset: 'team', preview: 'task', messageCount: 2 },
    { chatId: 'child', parentChatId: 'root', agentType: 'research', preview: '', messageCount: 3 },
    {
      chatId: 'grandchild',
      parentChatId: 'child',
      agentType: 'writer',
      preview: 'needle',
      messageCount: 1,
    },
    { chatId: 'branch', parentChatId: null, branchKind: 'detail', preview: '', messageCount: 0 },
    { chatId: 'branch-child', parentChatId: 'branch', preview: '', messageCount: 0 },
  ],
}

describe('archive family presentation', () => {
  it('keeps descendants and branch children under their actual parent', () => {
    const tree = archiveTree(group, '')
    expect(tree.children.map((node) => node.chat.chatId)).toEqual(['child', 'branch'])
    expect(tree.children[0]?.children[0]?.chat.chatId).toBe('grandchild')
    expect(tree.children[1]?.relation).toBe('解释分支')
    expect(tree.children[1]?.children[0]?.chat.chatId).toBe('branch-child')
    expect(tree.expand).toBe(true)
    expect(tree.children[0]?.expand).toBe(false)
  })
  it('expands the ancestor path when searching a descendant', () => {
    const tree = archiveTree(group, ' NEEDLE ')
    expect(tree.children[0]?.expand).toBe(true)
    expect(tree.children[0]?.children[0]?.matched).toBe(true)
    expect(tree.children[1]?.expand).toBe(false)
  })
  it('counts every dependent conversation in the root deletion confirmation', () => {
    expect(deletionImpact([group])).toContain('1 个主会话及 4 个关联会话')
    expect(deletionImpact([group])).toContain('无法恢复')
  })
})
