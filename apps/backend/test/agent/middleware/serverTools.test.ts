import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { senseMiddleware } from '@/agent/middleware/tool.js'
import { CheckpointState, mergeServerToolDeltas } from '@/agent/middleware/checkpointState.js'
import { SupervisionLevel } from '@/core/config.js'
import type { StreamChunk } from '@/core/middleware/types.js'
import { collectChunks } from '../helpers/chunkAssert.js'
import {
  createMockContext,
  createMockRuntime,
  createTestSense,
  makeNext,
} from '../helpers/fakeContext.js'

const chunk = (fields: Partial<StreamChunk>): StreamChunk => ({
  type: 'stream',
  thinkingDelta: '',
  contentDelta: '',
  ...fields,
})

describe('服务端与普通工具混合响应', () => {
  it('两个普通调用后才收到服务端完成结果时，不提前创建本地审批或执行记录', async () => {
    const execute = vi.fn(async () => ({ content: 'local result', hash: '' }))
    const runtime = createMockRuntime({
      senses: [createTestSense('web_fetch', execute, SupervisionLevel.manual, z.object({}))],
    })
    runtime.adapters.messageAdapter.extractStreamServerToolDeltas = () => undefined
    const ctx = createMockContext({ runtime })
    const chunks = [
      chunk({ senseDelta: [{ index: 0, id: 'local-1', name: 'web_fetch', arguments: '{}' }] }),
      chunk({ senseDelta: [{ index: 1, id: 'local-2', name: 'web_fetch', arguments: '{}' }] }),
      chunk({
        serverToolDeltas: [
          { kind: 'start', index: 2, id: 'server-1', name: 'webReader' },
          { kind: 'result', index: 3, callId: 'server-1', status: 'completed', result: 'page' },
        ],
        stopReason: 'end_turn',
      }),
    ]
    const output = await collectChunks(senseMiddleware(ctx, makeNext(chunks)))
    expect(execute).not.toHaveBeenCalled()
    expect(output.map((item) => item.type)).toEqual(['stream', 'stream', 'stream'])
    const state = new CheckpointState()
    chunks.forEach((item) => state.ingest(item))
    const message = state.flushAssistant(ctx)!
    expect(message.senseCalls).toEqual([])
    expect(message.serverToolCalls?.map((call) => [call.id, call.status])).toEqual([
      ['server-1', 'completed'],
      ['local-1', 'skipped-local'],
      ['local-2', 'skipped-local'],
    ])
  })

  it('tool_use 结束时，服务端已完成也不吞掉真正的本地调用', async () => {
    const execute = vi.fn(async () => ({ content: 'local result', hash: '' }))
    const runtime = createMockRuntime({
      senses: [createTestSense('web_fetch', execute, SupervisionLevel.auto, z.object({}))],
    })
    runtime.adapters.messageAdapter.extractStreamServerToolDeltas = () => undefined
    const ctx = createMockContext({ runtime })
    const output = await collectChunks(
      senseMiddleware(
        ctx,
        makeNext([
          chunk({ senseDelta: [{ index: 0, id: 'local-1', name: 'web_fetch', arguments: '{}' }] }),
          chunk({
            serverToolDeltas: [
              { kind: 'result', index: 1, callId: 'server-1', status: 'completed', result: 'page' },
            ],
            stopReason: 'tool_use',
          }),
        ]),
      ),
    )
    expect(execute).toHaveBeenCalledTimes(1)
    expect(output.some((item) => item.type === 'sense_accept')).toBe(true)
  })

  it('断流的部分参数脱敏且不补造完成结果', () => {
    const calls = mergeServerToolDeltas([
      { kind: 'start', index: 0, id: 'server-1', name: 'unknown_tool' },
      { kind: 'arguments_delta', index: 0, argumentsDelta: '{"token":"private-incomplete' },
    ])
    expect(calls).toMatchObject([
      { id: 'server-1', status: 'started', arguments: '{"token":"[REDACTED]' },
    ])
    expect(calls[0]?.result).toBeUndefined()
  })
})
