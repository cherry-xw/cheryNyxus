import { describe, expect, it } from 'vitest'
import { createIngressCoreAdapter } from '@/service/ingress/coreAdapter.js'
import { resolvePresetSelection } from '@/agent/runtimeResolver.js'
import { SourceContextRepository } from '@/db/sourceContext.js'
import { getSoulDb } from '@/db/index.js'

describe('bounded ingress retained source history and text query', () => {
  it('reads retained source history within current scope and paginates full text by code points', async () => {
    const core = createIngressCoreAdapter()
    const source = core.sourceConversations!
    const presetId = resolvePresetSelection('detail-test').presetId
    const owner = 'history-test'
    const selfId = '11111'
    const targetId = '22222'
    const validateIdentity = () => {}
    const [scope] = await source.configure(owner, {
      channel: 'qq',
      selfId,
      revision: 1,
      targets: [{ conversationType: 'group', targetId, presetId, qqContextEpoch: '' }],
      validateIdentity,
    })
    const requestIdentity = {
      source: 'plugin' as const,
      ownerId: owner,
      entryId: 'qq',
      channel: 'qq',
      subject: { selfId, userId: '33333', conversationType: 'group' as const, groupId: targetId },
    }
    const longText = '🙂'.repeat(1100)
    const receipt = await source.beginReceipt(owner, {
      scopeId: scope!.scopeId,
      eventId: 'ev-long',
      purpose: 'record',
      requestIdentity,
      validateIdentity,
      message: {
        eventId: 'ev-long',
        messageId: '9001',
        sender: { id: '33333', name: 'Bob' },
        receivedAt: 1000,
        parts: [{ partId: 'p0', type: 'text', text: longText }],
      },
    })
    await source.completeReceipt(owner, {
      scopeId: scope!.scopeId,
      eventId: 'ev-long',
      purpose: 'record',
      requestIdentity,
      validateIdentity,
      receiptId: receipt.receiptId,
      expectedVersion: receipt.version,
      handling: { kind: 'queued', requestId: 'req-long' },
    })
    await source.freeze(owner, {
      scopeId: scope!.scopeId,
      eventId: 'ev-long',
      purpose: 'execution',
      requestIdentity,
      validateIdentity,
      requestId: 'req-long',
      actorRecord: receipt.record,
      inputRecords: [receipt.record],
      expectedSelectionRevision: 0,
      policy: { historyLimit: 10, backgroundMaxAgeMs: 60000, backgroundMaxChars: 5000, qqConfigRevision: 1 },
    })
    new SourceContextRepository(getSoulDb()).ensureRun(
      { ownerId: owner, channel: 'qq', selfId, conversationType: 'group', targetId, actorId: '33333', purpose: 'execution', validate: validateIdentity },
      scope!.scopeId,
      'req-long',
      'run-history-1',
    )
    const history = await source.history(owner, {
      scopeId: scope!.scopeId,
      eventId: 'ev-long',
      purpose: 'execution',
      requestIdentity,
      validateIdentity,
      runId: 'run-history-1',
      count: 20,
    })
    expect(history.records).toHaveLength(1)
    const part = history.records[0]!.parts[0]!
    expect(part.type).toBe('text')
    if (part.type !== 'text') throw new Error('Expected text part')
    expect(Array.from(part.body.preview)).toHaveLength(1024)
    expect(part.body.totalCodePoints).toBe(1100)
    const page = await source.readText(owner, {
      scopeId: scope!.scopeId,
      eventId: 'ev-long',
      purpose: 'execution',
      requestIdentity,
      validateIdentity,
      runId: 'run-history-1',
      textRefId: part.body.textRefId,
    })
    expect(Array.from(page.text)).toHaveLength(1100)
    await expect(
      source.history('foreign', {
        scopeId: scope!.scopeId,
        eventId: 'ev-long',
        purpose: 'execution',
        requestIdentity: { ...requestIdentity, ownerId: 'foreign' },
        validateIdentity,
        runId: 'run-history-1',
      }),
    ).rejects.toThrow()
  })
})
