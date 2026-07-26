/**
 * createLoopHandler 单元测试（loop 停止条件 + maxLoop + done/error）。
 *
 * 覆盖：
 * - content-only（assistant 无 senseCalls）→ stop
 * - 末尾 sense → continue
 * - assistant with senseCalls → continue
 * - 空 messages + 无 userInputs → stop
 * - residual userInputs → continue（到 maxLoop）
 * - revoked 末尾 → 跳过取 lastVisible
 * - maxLoop 超限 → yield ErrorChunk（抑制 done，P2 失败路径不双发 done/Response.success:true）
 * - 正常停止 → yield done
 */
import { describe, it, expect } from 'vitest'
import { createLoopHandler } from '@/agent/middleware/loop.js'
import { AgentAbortError } from '@/core/middleware/errors.js'
import type { MiddlewareContext, MiddlewareChunk } from '@/core/middleware/types.js'
import { SupervisionLevel } from '@/core/config.js'
import { createMockContext } from '../helpers/fakeContext.js'
import { collectChunks, firstError, hasDone } from '../helpers/chunkAssert.js'

interface Step {
  /** runChain 执行时对 ctx 的副作用（通常修改 messages） */
  modify?: (ctx: MiddlewareContext) => void
  /** runChain yield 的 chunks */
  yields?: MiddlewareChunk[]
}

/** 构造 runChain：每次调用消费一个 step，耗尽后重复最后 */
function makeRunChain(
  ctx: MiddlewareContext,
  steps: Step[],
): () => AsyncGenerator<MiddlewareChunk, void, unknown> {
  let i = 0
  return async function* runChain(): AsyncGenerator<MiddlewareChunk, void, unknown> {
    const step = steps[Math.min(i, steps.length - 1)]
    i++
    step?.modify?.(ctx)
    for (const c of step?.yields ?? []) yield c
  }
}

function assistantMsg(
  content: string,
  senseCalls?: { id: string; name: string; arguments: string }[],
): MiddlewareContext['soul']['messages'][number] {
  return {
    id: `a-${Math.random()}`,
    role: 'assistant',
    content,
    senseCalls,
    createdAt: 0,
    updateAt: 0,
  }
}

function senseMsg(content: string): MiddlewareContext['soul']['messages'][number] {
  return { id: `s-${Math.random()}`, role: 'sense', content, createdAt: 0, updateAt: 0 }
}

