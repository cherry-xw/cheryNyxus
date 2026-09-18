import { describe, expect, it } from 'vitest'
import { createLiteDetailSectionState, mergeDetailSectionPage } from '@/features/lite/detailSections'

describe('Lite tool detail pagination', () => {
  it('uses the server tool cursor to rebuild arguments and results without offset paging', () => {
    const first = mergeDetailSectionPage(
      createLiteDetailSectionState(),
      'toolCalls',
      {
        rootChatId: 'root', refs: [], hasMore: true,
        node: { id: 'node', content: '', toolCalls: [{
          callId: 'call', index: 0, name: 'read_file', status: 'completed', arguments: '{"path"',
        }] },
        page: {
          section: 'toolCalls',
          cursor: { callIndex: 0, field: 'arguments', offset: 0 },
          consumed: 7,
          nextCursor: { callIndex: 0, field: 'arguments', offset: 7 },
        },
      } as never,
      0,
      30_000,
    )
    expect(first.toolCursor).toEqual({ callIndex: 0, field: 'arguments', offset: 7 })
    expect(first.toolCalls[0]?.arguments).toBe('{"path"')

    const completed = mergeDetailSectionPage(
      first,
      'toolCalls',
      {
        rootChatId: 'root', refs: [], hasMore: false,
        node: { id: 'node', content: '', toolCalls: [{
          callId: 'call', index: 0, name: 'read_file', status: 'completed',
          arguments: ':"fixture"}', result: 'file content',
        }] },
        page: {
          section: 'toolCalls',
          cursor: { callIndex: 0, field: 'arguments', offset: 7 },
          consumed: 11,
        },
      } as never,
      0,
      30_000,
    )
    expect(completed.hasMore).toBe(false)
    expect(completed.toolCursor).toBeUndefined()
    expect(completed.toolCalls[0]).toMatchObject({
      arguments: '{"path":"fixture"}', result: 'file content',
    })
  })

  it('terminates a cursor page whose chunk fills the limit but has no next cursor', () => {
    // 最后一块恰好凑满 limit（consumed === 30000）时，服务端 hasMore=false 已是权威判定；
    // 不能再套 fullPage 兜底，否则 hasMore 恒真、「加载更多」按钮卡死无法终止。
    const first = mergeDetailSectionPage(
      createLiteDetailSectionState(),
      'toolCalls',
      {
        rootChatId: 'root', refs: [], hasMore: true,
        node: { id: 'node', content: '', toolCalls: [{
          callId: 'call', index: 0, name: 'execute_command', status: 'completed',
          arguments: '{"command":"long".repeat(1)}',
        }] },
        page: {
          section: 'toolCalls',
          cursor: { callIndex: 0, field: 'arguments', offset: 0 },
          consumed: 30_000,
          nextCursor: { callIndex: 0, field: 'result', offset: 0 },
        },
      } as never,
      0,
      30_000,
    )
    expect(first.hasMore).toBe(true)

    const last = mergeDetailSectionPage(
      first,
      'toolCalls',
      {
        rootChatId: 'root', refs: [], hasMore: false,
        node: { id: 'node', content: '', toolCalls: [{
          callId: 'call', index: 0, name: 'execute_command', status: 'completed',
          arguments: '', result: 'x'.repeat(30_000),
        }] },
        page: {
          section: 'toolCalls',
          cursor: { callIndex: 0, field: 'result', offset: 0 },
          consumed: 30_000,
        },
      } as never,
      0,
      30_000,
    )
    expect(last.hasMore).toBe(false)
    expect(last.toolCursor).toBeUndefined()
  })
})
