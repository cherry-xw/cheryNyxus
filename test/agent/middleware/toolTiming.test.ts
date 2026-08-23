import { describe, expect, it } from 'vitest'
import { senseMiddleware } from '@/agent/middleware/tool.js'
import type { MiddlewareChunk } from '@/core/middleware/types.js'
import { SupervisionLevel } from '@/core/config.js'
import { approve } from '../helpers/agentHarness.js'
import {
  createMockContext,
  createMockRuntime,
  createTestSense,
  makeNext,
  streamChunk,
} from '../helpers/fakeContext.js'

async function collectWithOrder(
  generator: AsyncGenerator<MiddlewareChunk, void, unknown>,
  order: string[],
  onChunk?: (chunk: MiddlewareChunk) => void,
): Promise<MiddlewareChunk[]> {
  const chunks: MiddlewareChunk[] = []
  for await (const chunk of generator) {
    chunks.push(chunk)
    if (chunk.type === 'sense_started') order.push(`started:${chunk.id}`)
    if (chunk.type === 'sense_accept') order.push(`accepted:${chunk.id}`)
    if (chunk.type === 'sense_reject') order.push(`rejected:${chunk.id}`)
    onChunk?.(chunk)
  }
  return chunks
}

describe('senseMiddleware 工具真实执行边界', () => {
  it('多个 auto 工具逐个 started → execute → accept，不在模型调用阶段提前 started', async () => {
    const order: string[] = []
    const first = createTestSense('first_tool', async () => {
      order.push('execute:first')
      return { content: 'first ok', hash: '' }
    })
    const second = createTestSense('second_tool', async () => {
      order.push('execute:second')
      return { content: 'second ok', hash: '' }
    })
    const ctx = createMockContext({ runtime: createMockRuntime({ senses: [first, second] }) })
    const chunks = await collectWithOrder(
      senseMiddleware(
        ctx,
        makeNext([
          streamChunk({
            senseDelta: [
              { index: 0, id: 'tool-1', name: 'first_tool', arguments: '{}' },
              { index: 1, id: 'tool-2', name: 'second_tool', arguments: '{}' },
            ],
          }),
        ]),
      ),
      order,
    )

    expect(order).toEqual([
      'started:tool-1',
      'execute:first',
      'accepted:tool-1',
      'started:tool-2',
      'execute:second',
      'accepted:tool-2',
    ])
    const firstStarted = chunks.findIndex(
      (chunk) => chunk.type === 'sense_started' && chunk.id === 'tool-1',
    )
    const firstTrigger = chunks.findIndex(
      (chunk) => chunk.type === 'sense_end' && chunk.id === 'tool-1',
    )
    expect(firstStarted).toBeGreaterThan(firstTrigger)
  })

  it('审批等待不产生 started；批准后才 started，拒绝则零 started', async () => {
    const approvedOrder: string[] = []
    const approvedTool = createTestSense(
      'approved_tool',
      async () => {
        approvedOrder.push('execute:approved')
        return { content: 'ok', hash: '' }
      },
      SupervisionLevel.manual,
    )
    const approvedCtx = createMockContext({
      runtime: createMockRuntime({ senses: [approvedTool] }),
    })
    const approvedChunks = await collectWithOrder(
      senseMiddleware(
        approvedCtx,
        makeNext([
          streamChunk({
            senseDelta: [{ id: 'approved-1', name: 'approved_tool', arguments: '{}' }],
          }),
        ]),
      ),
      approvedOrder,
      (chunk) => {
        if (chunk.type === 'sense_end') {
          expect(approvedOrder).not.toContain('started:approved-1')
          approve(chunk.id, 'accept')
        }
      },
    )
    expect(approvedOrder).toEqual([
      'started:approved-1',
      'execute:approved',
      'accepted:approved-1',
    ])
    expect(approvedChunks.some((chunk) => chunk.type === 'sense_started')).toBe(true)

    const rejectedOrder: string[] = []
    const rejectedTool = createTestSense(
      'rejected_tool',
      async () => {
        rejectedOrder.push('execute:rejected')
        return { content: 'unexpected', hash: '' }
      },
      SupervisionLevel.manual,
    )
    const rejectedCtx = createMockContext({
      runtime: createMockRuntime({ senses: [rejectedTool] }),
    })
    const rejectedChunks = await collectWithOrder(
      senseMiddleware(
        rejectedCtx,
        makeNext([
          streamChunk({
            senseDelta: [{ id: 'rejected-1', name: 'rejected_tool', arguments: '{}' }],
          }),
        ]),
      ),
      rejectedOrder,
      (chunk) => {
        if (chunk.type === 'sense_end') approve(chunk.id, 'reject', 'no')
      },
    )
    expect(rejectedOrder).toEqual(['rejected:rejected-1'])
    expect(rejectedChunks.some((chunk) => chunk.type === 'sense_started')).toBe(false)
  })
})