describe('createLoopHandler 停止条件', () => {
  it('watchdog abort 后本轮自然返回，也不得按末尾 sense 开启下一轮', async () => {
    const ctx = createMockContext({ messages: [] })
    let aborted = false
    ctx.pipeline = {
      consumeParkAfterTurn: () => false,
      isAbortRequested: () => aborted,
      getAbortSignal: () => undefined,
    }
    let calls = 0
    const runChain = async function* (): AsyncGenerator<MiddlewareChunk, void, unknown> {
      calls++
      ctx.soul.messages!.push(senseMsg('tool-result'))
      // 模拟 provider 在 abort 后自然结束，而非向 loop 抛异常。
      aborted = true
    }

    await expect(collectChunks(createLoopHandler(10)(ctx, runChain))).rejects.toBeInstanceOf(
      AgentAbortError,
    )
    expect(calls).toBe(1)
  })

  it('resume 时清除上轮 yieldTurn，不会再次截断已回传的角色结果', async () => {
    const ctx = createMockContext({ messages: [] })
    ctx.soul.yieldTurn = true
    let calls = 0
    const runChain = async function* (): AsyncGenerator<MiddlewareChunk, void, unknown> {
      calls++
      ctx.soul.messages!.push(assistantMsg('consumed role reply'))
      yield { type: 'stream', thinkingDelta: '', contentDelta: '' } as MiddlewareChunk
    }

    const out = await collectChunks(createLoopHandler(10)(ctx, runChain))
    expect(calls).toBe(1)
    expect(hasDone(out)).toBe(true)
  })

  it('运行中收到角色回复时，在当前 assistant 输出后继续一轮', async () => {
    const ctx = createMockContext({ messages: [] })
    let calls = 0
    const runChain = async function* (): AsyncGenerator<MiddlewareChunk, void, unknown> {
      calls++
      ctx.soul.messages!.push(assistantMsg(`reply-${calls}`))
      if (calls === 1) ctx.soul.roleReplyPending = true
      yield { type: 'stream', thinkingDelta: '', contentDelta: '' } as MiddlewareChunk
    }

    const out = await collectChunks(createLoopHandler(10)(ctx, runChain))
    expect(calls).toBe(2)
    expect(hasDone(out)).toBe(true)
  })

  it('content-only（assistant 无 senseCalls）→ 1 次迭代后 stop + done', async () => {
    const ctx = createMockContext({ messages: [] })
    let calls = 0
    const runChain = async function* (): AsyncGenerator<MiddlewareChunk, void, unknown> {
      calls++
      ctx.soul.messages!.push(assistantMsg('reply'))
      yield { type: 'stream', thinkingDelta: '', contentDelta: 'reply' } as MiddlewareChunk
    }
    const out = await collectChunks(createLoopHandler(10)(ctx, runChain))
    expect(calls).toBe(1)
    expect(hasDone(out)).toBe(true)
    expect(firstError(out)).toBeUndefined()
  })

  it('末尾 sense → continue；下一轮 assistant 无 senseCalls → stop', async () => {
    const ctx = createMockContext({ messages: [] })
    let calls = 0
    const runChain = async function* (): AsyncGenerator<MiddlewareChunk, void, unknown> {
      calls++
      if (calls === 1) {
        ctx.soul.messages!.push(senseMsg('result'))
      } else {
        ctx.soul.messages!.push(assistantMsg('final'))
      }
      yield { type: 'stream', thinkingDelta: '', contentDelta: '' } as MiddlewareChunk
    }
    const out = await collectChunks(createLoopHandler(10)(ctx, runChain))
    expect(calls).toBe(2)
    expect(hasDone(out)).toBe(true)
  })

  it('assistant with senseCalls → continue；下一轮 content → stop', async () => {
    const ctx = createMockContext({ messages: [] })
    let calls = 0
    const runChain = async function* (): AsyncGenerator<MiddlewareChunk, void, unknown> {
      calls++
      if (calls === 1) {
        ctx.soul.messages!.push(
          assistantMsg('calling', [{ id: 'sc1', name: 'read_file', arguments: '{}' }]),
        )
      } else {
        ctx.soul.messages!.push(assistantMsg('done'))
      }
      yield { type: 'stream', thinkingDelta: '', contentDelta: '' } as MiddlewareChunk
    }
    const out = await collectChunks(createLoopHandler(10)(ctx, runChain))
    expect(calls).toBe(2)
    expect(hasDone(out)).toBe(true)
  })

  it('空 messages + 无 userInputs → stop（runChain 不 push）', async () => {
    const ctx = createMockContext({ messages: [] })
    let calls = 0
    const runChain = async function* (): AsyncGenerator<MiddlewareChunk, void, unknown> {
      calls++
      yield { type: 'stream', thinkingDelta: '', contentDelta: '' } as MiddlewareChunk
    }
    const out = await collectChunks(createLoopHandler(10)(ctx, runChain))
    expect(calls).toBe(1)
    expect(hasDone(out)).toBe(true)
  })
})

