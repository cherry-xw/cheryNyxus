import { describe, expect, it } from 'vitest'
import { ThinkingBlockAssembler } from '@/agent/provider/thinkingBlockAssembler.js'
import type { ThinkingBlockDelta } from '@/core/message/adapter.js'

describe('ThinkingBlockAssembler', () => {
  it('start→text×2→signature→stop → 单块完整', () => {
    const a = new ThinkingBlockAssembler()
    const ops: ThinkingBlockDelta[] = [
      { kind: 'start', index: 0, type: 'thinking' },
      { kind: 'text', index: 0, text: 'Hello ' },
      { kind: 'text', index: 0, text: 'world' },
      { kind: 'signature', index: 0, signature: 'sig-abc' },
      { kind: 'stop', index: 0 },
    ]
    for (const op of ops) a.push(op)

    expect(a.toArray()).toEqual([
      { type: 'thinking', thinking: 'Hello world', signature: 'sig-abc' },
    ])
  })

  it('两块交错：start(0)→start(1)→text(0)→text(1)→signature(1)→signature(0)', () => {
    const a = new ThinkingBlockAssembler()
    a.push({ kind: 'start', index: 0, type: 'thinking' })
    a.push({ kind: 'start', index: 1, type: 'thinking' })
    a.push({ kind: 'text', index: 0, text: 'A' })
    a.push({ kind: 'text', index: 1, text: 'B' })
    a.push({ kind: 'signature', index: 1, signature: 'sig-1' })
    a.push({ kind: 'signature', index: 0, signature: 'sig-0' })

    expect(a.toArray()).toEqual([
      { type: 'thinking', thinking: 'A', signature: 'sig-0' },
      { type: 'thinking', thinking: 'B', signature: 'sig-1' },
    ])
  })

  it('redacted_thinking 块（无 text/signature，仅 data）', () => {
    const a = new ThinkingBlockAssembler()
    a.push({ kind: 'start', index: 0, type: 'redacted_thinking' })
    a.push({ kind: 'text', index: 0, text: 'opaque-data-blob' })
    a.push({ kind: 'stop', index: 0 })

    expect(a.toArray()).toEqual([
      { type: 'redacted_thinking', data: 'opaque-data-blob' },
    ])
  })

  it('signature 不覆盖（同一 index 多次 push 取首条）', () => {
    const a = new ThinkingBlockAssembler()
    a.push({ kind: 'start', index: 0, type: 'thinking' })
    a.push({ kind: 'text', index: 0, text: 'x' })
    a.push({ kind: 'signature', index: 0, signature: 'first' })
    a.push({ kind: 'signature', index: 0, signature: 'second' })

    expect(a.toArray()).toEqual([{ type: 'thinking', thinking: 'x', signature: 'first' }])
  })

  it('text 出现在未知 index 上是 no-op（不抛错）', () => {
    const a = new ThinkingBlockAssembler()
    a.push({ kind: 'text', index: 99, text: 'orphan' })
    expect(a.toArray()).toEqual([])
  })

  it('reset 清空状态', () => {
    const a = new ThinkingBlockAssembler()
    a.push({ kind: 'start', index: 0, type: 'thinking' })
    a.push({ kind: 'text', index: 0, text: 'x' })
    a.push({ kind: 'signature', index: 0, signature: 's' })
    expect(a.toArray()).toHaveLength(1)
    a.reset()
    expect(a.toArray()).toEqual([])
    // reset 后可复用
    a.push({ kind: 'start', index: 0, type: 'thinking' })
    a.push({ kind: 'text', index: 0, text: 'y' })
    expect(a.toArray()).toEqual([{ type: 'thinking', thinking: 'y', signature: '' }])
  })

  it('toArray 按 index 升序输出', () => {
    const a = new ThinkingBlockAssembler()
    a.push({ kind: 'start', index: 2, type: 'thinking' })
    a.push({ kind: 'text', index: 2, text: 'C' })
    a.push({ kind: 'start', index: 0, type: 'thinking' })
    a.push({ kind: 'text', index: 0, text: 'A' })
    a.push({ kind: 'start', index: 1, type: 'thinking' })
    a.push({ kind: 'text', index: 1, text: 'B' })
    expect(a.toArray().map((b) => (b.type === 'thinking' ? b.thinking : ''))).toEqual([
      'A',
      'B',
      'C',
    ])
  })

  it('混合 thinking + redacted 块按 index 顺序输出', () => {
    const a = new ThinkingBlockAssembler()
    a.push({ kind: 'start', index: 0, type: 'thinking' })
    a.push({ kind: 'text', index: 0, text: 'visible' })
    a.push({ kind: 'signature', index: 0, signature: 'sig' })
    a.push({ kind: 'start', index: 1, type: 'redacted_thinking' })
    a.push({ kind: 'text', index: 1, text: 'hidden' })
    a.push({ kind: 'stop', index: 1 })

    const out = a.toArray()
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({ type: 'thinking', thinking: 'visible', signature: 'sig' })
    expect(out[1]).toEqual({ type: 'redacted_thinking', data: 'hidden' })
  })
})