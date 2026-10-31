import Database from 'better-sqlite3'
import { initSourceContextTables, SourceContextRepository, type SourceAuthority } from '@/db/sourceContext.js'
import type { SourceHandling, SourcePart, SourceReceipt, SourceRecordRef } from '@chery/protocol'
import { initAssetTables } from '@/db/assets.js'

export function sourceAssetFixture(db: Database.Database, assetId: string, versionId: string) {
  initAssetTables(db)
  db.prepare('INSERT INTO assets(id,owner_id,original_name,source,created_at,unreferenced_at) VALUES (?,?,?,?,?,?)')
    .run(assetId, 'qq-fixture', 'fixture.png', 'upload', 1, 1)
  db.prepare(`INSERT INTO asset_versions(id,asset_id,variant,sha256,mime_type,kind,size_bytes,created_at,transform_json,transform_key)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(versionId, assetId, 'original', 'a'.repeat(64), 'image/png', 'image', 24, 1, '{}', 'original')
}

/** A private in-memory source store. No live chat, credentials or transport. */
export function sourceFixture(conversationType: 'group' | 'private' = 'group') {
  const db = new Database(':memory:')
  db.pragma('foreign_keys=ON')
  initSourceContextTables(db)
  let allowed = true, clock = 10000, next = 0
  const authority: SourceAuthority = { ownerId: 'qq-fixture', channel: 'qq', selfId: '100',
    conversationType, targetId: conversationType === 'group' ? '999' : '123', actorId: '123', purpose: 'execution',
    validate() { if (!allowed) throw Object.assign(new Error('PERMISSION_DENIED'), { code: 'PERMISSION_DENIED' }) } }
  const repo = new SourceContextRepository(db, () => clock++)
  const target = { conversationType, targetId: authority.targetId, presetId: 'preset', qqContextEpoch: '' }
  const scope = repo.applyScopes(authority, 1, [target])[0]!
  function receive(parts: SourcePart[] | string, options: { sender?: string; sentAt?: number; handling?: SourceHandling; pending?: boolean;
    attachments?: import('@/db/sourceContext.js').SourceReceiptInput['attachments'] } = {}) {
    const eventId = `event-${++next}`
    const auth: SourceAuthority = { ...authority, purpose: 'record', actorId: options.sender ?? authority.actorId }
    const receipt = repo.beginReceipt(auth, scope.scopeId, { eventId, messageId: String(next),
      sender: { id: auth.actorId!, name: `成员${auth.actorId}` }, platformSentAt: options.sentAt ?? clock,
      parts: typeof parts === 'string' ? [{ type: 'text', partId: 'p0', text: parts }] : parts, attachments: options.attachments })
    if (receipt.state !== 'pending') throw new Error('Fixture must allocate a new receipt')
    const complete = (handling = options.handling ?? { kind: 'background' as const }) => repo.completeReceipt(auth,
      receipt.receiptId, receipt.version, handling, scope.scopeId, eventId)
    if (!options.pending) complete()
    return { eventId, receipt: receipt as Extract<SourceReceipt, { state: 'pending' }>, record: receipt.record, complete }
  }
  function start(requestId = 'request', runId = 'run', actorRecord?: SourceRecordRef) {
    const current = actorRecord ?? receive('当前输入', { handling: { kind: 'queued', requestId } }).record
    const snapshot = repo.freeze(authority, scope.scopeId, { requestId, actorRecord: current, inputRecords: [current],
      expectedSelectionRevision: repo.scope(authority, scope.scopeId).selectionRevision,
      policy: { historyLimit: 100, backgroundMaxAgeMs: 1000000, backgroundMaxChars: 1000000, qqConfigRevision: 1 } })
    repo.ensureRun(authority, scope.scopeId, requestId, runId)
    return { snapshot, requestId, scopeId: scope.scopeId, runId }
  }
  return { db, repo, authority, scope, target, receive, start, revoke() { allowed = false } }
}
