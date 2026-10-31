import type Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sourceAssetFixture, sourceFixture } from '../../helpers/sourceContext.js'
import { prepareSourceHistory } from '@/agent/middleware/sourceHistory.js'
import { sourceModelStep } from '@/agent/middleware/sourceProjection.js'
import { registerOpenAIAdapter } from '@/agent/provider/openai.js'
import { registerAnthropicAdapter } from '@/agent/provider/anthropic.js'
import { registerOpenAIResponsesAdapter } from '@/agent/provider/openaiResponses.js'
import { getLLMAdapter, type LLMOptions } from '@/core/llm/adapter.js'
import { getMessageAdapter, type LLMResponse } from '@/core/message/adapter.js'
import type { MiddlewareContext } from '@/core/middleware/types.js'
import type { SourceAttempt, SourceInput, SourceModelProjection } from '@chery/protocol'

let database: Database.Database
vi.mock('@/db/index.js', () => ({ getSoulDb: () => database }))
vi.mock('@/agent/hooks/dispatch.js', () => ({ dispatch: vi.fn(async () => undefined) }))
vi.mock('@/service/media/store.js', () => ({ getAssetStore: () => ({ get: () => ({ id: 'asset', versionId: 'version', kind: 'image', mimeType: 'image/png', originalName: 'fixture.png' }) }) }))
afterEach(() => { vi.unstubAllGlobals(); database?.close() })
const msg = (id: string, role: LLMResponse['role'], content: string): LLMResponse => ({ id, role, content, createdAt: 1, updateAt: 1 })
function fixture(stream = false, image = false) {
  const f = sourceFixture(); database = f.db
  const earlier = f.receive('相同正文'), current = f.receive(image
    ? [{ type: 'reply', partId: 'p0', platformMessageId: '1' }, { type: 'text', partId: 'p1', text: '相同正文' }, { type: 'attachment', partId: 'p2', attachmentId: 'wire-file' }]
    : [{ type: 'reply', partId: 'p0', platformMessageId: '1' }, { type: 'text', partId: 'p1', text: '相同正文' }],
    { handling: { kind: 'queued', requestId: 'request' }, ...(image ? { attachments: [{ partId: 'p2', mediaKind: 'image' as const }] } : {}) })
  if (image) {
    sourceAssetFixture(f.db, 'asset', 'version')
    const file = f.repo.receiptContent({ ...f.authority, purpose: 'record' }, f.scope.scopeId, current.eventId).attachments[0]!
    f.db.prepare('INSERT INTO source_asset_grants(asset_id,asset_version_id,scope_id,record_id,part_id,record_revision) VALUES (?,?,?,?,?,?)')
      .run('asset','version',f.scope.scopeId,current.record.recordId,'p2',current.record.revision)
    f.repo.updateAttachment({ ...f.authority, purpose: 'record' }, f.scope.scopeId, file.attachmentId, file.version,
      { kind: 'stored', assetId: 'asset', assetVersionId: 'version' })
  }
  const initial = f.start('request', 'run', current.record)
  const input: SourceInput = { kind: 'source_snapshot', requestId: 'request', turnId: 'request', scopeId: f.scope.scopeId,
    snapshotId: initial.snapshot.snapshotId, actorRecord: current.record, inputRecords: [current.record] }
  const ctx = { global: { stream }, requestExecution: { sourceInput: input, validate: f.authority.validate },
    requestView: { requestId: 'run', configRevision: 'config', registryVersion: 1, tools: [], identity: { source: 'plugin', ownerId: f.authority.ownerId,
      entryId: 'qq', channel: 'qq', subject: { selfId: '100', userId: '123', conversationType: 'group', groupId: '999' } } } } as unknown as MiddlewareContext
  const call = msg('assistant-call', 'assistant', '工具调用前说明')
  call.senseCalls = [{ id: 'tool-result', name: 'fixture_tool', arguments: '{}' }]
  const result = msg('tool-result', 'sense', '一次真实工具结果')
  f.repo.saveRunMessage(f.authority, f.scope.scopeId, 'run', call, 'completed')
  f.repo.saveRunMessage(f.authority, f.scope.scopeId, 'run', result, 'completed')
  const prepared = prepareSourceHistory(ctx, [msg('system', 'system', '可信规则'), msg('old-copy', 'assistant', '旧重复副本'),
    { ...msg('anchor', 'user', '展示正文不应进入模型'), sourceInput: input }, call, result])
  return { ...f, ...prepared, ctx, earlier, current }
}
const projections = () => (database.prepare('SELECT data_json FROM source_projections ORDER BY rowid').all() as { data_json: string }[])
  .map(row => JSON.parse(row.data_json) as SourceModelProjection)
