import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { addMessage, createChat, deleteChat, getChat, getTimelineRevision } from '@/db/chat.js'
import { getSoulDb } from '@/db/index.js'
import { buildRootTimeline, handleChatTimelineGet } from '@/service/chat/handler.js'
import {
  computeGenerations,
  generationWindowFloor,
  handleChatTimelineGenerationGet,
  recordAutoCompactTrigger,
} from '@/service/chat/generations.js'
import { handleChatBranchPreview } from '@/service/chat/conversationBranch.js'
import type { HandlerContext } from '@/service/message/router.js'

// 注意：buildRootTimeline 按 (createdAt, sourceMessageId 字典序) 排序，addMessage 同毫秒落库时
// 消息 id 必须按时间顺序字典序递增（g01..g10 零填充），否则节点顺序会被 id 字典序打乱。
const chats: string[] = []
const tasks: string[] = []

afterEach(() => {
  const db = getSoulDb()
  for (const taskId of tasks.splice(0)) {
    db.prepare('DELETE FROM conversation_branches WHERE task_id = ?').run(taskId)
    db.prepare('DELETE FROM conversation_tasks WHERE task_id = ?').run(taskId)
  }
  for (const chatId of chats.splice(0).reverse()) if (getChat(chatId)) deleteChat(chatId)
})

function newRootChat(): string {
  const rootChatId = randomUUID()
  chats.push(rootChatId)
  createChat(rootChatId, {
    runtime: { brain: 'mock_content', senseGroup: 'auto_senses', mcpServers: [] },
  })
  return rootChatId
}

/** 两段 compact + 当前代：u1/a1 | u2(token)/a2(摘要) | u3/a3 | u4(token)/a4(摘要) | u5/a5 */
function seedTwoGenerationChat(rootChatId: string): void {
  addMessage('g01-u1', rootChatId, { role: 'user', content: '第一轮' })
  addMessage('g02-a1', rootChatId, { role: 'assistant', content: '第一轮回答' })
  addMessage('g03-u2', rootChatId, { role: 'user', content: '[[command:/compact]]\n\n继续' })
  addMessage('g04-a2', rootChatId, {
    role: 'assistant',
    content: '<summary>第一段摘要</summary> 分析过程略',
    contextCompaction: true,
  })
  addMessage('g05-u3', rootChatId, { role: 'user', content: '第三轮' })
  addMessage('g06-a3', rootChatId, { role: 'assistant', content: '第三轮回答' })
  addMessage('g07-u4', rootChatId, { role: 'user', content: '[[command:/compact]]\n\n再来' })
  addMessage('g08-a4', rootChatId, {
    role: 'assistant',
    content: '<summary>第二段摘要</summary> 分析过程略',
    contextCompaction: true,
  })
  addMessage('g09-u5', rootChatId, { role: 'user', content: '当前代' })
  addMessage('g10-a5', rootChatId, { role: 'assistant', content: '当前代回答' })
}