describe('createLoopHandler revoked 与 userInputs', () => {
  it('末尾 revoked sense → 跳过取 lastVisible（前置 assistant 无 senseCalls → stop）', async () => {
    const ctx = createMockContext({
      messages: [assistantMsg('prev'), { ...senseMsg('done'), revoked: true }],
    })
    let calls = 0
    const runChain = async function* (): AsyncGenerator<MiddlewareChunk, void, unknown> {
      calls++
      yield { type: 'stream', thinkingDelta: '', contentDelta: '' } as MiddlewareChunk
    }
    const out = await collectChunks(createLoopHandler(10)(ctx, runChain))
    expect(calls).toBe(1) // lastVisible=assistant(prev) 无 senseCalls → stop
    expect(hasDone(out)).toBe(true)
  })

  it('residual userInputs + 持续空 messages → continue 到 maxLoop（yield error，抑制 done）', async () => {
    const ctx = createMockContext({
      messages: [],
      userInputs: [{ content: 'queued', time: 0 }],
    })
    let calls = 0
    const runChain = async function* (): AsyncGenerator<MiddlewareChunk, void, unknown> {
      calls++
      yield { type: 'stream', thinkingDelta: '', contentDelta: '' } as MiddlewareChunk
    }
    // maxLoop=2：iteration1 empty+userInputs→continue, iteration2 同→continue, while 退出→error
    const out = await collectChunks(createLoopHandler(2)(ctx, runChain))
    expect(calls).toBe(2)
    const err = firstError(out)
    expect(err).toBeDefined()
    expect(err!.errors[0]!.message).toContain('最大循环次数')
    // P2：失败路径不 yield done（避免 streamMapper 双发 done notification + Response.success:true）
    expect(hasDone(out)).toBe(false)
  })
})

describe('createLoopHandler maxLoop', () => {
  it('持续 sense 不停止 → 到 maxLoop yield ErrorChunk（抑制 done）', async () => {
    const ctx = createMockContext({ messages: [] })
    let calls = 0
    const runChain = async function* (): AsyncGenerator<MiddlewareChunk, void, unknown> {
      calls++
      ctx.soul.messages!.push(senseMsg('loop-result'))
      yield { type: 'stream', thinkingDelta: '', contentDelta: '' } as MiddlewareChunk
    }
    const out = await collectChunks(createLoopHandler(3)(ctx, runChain))
    expect(calls).toBe(3)
    const err = firstError(out)
    expect(err).toBeDefined()
    expect(err!.errors[0]!.recoverable).toBe(false)
    // P2：失败路径不 yield done
    expect(hasDone(out)).toBe(false)
  })

  it('makeRunChain helper：step 序列按顺序消费', async () => {
    const ctx = createMockContext({ messages: [] })
    const runChain = makeRunChain(ctx, [
      {
        modify: (c) =>
          c.soul.messages!.push(
            assistantMsg('a', [{ id: 'x', name: 'read_file', arguments: '{}' }]),
          ),
        yields: [],
      },
      { modify: (c) => c.soul.messages!.push(assistantMsg('final')), yields: [] },
    ])
    const out = await collectChunks(createLoopHandler(10)(ctx, runChain))
    expect(hasDone(out)).toBe(true)
    expect(ctx.soul.messages!.length).toBeGreaterThanOrEqual(2)
  })
})

describe('createLoopHandler P2 失败路径', () => {
  it('runChain yield ErrorChunk（retry 耗尽）→ 不 yield done（抑制双发）', async () => {
    const ctx = createMockContext({ messages: [] })
    const runChain = async function* (): AsyncGenerator<MiddlewareChunk, void, unknown> {
      // 模拟 retry 耗尽：yield ErrorChunk + return
      yield {
        type: 'error',
        errors: [
          {
            attempt: 3,
            timestamp: 0,
            message: '401 invalid access token',
            recoverable: false,
            category: 'provider',
          },
        ],
      } as MiddlewareChunk
    }
    const out = await collectChunks(createLoopHandler(5)(ctx, runChain))
    const err = firstError(out)
    expect(err).toBeDefined()
    expect(err!.errors[0]!.message).toContain('401')
    // P2 关键回归：失败路径不 yield done（避免 streamMapper 下发 done notification + send.ts 返回 success:true）
    expect(hasDone(out)).toBe(false)
  })
})
