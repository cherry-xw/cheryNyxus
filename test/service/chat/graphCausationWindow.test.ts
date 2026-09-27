/**
 * buildRootTimeline 的 causationId 收敛回归测试。
 *
 * 背景：causationId 是旧数据兼容字段（仅用于旧数据诊断与服务端 backfill，不参与前端建边）。
 * 当前数据在 wake.ts 为 child_return 写入 causationNodeId，buildRootTimeline 又为每个 return
 * 节点生成显式 return 边。若 return 节点仍携带 causationId 下发给前端，代际窗口
 * （generationWindowFloor）裁掉跨代际 return 边后，前端 diagnostics 会把「边在窗口外」
 * 误判成 legacy-relation-unresolved，且重新同步无法消除。
 *
 * 修复约定：return 边已建成的节点剥除 causationId；只有对应 return 边未建成（真实未解析
 * 的旧数据）时才保留。
 */
import { randomUUID } from 'crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { addMessage, createChat, deleteChat } from '@/db/chat.js'
import { buildRootTimeline } from '@/service/chat/handler.js'

const cleanup: string[] = []
afterEach(() => {
  for (const id of cleanup.splice(0).reverse()) deleteChat(id)
})

/**
 * 搭建最小多 agent 任务（不含 child_return 与 compact 边界）：
 * 子 chat 收到指令并产出 child-done；主 chat 有 root-user。
 * 消息 ID 带序号保证候选排序（createdAt 并列时按 sourceMessageId）稳定：
 * 01-child-user < 02-child-done < 03-root-user < 04-boundary-1 < 05-boundary-2 < 06-root-return。
 */
function setupTask(): { rootChatId: string; childChatId: string } {
  const rootChatId = randomUUID()
  const childChatId = randomUUID()
  cleanup.push(rootChatId, childChatId)
  createChat(rootChatId)
  createChat(childChatId, {}, rootChatId)
  addMessage('01-child-user', childChatId, { role: 'user', content: '子任务指令' })
  addMessage('02-child-done', childChatId, { role: 'assistant', content: '子任务完成' })
  addMessage('03-root-user', rootChatId, { role: 'user', content: '先派子任务' })
  return { rootChatId, childChatId }
}

/** 两次 compact 边界（assistant + context_compaction=1），落在 return 之前。 */
function addCompactBoundaries(rootChatId: string): void {
  addMessage('04-boundary-1', rootChatId, {
    role: 'assistant',
    content: '第一段摘要',
    contextCompaction: true,
  })
  addMessage('05-boundary-2', rootChatId, {
    role: 'assistant',
    content: '第二段摘要',
    contextCompaction: true,
  })
}

/** 主 chat 注入 child_return（带 causationNodeId=child-done），最后插入保证其 orderKey 最靠后。 */
function addChildReturn(rootChatId: string, childChatId: string): void {
  addMessage('06-root-return', rootChatId, {
    role: 'role',
    content: '[角色 子任务] 结果',
    link: {
      rootChatId,
      sourceChatId: childChatId,
      parentChatId: rootChatId,
      relation: 'child_return',
      relatedMessageId: '02-child-done',
      causationNodeId: '02-child-done',
    },
  })
}

describe('buildRootTimeline causationId 收敛（代际窗口误报回归）', () => {
  it('return 节点显式边已建成时不携带 causationId', () => {
    const { rootChatId, childChatId } = setupTask()
    addChildReturn(rootChatId, childChatId)
    const timeline = buildRootTimeline(rootChatId, 'tree')
    const returnNode = timeline.nodes.find((n) => n.kind === 'return')
    expect(returnNode).toBeDefined()
    // 显式 return 边已建成（child-done → return）
    expect(
      timeline.edges.some(
        (e) =>
          e.kind === 'return' && e.fromNodeId === '02-child-done' && e.toNodeId === returnNode!.id,
      ),
    ).toBe(true)
    // 冗余兼容字段已剥除，前端不会因窗口过滤误报 legacy-relation-unresolved
    expect(returnNode!.causationId).toBeUndefined()
  })

  it('代际窗口裁掉跨代际 return 边时，return 节点仍不携带 causationId', () => {
    const { rootChatId, childChatId } = setupTask()
    addCompactBoundaries(rootChatId)
    addChildReturn(rootChatId, childChatId)
    const timeline = buildRootTimeline(rootChatId, 'tree')
    const returnNode = timeline.nodes.find((n) => n.kind === 'return')
    expect(returnNode).toBeDefined()
    // 前置条件确认：child-done 被窗口过滤、return 边不在快照内
    expect(timeline.nodes.some((n) => n.id === '02-child-done')).toBe(false)
    expect(timeline.edges.some((e) => e.kind === 'return')).toBe(false)
    // 修复核心：return 节点不再带 causationId，前端 diagnostics 不会误报
    expect(returnNode!.causationId).toBeUndefined()
  })
})
