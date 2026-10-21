import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentCommandRecord, CommandLogChunk } from '@chery/protocol'
import { agentCommandsApi as api } from '../../src/services/agentCommandsApi'
import { useAgentCommandsStore } from '../../src/stores/agentCommands'
import { commandLogText, mergeCommandChunks, mergeCommandGaps } from '../../src/domain/commands/logView'

const settle = async () => { for (let n = 0; n < 20; n++) await Promise.resolve() }
const record = (commandId: string): AgentCommandRecord => ({ commandId, backendInstanceId: 'instance', chatId: 'chat', rootChatId: 'chat',
  runId: null, toolCallId: null, sourceKind: 'host_bash', command: 'example', description: '', workdir: null,
  executionId: null, status: 'running', exitCode: null, signal: null, startedAt: 1, endedAt: null, version: 1,
  logStatus: 'active', logIssues: [], logSequence: 1, totalRawBytes: 1, totalNewlines: 0,
  storedCompressedBytes: 1, logTailUnconfirmed: false, drainSummary: null })
const chunk = (sequence: number, text = 'x'): CommandLogChunk => ({ commandId: 'one', sequence, stream: 'stdout', receivedAt: 1,
  byteStart: sequence - 1, byteEnd: sequence, lineStart: 0, lineEnd: 0, dataBase64: btoa(text) })

describe('command views and reconnect boundaries', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.restoreAllMocks()
    vi.spyOn(api, 'subscribe').mockResolvedValue({ subscriptionId: 'subscription' })
    vi.spyOn(api, 'unsubscribe').mockResolvedValue({ removed: true })
    vi.spyOn(api, 'list').mockResolvedValue({ commands: [], nextCursor: null })
    vi.spyOn(api, 'logs').mockResolvedValue({ command: record('one'), chunks: [chunk(1)], gaps: [], hasMore: false, nextCursor: 1 })
  })

  it('subscribes before snapshot and ignores a late list from a replaced target', async () => {
    let finish!: (value: Awaited<ReturnType<typeof api.list>>) => void
    vi.mocked(api.list).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const store = useAgentCommandsStore()
    store.connectionChanged('connected')
    const view = store.createView()
    expect(api.list).not.toHaveBeenCalled()
    await settle()
    expect(api.subscribe).toHaveBeenCalledOnce()
    store.resetTarget()
    finish({ commands: [record('old')], nextCursor: null })
    await settle()
    expect(store.records).toEqual({})
    expect(store.views[view]?.ids).toEqual([])
    expect(api.unsubscribe).not.toHaveBeenCalled()
    store.connectionChanged('connected')
    await settle()
    expect(api.list).toHaveBeenCalledTimes(2)
  })

  it('new list scope wins even when the old read finishes later', async () => {
    const store = useAgentCommandsStore()
    store.connectionChanged('connected')
    const id = store.createView()
    await settle()
    let finish!: (value: Awaited<ReturnType<typeof api.list>>) => void
    vi.mocked(api.list).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const old = store.load(id)
    store.views[id]!.query.scope = 'history'
    vi.mocked(api.list).mockResolvedValueOnce({ commands: [record('history')], nextCursor: null })
    await store.load(id)
    finish({ commands: [record('old')], nextCursor: null })
    await old
    expect(store.views[id]?.ids).toEqual(['history'])
  })

  it('shares one detail subscription, and catch-up starts at the durable boundary rather than live output', async () => {
    const store = useAgentCommandsStore()
    store.connectionChanged('connected')
    store.acquireLog('one'); store.acquireLog('one')
    await settle()
    expect(api.subscribe).toHaveBeenCalledOnce()
    store.apply({ type: 'agent.command.log.chunk', data: { subscriptionId: 'subscription', chunk: chunk(3) } })
    await store.readLog('one', 'catchup')
    expect(api.logs).toHaveBeenLastCalledWith(expect.objectContaining({ commandId: 'one', cursor: 1 }))
    store.releaseLog('one')
    expect(api.unsubscribe).not.toHaveBeenCalled()
    store.releaseLog('one')
    expect(api.unsubscribe).toHaveBeenCalledWith('subscription')
  })
})

describe('bounded original-log display', () => {
  it('bounds chunks and distinguishes missing ranges without losing bytes split across UTF-8 chunks', () => {
    const bounded = mergeCommandChunks([], Array.from({ length: 700 }, (_, n) => chunk(n + 1)))
    expect(bounded.chunks).toHaveLength(512)
    expect(bounded.trimmed).toBe(true)
    const chunks = [chunk(1), chunk(3)]
    const gaps = mergeCommandGaps(chunks, [{ sequenceStart: 1, sequenceEnd: 4, byteStart: 0, byteEnd: 4, lineStart: 0, lineEnd: 0 }])
    expect(gaps.map(gap => [gap.sequenceStart, gap.sequenceEnd])).toEqual([[2, 2], [4, 4]])
    expect(commandLogText([{ ...chunk(1), dataBase64: '5A==' }, { ...chunk(2), dataBase64: 'uK0=' }], [])).toContain('中')
    expect(commandLogText(chunks, gaps)).toContain('日志缺失')
  })
})
