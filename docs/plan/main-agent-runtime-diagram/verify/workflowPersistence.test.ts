// Isolated SQL adapter fixture: verifies JSON merge without opening any database.
import { describe, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ payload: undefined as string | undefined }))
vi.mock('@/db/index.js', () => ({
  getSoulDb: () => ({
    transaction: (fn: () => unknown) => fn,
    prepare: (sql: string) => ({
      get: () => (fixture.payload ? { order_key: 1, payload_json: fixture.payload } : undefined),
      run: (...args: unknown[]) => {
        if (!sql.includes('INSERT INTO execution_nodes'))
          throw new Error(`Unexpected write: ${sql}`)
        fixture.payload = args[6] as string
      },
    }),
  }),
}))
import { annotateExecutionNode, upsertExecutionNode } from '@/db/executionGraph.js'

describe('workflow final annotations', () => {
  it('preserves independent evidence across annotations and canonical regeneration', () => {
    const input = {
      id: 'message',
      rootChatId: 'root',
      sourceChatId: 'root',
      kind: 'message',
      orderKey: 1,
      createdAt: 1,
      updatedAt: 1,
    }
    upsertExecutionNode(input)
    annotateExecutionNode('message', { workflow: { commands: ['compact'] } })
    annotateExecutionNode('message', {
      workflow: { outcome: 'completed' },
      termination: { code: 'system_stop' },
    })
    annotateExecutionNode('message', { workflow: { compaction: { applied: true } } })
    const regenerated = upsertExecutionNode({ ...input, content: 'summary' })
    expect(regenerated.workflow).toEqual({
      commands: ['compact'],
      outcome: 'completed',
      compaction: { applied: true },
    })
    expect(regenerated.termination).toEqual({ code: 'system_stop' })
    expect(regenerated.orderKey).toBe(1)
  })
})
