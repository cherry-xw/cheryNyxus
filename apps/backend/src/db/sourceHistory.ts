import { randomUUID } from 'node:crypto'
import { SourceHistoryResultSchema, SourceIdSchema, SourceSnapshotSchema, SourceTextPageSchema,
  type SourceHistoryRecord, type SourceHistoryResult, type SourceRecord, type SourceTextRef, type SourceTextPage } from '@chery/protocol'
import type { SourceAuthority, SourceContextRepository } from './sourceContext.js'

function fail(code: string): never { throw Object.assign(new Error(code), { code }) }
const identifier = (kind: string) => `${kind}-${randomUUID()}`
const maxResponseBytes = 256 * 1024
const compare = (a: SourceRecord, b: SourceRecord) => (a.platformSentAt ?? a.deliveryConfirmedAt ?? a.receivedAt) -
  (b.platformSentAt ?? b.deliveryConfirmedAt ?? b.receivedAt) || a.ingestOrdinal - b.ingestOrdinal || a.recordId.localeCompare(b.recordId)
type Access = { scopeId: string; runId: string }
type TextRow = { text_ref_id: string; record_id: string; record_revision: number; part_id: string }
type HistoryPosition = { through: number; position: number; count: number; observedAt: number }

/** A cursor belongs to one member and one live run; neither its ID nor a saved source reference authorizes access. */
function access(repo: SourceContextRepository, authority: SourceAuthority, input: Access) {
  SourceIdSchema.parse(input.runId)
  const scope = repo.scope(authority, input.scopeId, ['execution'])
  if (!authority.actorId) fail('IDENTITY_REJECTED')
  const row = repo.db.prepare(`SELECT s.data_json FROM source_runs r JOIN source_snapshots s ON s.request_id=r.request_id
    WHERE r.run_id=? AND r.scope_id=? AND s.scope_id=r.scope_id AND s.parent_snapshot_id IS NULL`)
    .get(input.runId, input.scopeId) as { data_json: string } | undefined
  if (!row) fail('PERMISSION_DENIED')
  const snapshot = SourceSnapshotSchema.parse(JSON.parse(row.data_json))
  if (!snapshot.actorRecord || repo.read(authority, input.scopeId, [snapshot.actorRecord])[0]?.sender.id !== authority.actorId)
    fail('PERMISSION_DENIED')
  if (!snapshot.inputRecords.length || snapshot.inputRecords.some(reference => !repo.db.prepare(`SELECT 1 FROM source_receipts
    WHERE scope_id=? AND record_id=? AND state='completed' AND json_extract(result_json,'$.handling.requestId')=?
      AND json_extract(result_json,'$.handling.kind') IN ('queued','merged')`)
    .get(input.scopeId, reference.recordId, snapshot.requestId))) fail('PERMISSION_DENIED')
  return { scope, actorId: authority.actorId }
}
function cursor(repo: SourceContextRepository, authority: SourceAuthority, input: Access,
  kind: 'history' | 'text', value: object): string {
  const { scope, actorId } = access(repo, authority, input), id = identifier('source-tool-cursor')
  repo.db.prepare('INSERT INTO source_tool_cursors VALUES (?,?,?,?,?,?,?)')
    .run(id, input.scopeId, input.runId, actorId, scope.permissionRevision, kind, JSON.stringify(value))
  return id
}
function position<T>(repo: SourceContextRepository, authority: SourceAuthority, input: Access, id: string, kind: 'history' | 'text'): T {
  SourceIdSchema.parse(id)
  const { scope, actorId } = access(repo, authority, input)
  const saved = repo.db.prepare(`SELECT data_json FROM source_tool_cursors
    WHERE cursor_id=? AND scope_id=? AND run_id=? AND actor_id=? AND permission_revision=? AND kind=?`)
    .get(id, input.scopeId, input.runId, actorId, scope.permissionRevision, kind) as { data_json: string } | undefined
  if (!saved) fail('CURSOR_EXPIRED')
  return JSON.parse(saved.data_json) as T
}
function textReference(repo: SourceContextRepository, authority: SourceAuthority, input: Access,
  record: SourceRecord, partId: string, previewLength: number): SourceTextRef {
  const { scope, actorId } = access(repo, authority, input)
  let saved = repo.db.prepare(`SELECT text_ref_id FROM source_tool_texts
    WHERE scope_id=? AND run_id=? AND actor_id=? AND permission_revision=? AND record_id=? AND record_revision=? AND part_id=?`)
    .get(input.scopeId, input.runId, actorId, scope.permissionRevision, record.recordId, record.revision, partId) as { text_ref_id: string } | undefined
  if (!saved) {
    saved = { text_ref_id: identifier('source-tool-text') }
    repo.db.prepare(`INSERT INTO source_tool_texts
      (text_ref_id,scope_id,run_id,actor_id,permission_revision,record_id,record_revision,part_id) VALUES (?,?,?,?,?,?,?,?)`)
      .run(saved.text_ref_id, input.scopeId, input.runId, actorId, scope.permissionRevision, record.recordId, record.revision, partId)
  }
  const part = record.parts.find(part => part.partId === partId)
  if (part?.type !== 'text') fail('INVALID_PARAMS')
  const characters = Array.from(part.text), preview = characters.slice(0, previewLength).join('')
  const complete = characters.length <= previewLength
  return { textRefId: saved.text_ref_id, revision: record.revision, totalCodePoints: characters.length,
    preview, previewCodePoints: Math.min(characters.length, previewLength), complete,
    nextCursor: complete ? null : cursor(repo, authority, input, 'text', { textRefId: saved.text_ref_id, revision: record.revision, start: previewLength }) }
}
function visibleRecord(repo: SourceContextRepository, authority: SourceAuthority, input: Access, record: SourceRecord, previewLength: number): SourceHistoryRecord {
  return { source: { recordId: record.recordId, revision: record.revision }, origin: record.origin, sender: record.sender,
    platformMessageIds: record.platformMessageIds,
    time: { at: record.platformSentAt ?? record.deliveryConfirmedAt ?? record.receivedAt,
      basis: record.platformSentAt !== undefined ? 'platform_sent' : record.deliveryConfirmedAt !== undefined ? 'delivery_confirmed' : 'received' },
    parts: record.parts.map(part => {
      if (part.type === 'text') return { partId: part.partId, type: 'text' as const, body: textReference(repo, authority, input, record, part.partId, previewLength) }
      if (part.type !== 'attachment') return part
      const file = repo.attachment(authority, input.scopeId, part.attachmentId)
      return { partId: part.partId, type: 'attachment' as const, attachmentId: file.attachmentId, version: file.version,
        originalName: file.originalName, mediaKind: file.mediaKind, acquisitionState: file.state.kind, contentRead: false as const }
    }) }
}

