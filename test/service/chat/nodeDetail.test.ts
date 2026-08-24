import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ChatTimelineNodeToolCursor,
  GraphToolCall,
  TimelineNode,
} from '@/service/message/types.js'
import { Method } from '@/service/message/types.js'
import { requestSchemas } from '@/service/message/schemas.js'

let storedNode: TimelineNode

vi.mock('@/db/chat.js', () => ({ getChat: () => ({ id: 'root' }) }))
vi.mock('@/db/executionGraph.js', () => ({ listExecutionNodes: () => [storedNode] }))

import { handleChatTimelineNodeGet } from '@/service/chat/nodeDetail.js'

function baseNode(overrides: Partial<TimelineNode> = {}): TimelineNode {
  return {
    id: 'node-1',
    rootChatId: 'root',
    sourceChatId: 'root',
    kind: 'message',
    actor: { kind: 'agent', chatId: 'root' },
    direction: 'agent-to-user',
    visibility: 'conversation',
    content: '',
    orderKey: 1,
    createdAt: 1,
    updatedAt: 1,
    status: 'committed',
    ...overrides,
  }
}

describe('chat.timeline.node.get 分页协议', () => {
  beforeEach(() => {
    storedNode = baseNode()
  })

  it('content limit 生成连续 UTF-16 边界并正确声明 hasMore', async () => {
    const full = `${'a'.repeat(255)}😀${'中'.repeat(20)}`
    storedNode = baseNode({ content: full })
    let offset = 0
    let rebuilt = ''
    for (let guard = 0; offset < full.length && guard < 10; guard++) {
      const response = await handleChatTimelineNodeGet({} as never, {
        rootChatId: 'root',
        nodeId: 'node-1',
        sections: ['content'],
        offset,
        limit: 256,
      })
      const chunk = response.node.content
      expect(chunk).not.toMatch(/[\uD800-\uDBFF]$/)
      rebuilt += chunk
      offset += chunk.length
    }
    expect(rebuilt).toBe(full)
  })

  it('toolCursor 逐调用、逐 arguments/result 字段前进且不跳调用', async () => {
    const calls: GraphToolCall[] = Array.from({ length: 12 }, (_, index) => ({
      callId: `call-${index}`,
      index,
      name: `tool-${index}`,
      status: 'completed',
      arguments: `参数😀-${index}-`.repeat(7),
      result: `结果-${index}-`.repeat(6),
    }))
    storedNode = baseNode({ toolCalls: calls })
    let cursor: ChatTimelineNodeToolCursor | undefined = {
      callIndex: 0,
      field: 'arguments',
      offset: 0,
    }
    const rebuilt = calls.map(() => ({ arguments: '', result: '' }))
    for (let guard = 0; cursor && guard < 500; guard++) {
      const response = await handleChatTimelineNodeGet({} as never, {
        rootChatId: 'root',
        nodeId: 'node-1',
        sections: ['toolCalls'],
        limit: 9,
        toolCursor: cursor,
      })
      expect(response.node.toolCalls).toHaveLength(1)
      const page = response.page!
      expect(page.section).toBe('toolCalls')
      if (page.section !== 'toolCalls') throw new Error('unexpected page')
      const call = response.node.toolCalls![0]!
      rebuilt[page.cursor.callIndex]![page.cursor.field] += String(call[page.cursor.field] ?? '')
      if (page.nextCursor) expect(page.nextCursor).not.toEqual(cursor)
      cursor = page.nextCursor
    }
    expect(cursor).toBeUndefined()
    expect(rebuilt).toEqual(
      calls.map((call) => ({ arguments: call.arguments, result: call.result })),
    )
  })

  it('非法或被篡改的 toolCursor 在 schema 层拒绝', () => {
    const schema = requestSchemas[Method.CHAT_TIMELINE_NODE_GET]
    const valid = {
      rootChatId: 'root',
      nodeId: 'node-1',
      sections: ['toolCalls'],
      toolCursor: { callIndex: 0, field: 'arguments', offset: 0 },
    }
    expect(schema.safeParse(valid).success).toBe(true)
    expect(schema.safeParse({ ...valid, offset: 0 }).success).toBe(false)
    expect(schema.safeParse({ ...valid, sections: ['content'] }).success).toBe(false)
    expect(
      schema.safeParse({ ...valid, toolCursor: { ...valid.toolCursor, offset: -1 } }).success,
    ).toBe(false)
    expect(
      schema.safeParse({ ...valid, toolCursor: { ...valid.toolCursor, injected: 'x' } }).success,
    ).toBe(false)
    expect(
      schema.safeParse({ ...valid, toolCursor: { ...valid.toolCursor, field: 'other' } }).success,
    ).toBe(false)
  })
})