describe('generations', () => {
  it('returns empty generations and the full window when the chat has no compact', () => {
    const rootChatId = newRootChat()
    addMessage('plain-u1', rootChatId, { role: 'user', content: '问题' })
    addMessage('plain-a2', rootChatId, { role: 'assistant', content: '回答' })

    expect(computeGenerations(rootChatId)).toEqual([])
    const snapshot = buildRootTimeline(rootChatId, 'conversation')
    expect(snapshot.generations).toEqual([])
    expect(generationWindowFloor(snapshot.generations)).toBe(0)
    expect(snapshot.nodes.map((node) => node.id)).toEqual(
      expect.arrayContaining(['plain-u1', 'plain-a2']),
    )
  })

  it('derives one entry per compact boundary with ordered intervals and summaries', () => {
    const rootChatId = newRootChat()
    seedTwoGenerationChat(rootChatId)
    buildRootTimeline(rootChatId, 'conversation')

    const generations = computeGenerations(rootChatId)
    expect(generations).toHaveLength(2)

    const [first, second] = generations
    expect(first).toMatchObject({
      index: 1,
      boundaryMessageId: 'g04-a2',
      boundaryNodeId: 'g04-a2',
      fromOrderKey: 0,
      summary: '第一段摘要',
      trigger: 'manual',
    })
    expect(second).toMatchObject({
      index: 2,
      boundaryMessageId: 'g08-a4',
      boundaryNodeId: 'g08-a4',
      summary: '第二段摘要',
      trigger: 'manual',
    })
    expect(second!.fromOrderKey).toBe(first!.boundaryOrderKey)
    // 首代节点：u1/a1/u2/a2；第二代节点：u3/a3/u4/a4
    expect(first!.nodeCount).toBe(4)
    expect(second!.nodeCount).toBe(4)
  })

  it('falls back to truncated content when the summary block is missing', () => {
    const rootChatId = newRootChat()
    addMessage('fb-u1', rootChatId, { role: 'user', content: '问题' })
    addMessage('fb-a2', rootChatId, {
      role: 'assistant',
      content: '模型没按格式输出的长摘要正文',
      contextCompaction: true,
    })
    buildRootTimeline(rootChatId, 'conversation')

    expect(computeGenerations(rootChatId)[0]).toMatchObject({
      boundaryMessageId: 'fb-a2',
      summary: '模型没按格式输出的长摘要正文',
    })
  })

  it('marks only the latest boundary auto from the send-side marker and consumes it', () => {
    const rootChatId = newRootChat()
    seedTwoGenerationChat(rootChatId)
    buildRootTimeline(rootChatId, 'conversation')

    recordAutoCompactTrigger(rootChatId)
    const marked = computeGenerations(rootChatId)
    expect(marked[1]!.trigger).toBe('auto')
    expect(marked[0]!.trigger).toBe('manual')

    // 标记已消费：重启后（无内存标记）重算一律 manual
    const recomputed = computeGenerations(rootChatId)
    expect(recomputed[1]!.trigger).toBe('manual')
  })

  it('windows the snapshot to the last two generations while generations index stays complete', () => {
    const rootChatId = newRootChat()
    seedTwoGenerationChat(rootChatId)
    const snapshot = buildRootTimeline(rootChatId, 'conversation')

    expect(snapshot.generations).toHaveLength(2)
    const floor = generationWindowFloor(snapshot.generations)
    expect(floor).toBe(computeGenerations(rootChatId)[0]!.boundaryOrderKey)
    // 窗口 = 上一代 + 当前代：第一代（u1/a1/u2/a2）被裁掉
    const ids = snapshot.nodes.map((node) => node.id)
    expect(ids).not.toContain('g01-u1')
    expect(ids).not.toContain('g04-a2')
    expect(ids).toEqual(
      expect.arrayContaining(['g05-u3', 'g06-a3', 'g07-u4', 'g08-a4', 'g09-u5', 'g10-a5']),
    )
    // edges 两端均在窗口内
    const windowIds = new Set(ids)
    for (const edge of snapshot.edges) {
      expect(windowIds.has(edge.fromNodeId)).toBe(true)
      expect(windowIds.has(edge.toNodeId)).toBe(true)
    }
  })

  it('serves a packed generation range via chat.timeline.generation.get without rebuilding', async () => {
    const rootChatId = newRootChat()
    seedTwoGenerationChat(rootChatId)
    buildRootTimeline(rootChatId, 'conversation')

    const response = await handleChatTimelineGenerationGet(
      { connectionId: 'gen-test' } as HandlerContext,
      { rootChatId, generationIndex: 1 },
    )
    expect(response.rootChatId).toBe(rootChatId)
    expect(response.generation.boundaryMessageId).toBe('g04-a2')
    const ids = response.nodes.map((node) => node.id)
    expect(ids).toEqual(expect.arrayContaining(['g01-u1', 'g02-a1', 'g03-u2', 'g04-a2']))
    expect(ids).not.toContain('g10-a5')
    // 区间节点数与索引 nodeCount 一致
    expect(response.nodes).toHaveLength(response.generation.nodeCount)

    await expect(
      handleChatTimelineGenerationGet({ connectionId: 'gen-test' } as HandlerContext, {
        rootChatId,
        generationIndex: 9,
      }),
    ).rejects.toThrow('代际 9 不存在')
  })

  it('short-circuits chat.timeline.get when knownRevision is current', async () => {
    const rootChatId = newRootChat()
    seedTwoGenerationChat(rootChatId)
    buildRootTimeline(rootChatId, 'conversation')
    const revision = getTimelineRevision(rootChatId)

    const unchanged = await handleChatTimelineGet({ connectionId: 'gen-test' } as HandlerContext, {
      rootChatId,
      knownRevision: revision,
    })
    expect(unchanged).toMatchObject({ chatId: rootChatId, revision, unchanged: true })
    expect(unchanged.rootTimeline).toBeUndefined()
    expect(unchanged.messages).toBeUndefined()

    const stale = await handleChatTimelineGet({ connectionId: 'gen-test' } as HandlerContext, {
      rootChatId,
      knownRevision: revision - 1,
    })
    expect(stale.unchanged).toBeUndefined()
    expect(stale.rootTimeline).toBeDefined()
  })

  it('rejects branching from a packed generation anchor but allows the current generation', async () => {
    const rootChatId = newRootChat()
    seedTwoGenerationChat(rootChatId)
    buildRootTimeline(rootChatId, 'conversation')

    const packed = await handleChatBranchPreview({ connectionId: 'gen-test' } as HandlerContext, {
      rootChatId,
      anchorNodeId: 'g02-a1',
    })
    tasks.push(packed.taskId)
    expect(packed.eligible).toBe(false)
    expect(packed.reason).toBe('只能在当前对话段内创建分支，已打包的历史不支持分支')

    const current = await handleChatBranchPreview({ connectionId: 'gen-test' } as HandlerContext, {
      rootChatId,
      anchorNodeId: 'g10-a5',
    })
    expect(current.taskId).toBe(packed.taskId)
    expect(current.eligible).toBe(true)
  })

  it('does not restrict branching when there is no compact history', async () => {
    const rootChatId = newRootChat()
    addMessage('nc-u1', rootChatId, { role: 'user', content: '问题' })
    addMessage('nc-a2', rootChatId, { role: 'assistant', content: '回答' })
    buildRootTimeline(rootChatId, 'conversation')

    const preview = await handleChatBranchPreview({ connectionId: 'gen-test' } as HandlerContext, {
      rootChatId,
      anchorNodeId: 'nc-a2',
    })
    tasks.push(preview.taskId)
    expect(preview.eligible).toBe(true)
  })
})