export function readSourceHistory(repo: SourceContextRepository, authority: SourceAuthority,
  input: Access & { count?: number; cursor?: string }): SourceHistoryResult {
  return repo.db.transaction(() => {
    access(repo, authority, input)
    if (input.count !== undefined && (!Number.isInteger(input.count) || input.count < 1 || input.count > 100)) fail('INVALID_PARAMS')
    const fixed = input.cursor ? position<HistoryPosition>(repo, authority, input, input.cursor, 'history') : {
      through: (repo.db.prepare(`SELECT COALESCE(MAX(r.ingest_ordinal),0) AS n FROM source_scope_members m
        JOIN source_records r USING(record_id) WHERE m.scope_id=?`).get(input.scopeId) as { n: number }).n,
      position: 0, count: input.count ?? 50, observedAt: Date.now(),
    }
    if (input.cursor && input.count !== undefined && input.count !== fixed.count) fail('INVALID_PARAMS')
    const rows = repo.db.prepare(`SELECT r.record_id,r.revision FROM source_scope_members m JOIN source_records r USING(record_id)
      WHERE m.scope_id=? AND r.ingest_ordinal<=? ORDER BY
      COALESCE(json_extract(r.data_json,'$.platformSentAt'),json_extract(r.data_json,'$.deliveryConfirmedAt'),json_extract(r.data_json,'$.receivedAt')) DESC,
      r.ingest_ordinal DESC,r.record_id DESC LIMIT ? OFFSET ?`).all(input.scopeId, fixed.through, fixed.count + 1, fixed.position) as Array<{ record_id: string; revision: number }>
    const records = repo.read(authority, input.scopeId, rows.slice(0, fixed.count).map(row => ({ recordId: row.record_id, revision: row.revision })))
    const completeness = repo.db.prepare(`SELECT kind,MIN(observed_at) AS observedAt FROM source_completeness
      WHERE scope_id=? AND observed_at<=? GROUP BY kind ORDER BY observedAt,kind`).all(input.scopeId, fixed.observedAt) as SourceHistoryResult['completeness']
    let take = records.length, previewLength = 1024
    // Discarded candidates are rolled back together with their private references/cursors.
    while (true) {
      const build = repo.db.transaction(() => {
        const selected = records.slice(0, take).sort(compare)
        const result: SourceHistoryResult = { historySource: 'retained', scopeId: input.scopeId, throughIngestOrdinal: fixed.through,
          ordering: 'time_approximate', records: selected.map(record => visibleRecord(repo, authority, input, record, previewLength)), completeness,
          nextCursor: rows.length > take ? cursor(repo, authority, input, 'history', { ...fixed, position: fixed.position + take }) : null }
        if (Buffer.byteLength(JSON.stringify(result)) > maxResponseBytes) throw Object.assign(new Error('Response size'), { oversized: true })
        access(repo, authority, input)
        return SourceHistoryResultSchema.parse(result)
      })
      try { return build() } catch (error) {
        if (!(error && typeof error === 'object' && 'oversized' in error)) throw error
        if (take > 1) take = Math.max(1, Math.floor(take / 2))
        else if (previewLength > 0) previewLength = Math.floor(previewLength / 2)
        else fail('SOURCE_RESPONSE_TOO_LARGE')
      }
    }
  })()
}

