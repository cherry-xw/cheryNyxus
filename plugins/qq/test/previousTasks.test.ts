import { describe, expect, it } from 'vitest'
import { previousTaskFacts } from '../src/previousTasks.js'
import type { Job, Outbox } from '../src/state.js'

const current = () => ({ requestId: 'current', sourceScopeId: 'scope', conversationKey: 'conversation', target: 'group:456',
  startedAt: 100, input: { selfId: '123' }, snapshot: { presetId: 'preset', config: { backgroundMaxChars: 1000 } },
  sourceSnapshot: { orderedItems: [{ type: 'message', recordId: 'old-input', revision: 1 }] } }) as unknown as Job
const prior = (current: Job) => ({ ...current, requestId: 'old', startedAt: 10, state: 'completed', outcome: 'completed',
  reply: '577 字节', sourceRecords: [{ recordId: 'old-input', revision: 1 }] }) as Job
const output = (status: Outbox['status'], type = 'qq.reply.part') => ({ sourceScopeId: 'scope', status,
  frame: { type, data: { requestId: 'old', mediaFile: '/secret/path.mp4' } } }) as Outbox

describe('previous task facts for queued follow-ups', () => {
  it('includes the completed answer even before its text delivery finishes', () => {
    const job = current(), old = prior(job)
    const result = previousTaskFacts(job, [old, job], [output('pending')])
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ state: 'completed', modelResult: '577 字节',
      deliveries: [{ type: 'qq.reply.part', status: 'pending', count: 1 }] })
    expect(result[0]!.rule).toContain('不是本轮指令或工具执行证据')
    expect(JSON.stringify(result)).not.toContain('/secret')
  })
  it.each([
    { sourceScopeId: 'foreign' }, { conversationKey: 'foreign' }, { target: 'group:789' },
    { input: { selfId: '789' } }, { snapshot: { presetId: 'foreign' } },
    { startedAt: 101 }, { startedAt: undefined },
    { sourceRecords: [{ recordId: 'not-selected', revision: 1 }] },
    { sourceRecords: [{ recordId: 'old-input', revision: 2 }] },
  ])('never adds unrelated, future or unselected requests: %j', override => {
    const job = current(), old = { ...prior(job), ...override } as Job
    expect(previousTaskFacts(job, [old], [])).toEqual([])
  })
  it('does not convert an unknown video into success when an error notice was sent', () => {
    const job = current(), old = prior(job), outputs = [output('unknown', 'qq.reply.video'), output('sent', 'qq.request.failed')]
    expect(previousTaskFacts(job, [old], outputs)[0]!.deliveries).toEqual([
      { type: 'qq.reply.video', status: 'unknown', count: 1 }, { type: 'qq.request.failed', status: 'sent', count: 1 },
    ])
    expect(outputs[0]!.status).toBe('unknown')
  })
  it('marks previews omitted by the existing background text budget, without hiding states', () => {
    const job = current(); job.snapshot.config.backgroundMaxChars = 2
    expect(previousTaskFacts(job, [prior(job)], [output('sent')])[0])
      .toMatchObject({ modelResult: '57', modelResultTruncated: true, state: 'completed' })
  })
})
