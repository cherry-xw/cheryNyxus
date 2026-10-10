import { randomUUID } from 'crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createChat, deleteChat } from '@/db/chat.js'
import {
  approvalInteractionContext,
  questionInteractionContext,
} from '@/service/interaction/context.js'

const cleanup: string[] = []
afterEach(() => {
  for (const id of cleanup.splice(0).reverse()) deleteChat(id)
})

describe('interaction context', () => {
  it('keeps agent-provided question rationale and next step', () => {
    const root = randomUUID()
    const child = randomUUID()
    cleanup.push(root, child)
    createChat(root)
    createChat(child, { type: 'reviewer' }, root)

    expect(
      questionInteractionContext(child, {
        rationale: '需要确认兼容范围',
        nextStep: '确认后运行回归测试',
      }),
    ).toMatchObject({
      agent: 'reviewer',
      rationale: '需要确认兼容范围',
      nextStep: '确认后运行回归测试',
      source: 'agent',
    })
  })

  it('derives approval context without a model call', () => {
    const root = randomUUID()
    cleanup.push(root)
    createChat(root)
    const context = approvalInteractionContext(root, {
      senseName: 'write_file',
      senseDescription: '写入文件',
      arguments: JSON.stringify({ path: 'docs/result.md' }),
    })
    expect(context.rationale).toContain('docs/result.md')
    expect(context.nextStep).toContain('write_file')
    expect(context.source).toBe('fallback')
  })
})