export function readSourceText(repo: SourceContextRepository, authority: SourceAuthority,
  input: Access & { textRefId: string; cursor?: string }): SourceTextPage {
  return repo.db.transaction(() => {
    const { scope, actorId } = access(repo, authority, input)
    SourceIdSchema.parse(input.textRefId)
    const saved = repo.db.prepare(`SELECT * FROM source_tool_texts
      WHERE text_ref_id=? AND scope_id=? AND run_id=? AND actor_id=? AND permission_revision=?`)
      .get(input.textRefId, input.scopeId, input.runId, actorId, scope.permissionRevision) as TextRow | undefined
    if (!saved) fail('PERMISSION_DENIED')
    const fixed = input.cursor ? position<{ textRefId: string; revision: number; start: number }>(repo, authority, input, input.cursor, 'text')
      : { textRefId: input.textRefId, revision: saved.record_revision, start: 0 }
    if (fixed.textRefId !== input.textRefId || fixed.revision !== saved.record_revision) fail('INVALID_PARAMS')
    const record = repo.read(authority, input.scopeId, [{ recordId: saved.record_id, revision: saved.record_revision }])[0]!
    const part = record.parts.find(part => part.partId === saved.part_id)
    if (part?.type !== 'text') fail('NOT_FOUND')
    const characters = Array.from(part.text), end = Math.min(characters.length, fixed.start + 8192)
    const result = SourceTextPageSchema.parse({ requestId: input.runId, textRefId: input.textRefId, revision: saved.record_revision,
      startCodePoint: fixed.start, endCodePoint: end, text: characters.slice(fixed.start, end).join(''), totalCodePoints: characters.length,
      nextCursor: end === characters.length ? null : cursor(repo, authority, input, 'text', { ...fixed, start: end }) })
    access(repo, authority, input)
    return result
  })()
}
