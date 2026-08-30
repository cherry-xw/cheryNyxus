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
})
