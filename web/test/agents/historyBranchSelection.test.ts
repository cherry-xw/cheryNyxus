import { describe, expect, it } from 'vitest'
import type { ConversationBranchSummary } from '../../src/application/backend/public'
import {
  resolveHistoryTaskId,
  resolveTaskDrawerChatId,
} from '../../src/features/agent/drawer/historyBranchSelection'

function branch(
  branchId: string,
  chatId: string,
  kind: ConversationBranchSummary['kind'],
  taskId = 'task-1',
): ConversationBranchSummary {
  return { branchId, chatId, kind, taskId, createdAt: 1 }
}

describe('history drawer branch selection', () => {
  const branches = [
    branch('branch-original', 'chat-original', 'original'),
    branch('branch-active', 'chat-active', 'continuation'),
    branch('branch-detail', 'chat-detail', 'detail'),
  ]

  it('recovers task identity from injected workbench branches when the catalog omits the chat', () => {
    expect(resolveHistoryTaskId('chat-original', undefined, branches)).toBe('task-1')
    expect(resolveHistoryTaskId('chat-missing', undefined, branches)).toBeUndefined()
  })

  it('keeps the catalog task identity authoritative when present', () => {
    expect(resolveHistoryTaskId('chat-original', 'catalog-task', branches)).toBe('catalog-task')
  })

  it('opens the active task branch instead of an inactive original branch', () => {
    expect(
      resolveTaskDrawerChatId(
        { activeBranchId: 'branch-active', branches },
        'chat-current',
      ),
    ).toBe('chat-active')
  })

  it('falls back to the original branch and then the current chat', () => {
    expect(
      resolveTaskDrawerChatId({ activeBranchId: 'branch-missing', branches }, 'chat-current'),
    ).toBe('chat-original')
    expect(resolveTaskDrawerChatId(undefined, 'chat-current')).toBe('chat-current')
  })
})
