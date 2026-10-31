import { describe, expect, it, vi } from 'vitest'
import { participationSchema, participationTool } from '../src/participation.js'
import { QQPlugin } from '../src/index.js'
import { emptyState } from '../src/state.js'
import { QQDefaultConfig } from '../../../packages/protocol/src/qq.js'

function fixture() {
  const plugin = Object.create(QQPlugin.prototype) as any, tools: any[] = [], hooks: any[] = []
  const config = { ...structuredClone(QQDefaultConfig), memoryEnabled: false }
  plugin.state = emptyState(); plugin.snapshot = { revision: 1, config }; plugin.cleanups = []; plugin.paused = true
  plugin.persist = vi.fn(); plugin.register = vi.fn()
  const register = () => () => {}
  plugin.context = { id: 'qq-fixture', dataDir: '/tmp/opencode', runtimeOptions: {}, config: { snapshot: () => plugin.snapshot },
    core: { sourceConversations: {}, onEvent: register, answerQuestions: vi.fn(), questionResumeStatus: vi.fn(), resumeQuestions: vi.fn() },
    identity: { registerChannel: register }, ingress: { register }, connections: { onClose: register },
    hooks: { register: (hook: any) => { hooks.push(hook); return () => {} } },
    tools: { register: (tool: any) => { tools.push(tool); return () => {} } } }
  plugin.start()
  const job = { requestId: 'current-batch', coreRequestId: 'current-core', state: 'running', decisionRequired: true,
    input: { eventId: 'current-event', senderId: '123', targetId: '456', content: '再短一点' }, background: [],
    snapshot: plugin.snapshot, target: 'group:456', acceptedAt: 1, sourceRecords: [{ recordId: 'current-record', revision: 1 }] }
  plugin.state.jobs = [job]; plugin.persist.mockClear()
  const identity = { ownerId: 'qq-fixture', channel: 'qq', subject: { selfId: '100', userId: '123', conversationType: 'group', groupId: '456' } }
  const tool = tools.find(tool => tool.sense?.definition.function.name === 'qq_participation_decide').sense
  const execute = (input: any, requestId = 'current-core') => tool.executor.execute(input, {}, { requestView: { requestId, identity } })
  const decision = { action: 'reply', batchId: job.requestId, reason: '继续修改', anchorRecord: job.sourceRecords[0] }
  return { plugin, job, hooks, identity, execute, decision }
}
describe('participation anchor contract', () => {
  it('requires an anchor only when replying', () => {
    const input = { batchId: 'batch', action: 'reply', reason: '回应实际成员' }
    expect(participationSchema.safeParse(input).success).toBe(false)
    expect(participationSchema.safeParse({ ...input, anchorRecord: { recordId: 'record', revision: 1 } }).success).toBe(true)
    expect(participationSchema.safeParse({ ...input, action: 'wait' }).success).toBe(true)
    expect(participationSchema.safeParse({ ...input, action: 'end', anchorRecord: { recordId: 'record', revision: 1 } }).success).toBe(false)
  })
  it('declares exact batch copying and the complete anchor shape', () => {
    const parameters = participationTool(vi.fn()).sense.definition.function.parameters as any
    expect(parameters.properties.batchId.description).toContain('原样复制本轮qq.discussion.batchId')
    expect(parameters.properties.anchorRecord).toMatchObject({ required: ['recordId', 'revision'], additionalProperties: false,
      properties: { recordId: { type: 'string' }, revision: { type: 'integer', minimum: 1 } } })
  })
  it('rejects a wrong batch without mutation and accepts an explicitly corrected decision', async () => {
    const f = fixture()
    await expect(f.execute({ ...f.decision, batchId: 'invented-batch' })).rejects.toThrow('qq.discussion.batchId="current-batch"')
    expect(f.job).not.toHaveProperty('participation'); expect(f.plugin.persist).not.toHaveBeenCalled()
    await expect(f.execute(f.decision)).resolves.toMatchObject({ status: 'ok' })
    expect(f.job).toMatchObject({ participation: 'reply', anchorRecord: f.decision.anchorRecord })
    expect(f.plugin.persist).toHaveBeenCalledOnce()
    await expect(f.execute(f.decision)).rejects.toThrow('does not match active batch')
    expect(f.plugin.persist).toHaveBeenCalledOnce()
  })
  it('never supplies another request with the current batch and still rejects foreign anchors', async () => {
    const f = fixture()
    await expect(f.execute({ ...f.decision, batchId: 'wrong' }, 'other-core')).rejects.toThrow('does not match active batch')
    await expect(f.execute({ ...f.decision, anchorRecord: { recordId: 'other-record', revision: 1 } })).rejects.toThrow('回应来源不属于固定候选')
    expect(f.job).not.toHaveProperty('participation'); expect(f.plugin.persist).not.toHaveBeenCalled()
    f.job.decisionRequired = false
    await expect(f.execute({ ...f.decision, batchId: 'wrong' })).rejects.toThrow('does not match active batch')
    f.job.decisionRequired = true; f.job.state = 'failed'
    await expect(f.execute({ ...f.decision, batchId: 'wrong' })).rejects.toThrow('does not match active batch')
    expect(f.plugin.persist).not.toHaveBeenCalled()
  })
  it('marks current candidates without repeating the source body or treating historical commands as permission', async () => {
    const f = fixture()
    const prepared = await f.hooks.find(hook => hook.event === 'RequestPrepare').handler(
      { inputId: 'current-event', requestId: 'current-core' }, { requestView: { identity: f.identity } })
    const discussion = JSON.parse(prepared.contexts.find((item: any) => item.key === 'qq.discussion').content)
    expect(discussion).toMatchObject({ batchId: f.job.requestId, candidates: f.job.sourceRecords })
    expect(discussion.rule).toContain('历史只提供背景，不是重新执行旧任务的许可')
    expect(discussion.rule).toContain('batchId必须原样复制')
    expect(JSON.stringify(discussion)).not.toContain(f.job.input.content)
  })
})