const attempts = () => (database.prepare('SELECT data_json FROM source_attempts ORDER BY rowid').all() as { data_json: string }[])
  .map(row => JSON.parse(row.data_json) as SourceAttempt)
function response(protocol: string, stream: boolean) {
  if (!stream) return Response.json(protocol === 'anthropic'
    ? { id: 'message', type: 'message', role: 'assistant', content: [{ type: 'text', text: '完成' }], stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 3 } }
    : protocol === 'openai-responses' ? { id: 'response', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '完成' }] }], usage: { input_tokens: 20, output_tokens: 3, total_tokens: 23 } }
      : { choices: [{ message: { role: 'assistant', content: '完成' }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 } })
  const frames = protocol === 'anthropic' ? [{ type: 'message_start', message: { id: 'message', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 20, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '完成' } }, { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }, { type: 'message_stop' }]
    : protocol === 'openai-responses' ? [{ type: 'response.output_text.delta', delta: '完成' },
      { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 20, output_tokens: 3, total_tokens: 23 } } }]
      : [{ choices: [{ delta: { content: '完成' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 } }]
  return new Response(frames.map(frame => `${protocol === 'anthropic' ? `event: ${frame.type}\n` : ''}data: ${JSON.stringify(frame)}\n\n`).join('') + (protocol === 'openai' ? 'data: [DONE]\n\n' : ''), { headers: { 'content-type': 'text/event-stream' } })
}

describe('source adoption at the actual provider boundary', () => {
  it.each(['openai', 'anthropic', 'openai-responses'].flatMap(protocol => [false, true].map(stream => ({ protocol, stream }))))(
    'maps final $protocol native blocks, identical messages and tool pairs, stream=$stream', async ({ protocol, stream }) => {
      registerOpenAIAdapter(); registerAnthropicAdapter(); registerOpenAIResponsesAdapter()
      const f = fixture(stream, true), options: LLMOptions = { model: 'offline-model', url: 'https://offline.invalid/v1', key: 'synthetic',
        provider: protocol, protocol: protocol === 'openai' ? 'openai-chat-completions' : protocol === 'anthropic' ? 'anthropic-messages' : 'openai-responses', continuous: true }
      const sourceMessage = f.history.find(message => message.sourceRecord?.recordId === f.current.record.recordId)!
      const files = { history: f.history, attachments: [{ messageId: sourceMessage.id, partId: 'p2', assetId: 'asset', assetVersionId: 'version', mimeType: 'image/png', data: Buffer.from('synthetic-native-payload') }] }
      const step = sourceModelStep(f.ctx, f.source!, f.history, files, options, undefined, 'tool_continue')
      options.sourceCall = step.boundary; options.observation = step.observation
      let finalBody: any
      vi.stubGlobal('fetch', vi.fn(async (url: unknown, init: RequestInit) => {
        expect(String(url)).not.toMatch(/count_tokens|input_tokens/)
        finalBody = JSON.parse(String(init.body))
        expect(attempts()[0]).toMatchObject({ state: 'invoking', outcomeKnown: false })
        expect(database.prepare('SELECT COUNT(*) AS n FROM source_turns').get()).toEqual({ n: 1 })
        return response(protocol, stream)
      }))
      const wire = getMessageAdapter(protocol)!.buildMessages(f.history, files.attachments)
      const llm = getLLMAdapter(protocol)!
      if (stream) for await (const raw of await llm.chatStream(wire, [], options)) step.observation.response(raw)
      else step.observation.response(await llm.chat(wire, [], options))
      step.observation.finish('completed')
      const projection = projections()[0]!, attempt = attempts()[0]!
      expect(attempt).toMatchObject({ state: 'responded', outcomeKnown: true, usage: { inputTokens: 20, outputTokens: 3 } })
      expect(projection.toolHistoryRefs.map(ref => ref.messageId)).toEqual(['assistant-call', 'tool-result'])
      const recordIds = new Set(projection.orderedInputManifest.flatMap(item => item.sourceRef.kind === 'record' ? [item.sourceRef.record.recordId] : []))
      expect(recordIds).toEqual(new Set([f.earlier.record.recordId, f.current.record.recordId]))
      const native = projection.fileInputs[0]!
      expect(native).toMatchObject({ representation: 'native', source: { ...f.current.record, partId: 'p2' }, assetId: 'asset', assetVersionId: 'version', binaryBytes: 24 })
      if (native.representation !== 'native') throw new Error('Missing native provision')
      const list = finalBody.input ?? finalBody.messages, positioned = list[native.inputBlockPosition.messageIndex].content[native.inputBlockPosition.blockIndex]
      expect(JSON.stringify(positioned)).toContain(Buffer.from('synthetic-native-payload').toString('base64'))
      expect(JSON.stringify(finalBody)).not.toMatch(/展示正文不应进入模型|旧重复副本|sourceRecord|sourcePartIds|transportRef/)
      expect(JSON.stringify(finalBody).match(/一次真实工具结果/g)).toHaveLength(1)
    })

  it('rejects lost mappings atomically, keeps repeated preparations immutable and does not adopt before start', () => {
    registerOpenAIAdapter()
    const f = fixture(), options = { model: 'offline' }, files = { history: f.history, commit: vi.fn() }
    const step = sourceModelStep(f.ctx, f.source!, f.history, files, options, undefined, 'initial')
    const body = { model: 'offline', messages: getMessageAdapter('openai')!.buildMessages(f.history) }
    expect(() => step.boundary.prepare(structuredClone(body), 'openai')).toThrow('SOURCE_INPUT_MAPPING_UNAVAILABLE')
    expect(projections()).toEqual([])
    step.boundary.prepare(body, 'openai'); step.boundary.prepare(body, 'openai')
    expect(attempts().map(attempt => attempt.state)).toEqual(['failed', 'prepared'])
    expect(projections()[0]!.projectionId).not.toBe(projections()[1]!.projectionId)
    expect(projections()[0]!.modelStepId).toBe(projections()[1]!.modelStepId)
    expect(files.commit).not.toHaveBeenCalled()
    expect(database.prepare('SELECT COUNT(*) AS n FROM source_turns').get()).toEqual({ n: 0 })
    step.observation.start(); step.observation.start()
    expect(files.commit).toHaveBeenCalledOnce()
    expect(() => step.boundary.prepare(body, 'openai')).toThrow('SOURCE_CALL_STILL_RUNNING')
  })
  it.each(['failed', 'cancelled'] as const)('keeps interrupted streaming %s unknown, then records only the genuine late terminal response after revocation', status => {
    registerOpenAIAdapter()
    const f = fixture(true), options = { model: 'offline' }
    const step = sourceModelStep(f.ctx, f.source!, f.history, { history: f.history }, options, undefined, 'initial')
    step.boundary.prepare({ model: 'offline', messages: getMessageAdapter('openai')!.buildMessages(f.history) }, 'openai')
    step.observation.start(); step.observation.response({ choices: [{ delta: { content: '不完整' } }] }); step.observation.finish(status)
    expect(attempts()[0]).toMatchObject({ state: status === 'cancelled' ? 'cancelled' : 'unknown', outcomeKnown: false })
    f.revoke()
    step.observation.response({ choices: [{ finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } })
    expect(attempts()[0]).toMatchObject({ state: 'responded', outcomeKnown: true, usage: { totalTokens: 10 } })
    const version = attempts()[0]!.version
    step.observation.response({ choices: [{ finish_reason: 'stop' }] }); step.observation.finish('failed')
    expect(attempts()[0]!.version).toBe(version)
    expect(() => step.boundary.prepare({ messages: [] }, 'openai')).toThrow('PERMISSION_DENIED')
    expect(projections()).toHaveLength(1)
  })
})
