import type Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import {
  SourceIdSchema, SourceConversationKeySchema, SourceRecordSchema, SourceScopeSchema, SourceHandlingSchema,
  SourcePartsSchema, SourceAttachmentVersionSchema, SourceSnapshotSchema, SourceSummarySchema,
  SourceModelProjectionSchema, SourceAttemptSchema, SourceSummaryEvidenceSchema, SourceReadSelectionSchema,
  SourceWorkspaceMountSchema, type SourceWorkspaceMount,
  SourceDataRefSchema, type SourceDataRef, type SourceToolMessageRef,
  QQNotificationSchema, QQDeliveryResultRequestSchema, type QQNotification, type QQDeliveryResultRequest,
  type SourceConversationKey, type SourceRecord, type SourceRecordRef, type SourceScope,
  type SourceReceipt, type SourceReceiptStatus, type SourceReceiptResult, type SourceHandling,
  type SourceAttachmentVersion, type SourceSnapshot, type SourceSnapshotItem,
  type SourceSummary, type SourceModelProjection, type SourceAttempt, type SourceSummaryEvidence, type SourceReadSelection, type SourceReadResult,
} from '@chery/protocol'
import type { LLMResponse } from '@/core/message/adapter.js'

export function sourceContextError(code: string): never {
  throw Object.assign(new Error(code), { code })
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}
export function sourceFingerprint(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}
const id = (kind: string) => `${kind}-${randomUUID()}`
const ref = (record: SourceRecord): SourceRecordRef => ({ recordId: record.recordId, revision: record.revision })

/** The host supplies this authority; it is never reconstructed from saved JSON. */
export interface SourceAuthority extends SourceConversationKey {
  purpose: 'record' | 'execution' | 'maintenance' | 'management'
  actorId?: string
  validate(): void
}
export interface SourceReceiptInput {
  eventId: string
  messageId: string
  sender: SourceRecord['sender']
  parts: SourceRecord['parts']
  platformSentAt?: number
  sourceOrder?: SourceRecord['sourceOrder']
  attachments?: Array<Pick<SourceAttachmentVersion, 'originalName' | 'declaredMimeType' | 'mediaKind'> & { partId: string }>
}
export interface SourceSelectionPolicy {
  historyLimit: number
  backgroundMaxAgeMs: number
  backgroundMaxChars: number
  qqConfigRevision: number
}
export interface SourceFreezeInput {
  requestId: string
  actorRecord: SourceRecordRef
  inputRecords: SourceRecordRef[]
  expectedSelectionRevision: number
  policy: SourceSelectionPolicy
  observationCandidates?: SourceRecordRef[]
}
export interface SourceScopeTarget {
  conversationType: 'group' | 'private'
  targetId: string
  presetId: string
  qqContextEpoch: string
}

/** Called only from the normal main-database initialization. No chat cascade. */
export function initSourceContextTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS source_conversations (
      conversation_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, channel TEXT NOT NULL,
      self_id TEXT NOT NULL, conversation_type TEXT NOT NULL CHECK(conversation_type IN ('group','private')),
      target_id TEXT NOT NULL, next_ordinal INTEGER NOT NULL DEFAULT 1,
      UNIQUE(owner_id,channel,self_id,conversation_type,target_id)
    );
    CREATE TABLE IF NOT EXISTS source_owner_access (owner_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)));
    CREATE TABLE IF NOT EXISTS source_scopes (
      scope_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES source_conversations(conversation_id),
      generation INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('active','retired','deleting','deleted')),
      data_json TEXT NOT NULL, active_summary_id TEXT,
      UNIQUE(conversation_id,generation)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS source_one_active_scope ON source_scopes(conversation_id) WHERE state='active';
    CREATE TABLE IF NOT EXISTS source_scope_heads (
      conversation_id TEXT PRIMARY KEY REFERENCES source_conversations(conversation_id),
      scope_id TEXT REFERENCES source_scopes(scope_id), generation INTEGER NOT NULL,
      permission_revision INTEGER NOT NULL, applied_config_revision INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('active','disabled'))
    );
    CREATE TABLE IF NOT EXISTS source_config_applications (
      owner_id TEXT NOT NULL, channel TEXT NOT NULL, self_id TEXT NOT NULL, config_revision INTEGER NOT NULL,
      fingerprint TEXT NOT NULL, result_json TEXT NOT NULL,
      PRIMARY KEY(owner_id,channel,self_id,config_revision)
    );
    CREATE TABLE IF NOT EXISTS source_records (
      record_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES source_conversations(conversation_id),
      source_key TEXT NOT NULL, revision INTEGER NOT NULL, ingest_ordinal INTEGER NOT NULL,
      fingerprint TEXT NOT NULL, data_json TEXT NOT NULL,
      UNIQUE(conversation_id,source_key), UNIQUE(conversation_id,ingest_ordinal)
    );
    CREATE TABLE IF NOT EXISTS source_aliases (
      conversation_id TEXT NOT NULL REFERENCES source_conversations(conversation_id), platform_message_id TEXT NOT NULL,
      record_id TEXT NOT NULL REFERENCES source_records(record_id), PRIMARY KEY(conversation_id,platform_message_id)
    );
    CREATE TABLE IF NOT EXISTS source_scope_members (
      scope_id TEXT NOT NULL REFERENCES source_scopes(scope_id), record_id TEXT NOT NULL REFERENCES source_records(record_id),
      PRIMARY KEY(scope_id,record_id)
    );
    CREATE TABLE IF NOT EXISTS source_receipts (
      receipt_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES source_conversations(conversation_id),
      scope_id TEXT NOT NULL REFERENCES source_scopes(scope_id), event_id TEXT NOT NULL,
      record_id TEXT NOT NULL REFERENCES source_records(record_id), fingerprint TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','completed')), version INTEGER NOT NULL,
      result_json TEXT, reason_code TEXT, UNIQUE(conversation_id,event_id), UNIQUE(record_id)
    );
    CREATE TABLE IF NOT EXISTS source_receipt_events (
      conversation_id TEXT NOT NULL REFERENCES source_conversations(conversation_id), event_id TEXT NOT NULL,
      receipt_id TEXT NOT NULL REFERENCES source_receipts(receipt_id), PRIMARY KEY(conversation_id,event_id)
    );
    CREATE TABLE IF NOT EXISTS source_attachment_versions (
      attachment_id TEXT NOT NULL, version INTEGER NOT NULL, record_id TEXT NOT NULL REFERENCES source_records(record_id),
      data_json TEXT NOT NULL, PRIMARY KEY(attachment_id,version)
    );
    CREATE TABLE IF NOT EXISTS source_asset_grants (
      asset_id TEXT NOT NULL REFERENCES assets(id), asset_version_id TEXT NOT NULL REFERENCES asset_versions(id),
      scope_id TEXT NOT NULL REFERENCES source_scopes(scope_id), record_id TEXT NOT NULL REFERENCES source_records(record_id),
      part_id TEXT NOT NULL, record_revision INTEGER NOT NULL,
      PRIMARY KEY(asset_id,asset_version_id,scope_id,record_id,part_id)
    );
    CREATE TABLE IF NOT EXISTS source_workspaces (
      scope_id TEXT NOT NULL REFERENCES source_scopes(scope_id), attachment_id TEXT NOT NULL, attachment_version INTEGER NOT NULL,
      permission_revision INTEGER NOT NULL, data_json TEXT NOT NULL,
      PRIMARY KEY(scope_id,attachment_id,attachment_version)
    );
    CREATE TABLE IF NOT EXISTS source_snapshots (
      snapshot_id TEXT PRIMARY KEY, request_id TEXT NOT NULL, scope_id TEXT NOT NULL REFERENCES source_scopes(scope_id),
      fingerprint TEXT NOT NULL, data_json TEXT NOT NULL, parent_snapshot_id TEXT REFERENCES source_snapshots(snapshot_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS source_initial_snapshot ON source_snapshots(request_id) WHERE parent_snapshot_id IS NULL;
    CREATE TABLE IF NOT EXISTS source_omitted_sets (
      set_id TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL REFERENCES source_snapshots(snapshot_id), refs_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS source_read_cursors (
      cursor_id TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES source_scopes(scope_id),
      snapshot_id TEXT NOT NULL REFERENCES source_snapshots(snapshot_id), permission_revision INTEGER NOT NULL, position INTEGER NOT NULL,
      UNIQUE(scope_id,snapshot_id,permission_revision,position)
    );
    CREATE TABLE IF NOT EXISTS source_tool_texts (
      text_ref_id TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES source_scopes(scope_id),
      run_id TEXT NOT NULL, actor_id TEXT NOT NULL, permission_revision INTEGER NOT NULL,
      record_id TEXT NOT NULL REFERENCES source_records(record_id), record_revision INTEGER NOT NULL, part_id TEXT NOT NULL,
      UNIQUE(scope_id,run_id,actor_id,permission_revision,record_id,record_revision,part_id)
    );
    CREATE TABLE IF NOT EXISTS source_tool_cursors (
      cursor_id TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES source_scopes(scope_id),
      run_id TEXT NOT NULL, actor_id TEXT NOT NULL, permission_revision INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('history','text')), data_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS source_completeness (
      completeness_id TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES source_scopes(scope_id),
      kind TEXT NOT NULL CHECK(kind IN ('history_start','reception_unconfirmed','source_deleted')),
      observed_at INTEGER NOT NULL, data_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS source_projections (
      projection_id TEXT PRIMARY KEY, model_step_id TEXT NOT NULL, snapshot_id TEXT NOT NULL REFERENCES source_snapshots(snapshot_id),
      request_id TEXT NOT NULL, step_sequence INTEGER NOT NULL, projection_sequence INTEGER NOT NULL,
      reason TEXT NOT NULL, prepared_at INTEGER NOT NULL, data_json TEXT NOT NULL,
      UNIQUE(request_id,step_sequence,projection_sequence)
    );
    CREATE TABLE IF NOT EXISTS source_attempts (
      attempt_id TEXT PRIMARY KEY, projection_id TEXT NOT NULL UNIQUE REFERENCES source_projections(projection_id),
      state TEXT NOT NULL, data_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS source_turns (
      scope_id TEXT NOT NULL REFERENCES source_scopes(scope_id), turn_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
      PRIMARY KEY(scope_id,turn_id), UNIQUE(scope_id,ordinal)
    );
    CREATE TABLE IF NOT EXISTS source_file_adoptions (
      scope_id TEXT NOT NULL REFERENCES source_scopes(scope_id), owner_id TEXT NOT NULL,
      asset_id TEXT NOT NULL, asset_version_id TEXT NOT NULL, first_turn_id TEXT NOT NULL,
      effective_turn_id TEXT NOT NULL, part_json TEXT NOT NULL, source_message_id TEXT,
      PRIMARY KEY(scope_id,owner_id,asset_id,asset_version_id)
    );
    CREATE TABLE IF NOT EXISTS source_file_positions (
      scope_id TEXT NOT NULL REFERENCES source_scopes(scope_id), record_id TEXT NOT NULL REFERENCES source_records(record_id),
      record_revision INTEGER NOT NULL, part_id TEXT NOT NULL, asset_id TEXT NOT NULL, asset_version_id TEXT NOT NULL,
      first_turn_id TEXT NOT NULL, PRIMARY KEY(scope_id,record_id,record_revision,part_id,asset_id,asset_version_id)
    );
    CREATE TABLE IF NOT EXISTS source_summary_operations (
      operation_id TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES source_scopes(scope_id),
      fingerprint TEXT NOT NULL, data_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS source_derived_replies (
      request_id TEXT PRIMARY KEY, observation_request_id TEXT NOT NULL UNIQUE,
      scope_id TEXT NOT NULL REFERENCES source_scopes(scope_id), record_id TEXT NOT NULL REFERENCES source_records(record_id),
      record_revision INTEGER NOT NULL, actor_id TEXT NOT NULL, permission_revision INTEGER NOT NULL,
      UNIQUE(scope_id,record_id,record_revision)
    );
    CREATE TABLE IF NOT EXISTS source_observation_batches (
      request_id TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES source_scopes(scope_id),
      permission_revision INTEGER NOT NULL, candidates_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS source_summaries (
      summary_id TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES source_scopes(scope_id),
      operation_id TEXT NOT NULL UNIQUE REFERENCES source_summary_operations(operation_id), data_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS source_summary_inputs (
      operation_id TEXT PRIMARY KEY REFERENCES source_summary_operations(operation_id), data_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS source_run_messages (
      run_id TEXT NOT NULL, message_id TEXT NOT NULL, scope_id TEXT NOT NULL REFERENCES source_scopes(scope_id),
      sequence INTEGER NOT NULL, state TEXT NOT NULL, body_hash TEXT NOT NULL, data_json TEXT NOT NULL,
      PRIMARY KEY(run_id,message_id), UNIQUE(run_id,sequence)
    );
    CREATE TABLE IF NOT EXISTS source_runs (
      request_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, scope_id TEXT NOT NULL REFERENCES source_scopes(scope_id)
    );
    CREATE TABLE IF NOT EXISTS source_tool_observations (
      run_id TEXT NOT NULL, call_id TEXT NOT NULL, scope_id TEXT NOT NULL REFERENCES source_scopes(scope_id),
      tool_name TEXT NOT NULL, content_hash TEXT NOT NULL, data_json TEXT NOT NULL, PRIMARY KEY(run_id,call_id)
    );
    CREATE TABLE IF NOT EXISTS source_learning_operations (
      operation_id TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES source_scopes(scope_id),
      data_json TEXT NOT NULL, input_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS source_management_requests (
      request_id TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES source_scopes(scope_id), created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS source_management_values (
      value_id TEXT PRIMARY KEY, principal TEXT NOT NULL, request_id TEXT NOT NULL, permission_revision INTEGER NOT NULL,
      kind TEXT NOT NULL, value_key TEXT NOT NULL, data_json TEXT NOT NULL,
      UNIQUE(principal,request_id,permission_revision,kind,value_key)
    );
    CREATE TABLE IF NOT EXISTS source_generated_replies (
      text_id TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES source_scopes(scope_id), request_id TEXT NOT NULL,
      body_hash TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(scope_id,request_id,body_hash)
    );
    CREATE TABLE IF NOT EXISTS source_summary_request_links (
      request_id TEXT NOT NULL REFERENCES source_management_requests(request_id),
      operation_id TEXT NOT NULL REFERENCES source_summary_operations(operation_id), PRIMARY KEY(request_id,operation_id)
    );
    CREATE TABLE IF NOT EXISTS source_rendered_texts (
      text_id TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES source_scopes(scope_id), body TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS source_data_snapshots (
      data_id TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES source_scopes(scope_id), data_json TEXT NOT NULL, body TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS source_preparation_results (
      result_id TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES source_scopes(scope_id), kind TEXT NOT NULL, data_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS source_deliveries (
      delivery_id TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES source_scopes(scope_id), request_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL, purpose TEXT NOT NULL, kind TEXT NOT NULL, frame_json TEXT NOT NULL,
      created_at INTEGER NOT NULL, record_id TEXT REFERENCES source_records(record_id)
    );
    CREATE TABLE IF NOT EXISTS source_delivery_facts (
      delivery_id TEXT NOT NULL REFERENCES source_deliveries(delivery_id), revision INTEGER NOT NULL,
      fingerprint TEXT NOT NULL, confirmed_at INTEGER NOT NULL, data_json TEXT NOT NULL,
      PRIMARY KEY(delivery_id,revision), UNIQUE(delivery_id,fingerprint)
    );
  `)
}
type JsonRow = { data_json: string }
type ReceiptRow = { receipt_id: string; scope_id: string; event_id: string; record_id: string; fingerprint: string;
  state: 'pending' | 'completed'; version: number; result_json: string | null; reason_code: string | null }
type Head = { scope_id: string | null; generation: number; permission_revision: number; applied_config_revision: number; state: 'active' | 'disabled' }
export interface SourceSummaryOperation {
  operationId: string; scopeId: string; purpose: 'capacity' | 'discussion'
  snapshotId: string; baseSummaryId?: string; baseSelectionRevision: number; permissionRevision: number
  evidence: SourceSummaryEvidence[]; status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  phase: 'history' | 'memory' | 'summary' | 'commit'; version: number; summaryId?: string; reasonCode?: string
}
export interface SourceSummaryPreparation {
  toolObservations?: Array<{runId:string;callId:string;toolName:string;result:unknown}>
  operation: SourceSummaryOperation; snapshot: SourceSnapshot; records: SourceRecord[]; baseSummary?: SourceSummary
  attachments: SourceAttachmentVersion[]
  deliveries: Array<{ deliveryId: string; purpose: string; kind: string; frame: QQNotification; source?: SourceRecordRef; result?: QQDeliveryResultRequest; revision: number }>
}

export class SourceContextRepository {
  constructor(readonly db: Database.Database, private readonly now = Date.now) {}

  /** A module/connection may reconcile its own saved output; no member execution is restored. */
  recordDelivery(authority: SourceConversationKey & { validate(): void }, scopeId: string, value: QQNotification,
    receipt?: QQDeliveryResultRequest, confirmedAt?: number): void {
    this.db.transaction(() => {
      authority.validate()
      const frame = QQNotificationSchema.parse(value), data = frame.data, scope = this.rawScope(scopeId)
      if (scope.state === 'deleted' || scope.state === 'deleting' || scope.conversationId !== this.conversation(authority) ||
        data.selfId !== authority.selfId || data.conversationType !== authority.conversationType || data.targetId !== authority.targetId)
        sourceContextError('PERMISSION_DENIED')
      if (!['qq.message.ack', 'qq.waiting', 'qq.tool.icon', 'qq.reply.part', 'qq.reply.file', 'qq.reply.video',
        'qq.reply.images', 'qq.reply.action', 'qq.request.failed'].includes(frame.type)) sourceContextError('INVALID_PARAMS')
      const fingerprint = sourceFingerprint(frame)
      const request = this.db.prepare('SELECT scope_id FROM source_management_requests WHERE request_id=?').get(data.requestId) as {scope_id:string} | undefined
      if (request && request.scope_id !== scopeId) sourceContextError('SOURCE_CONFLICT')
      this.db.prepare('INSERT OR IGNORE INTO source_management_requests VALUES (?,?,?)').run(data.requestId, scopeId, this.now())
      const previous = this.db.prepare('SELECT scope_id,fingerprint,record_id FROM source_deliveries WHERE delivery_id=?').get(data.eventId) as
        { scope_id: string; fingerprint: string; record_id: string | null } | undefined
      if (previous && (previous.fingerprint !== fingerprint || previous.scope_id !== scopeId)) sourceContextError('SOURCE_CONFLICT')
      const purpose = data.requestId.startsWith('reminder:') ? 'reminder' : data.requestId.startsWith('app-notification:') ? 'app_notification'
        : frame.type === 'qq.request.failed' ? 'error_notice' : frame.type === 'qq.message.ack' ? 'ack'
          : frame.type === 'qq.waiting' || frame.type === 'qq.tool.icon' ? 'progress' : 'reply'
      const kind = frame.type === 'qq.reply.action' && ['poke', 'reaction'].includes(data.actionKind ?? '') || frame.type === 'qq.message.ack'
        ? 'action' : frame.type === 'qq.reply.file' || frame.type === 'qq.reply.video' && data.uploadAsFile ? 'file_delivery' : 'message'
      if (!previous) this.db.prepare(`INSERT INTO source_deliveries
        (delivery_id,scope_id,request_id,fingerprint,purpose,kind,frame_json,created_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run(data.eventId, scopeId, data.requestId, fingerprint, purpose, kind, JSON.stringify(frame), this.now())
      if (!receipt) { authority.validate(); return }
      const result = QQDeliveryResultRequestSchema.parse(receipt)
      for (const key of ['eventId', 'requestId', 'selfId', 'conversationType', 'targetId', 'seq'] as const)
        if (result[key] !== data[key]) sourceContextError('SOURCE_CONFLICT')
      if (!Number.isSafeInteger(confirmedAt) || confirmedAt! < 0) sourceContextError('INVALID_PARAMS')
      const hash = sourceFingerprint(result)
      const old = this.db.prepare('SELECT revision,fingerprint,data_json FROM source_delivery_facts WHERE delivery_id=? ORDER BY revision DESC LIMIT 1')
        .get(data.eventId) as { revision: number; fingerprint: string; data_json: string } | undefined
      if (old?.fingerprint === hash) { authority.validate(); return }
      if (old) {
        const last = QQDeliveryResultRequestSchema.parse(JSON.parse(old.data_json))
        if (!(result.status === 'sent' && (last.status === 'unknown' || last.status === 'failed' &&
          ['qq.request.failed', 'qq.message.ack'].includes(frame.type)))) sourceContextError('SOURCE_CONFLICT')
      }
      this.db.prepare('INSERT INTO source_delivery_facts(delivery_id,revision,fingerprint,confirmed_at,data_json) VALUES (?,?,?,?,?)')
        .run(data.eventId, (old?.revision ?? 0) + 1, hash, confirmedAt, JSON.stringify(result))
      // Actions and uploads without message IDs are facts, not fabricated QQ messages.
      if (result.status !== 'sent' || !result.messageIds.length || kind === 'action' || previous?.record_id) { authority.validate(); return }
      const parts: SourceRecord['parts'] = []
      if (data.actionKind === 'quote' && data.messageId) parts.push({ type: 'reply', partId: `p${parts.length}`, platformMessageId: data.messageId })
      if (data.actionKind === 'mention' && data.userId) parts.push({ type: 'mention', partId: `p${parts.length}`, target: data.userId })
      if (data.text !== undefined) parts.push({ type: 'text', partId: `p${parts.length}`, text: data.text })
      if (data.icon) parts.push({ type: 'text', partId: `p${parts.length}`, text: data.icon })
      const filePartId = data.asset ? `p${parts.length}` : undefined
      const attachmentId = filePartId ? id('attachment') : undefined
      if (filePartId && attachmentId) parts.push({ type: 'attachment', partId: filePartId, attachmentId })
      if (frame.type === 'qq.reply.images' || frame.type === 'qq.reply.video' || data.actionKind === 'voice')
        parts.push({ type: 'unsupported', partId: `p${parts.length}`, sourceType: data.actionKind === 'voice' ? 'sent_voice' : frame.type,
          description: '已确认发送的受管媒体；发送事实已保存，不代表当前仍可读取原件。' })
      if (!parts.length) sourceContextError('INVALID_PARAMS')
      const ordinal = this.db.prepare('SELECT next_ordinal FROM source_conversations WHERE conversation_id=?').get(scope.conversationId) as { next_ordinal: number }
      const record = SourceRecordSchema.parse({ recordId: id('record'), conversationId: scope.conversationId, revision: 1,
        ingestOrdinal: ordinal.next_ordinal, sourceKey: `delivery:${data.eventId}`, origin: 'bot_delivery',
        sender: { id: authority.selfId, name: 'AI助手' }, platformMessageIds: [...new Set(result.messageIds)],
        receivedAt: this.now(), deliveryConfirmedAt: confirmedAt, parts, deliveryId: data.eventId })
      for (const alias of record.platformMessageIds) if (this.db.prepare('SELECT 1 FROM source_aliases WHERE conversation_id=? AND platform_message_id=?')
        .get(scope.conversationId, alias)) sourceContextError('SOURCE_CONFLICT')
      this.db.prepare('UPDATE source_conversations SET next_ordinal=next_ordinal+1 WHERE conversation_id=?').run(scope.conversationId)
      this.db.prepare('INSERT INTO source_records(record_id,conversation_id,source_key,revision,ingest_ordinal,fingerprint,data_json) VALUES (?,?,?,?,?,?,?)')
        .run(record.recordId, scope.conversationId, record.sourceKey, record.revision, record.ingestOrdinal, sourceFingerprint(record), JSON.stringify(record))
      for (const alias of record.platformMessageIds) this.db.prepare('INSERT INTO source_aliases VALUES (?,?,?)').run(scope.conversationId, alias, record.recordId)
      this.db.prepare('INSERT INTO source_scope_members VALUES (?,?)').run(scopeId, record.recordId)
      if (data.asset && attachmentId && filePartId) {
        const asset = data.asset
        const owned = !!this.db.prepare(`SELECT 1 FROM assets a JOIN asset_versions v ON v.asset_id=a.id
          WHERE a.id=? AND v.id=? AND a.owner_id=? AND a.availability='available'`).get(asset.assetId, asset.assetVersionId, authority.ownerId)
        const hasGrants = !!this.db.prepare('SELECT 1 FROM source_asset_grants WHERE asset_id=?').get(asset.assetId)
        const currentGrant = !!this.db.prepare('SELECT 1 FROM source_asset_grants WHERE asset_id=? AND asset_version_id=? AND scope_id=?')
          .get(asset.assetId, asset.assetVersionId, scopeId)
        const retained = owned && (!hasGrants || currentGrant)
        const attachment = SourceAttachmentVersionSchema.parse({ attachmentId, version: 1,
          source: { ...ref(record), partId: filePartId }, sourceId: `delivery:${data.eventId}:${filePartId}`,
          originalName: asset.originalName, declaredMimeType: asset.mimeType,
          mediaKind: asset.mimeType.startsWith('image/') ? 'image' : asset.mimeType.startsWith('audio/') ? 'audio' : asset.mimeType.startsWith('video/') ? 'video' : 'file',
          state: retained ? { kind: 'stored', assetId: asset.assetId, assetVersionId: asset.assetVersionId }
            : { kind: 'unavailable', reasonCode: 'DELIVERY_MEDIA_NOT_RETAINED' } })
        this.db.prepare('INSERT INTO source_attachment_versions VALUES (?,?,?,?)').run(attachmentId, 1, record.recordId, JSON.stringify(attachment))
        if (retained) this.db.prepare('INSERT INTO source_asset_grants VALUES (?,?,?,?,?,?)')
          .run(asset.assetId, asset.assetVersionId, scopeId, record.recordId, filePartId, record.revision)
      }
      this.db.prepare('UPDATE source_deliveries SET record_id=? WHERE delivery_id=?').run(record.recordId, data.eventId)
      authority.validate()
    })()
  }

  private check(authority: SourceAuthority, purposes: SourceAuthority['purpose'][]): void {
    SourceConversationKeySchema.parse({ ownerId: authority.ownerId, channel: authority.channel, selfId: authority.selfId,
      conversationType: authority.conversationType, targetId: authority.targetId })
    authority.validate()
    if (!purposes.includes(authority.purpose)) sourceContextError('PERMISSION_DENIED')
  }
  private conversation(authority: SourceConversationKey, create = false): string | undefined {
    const key = SourceConversationKeySchema.parse({ ownerId: authority.ownerId, channel: authority.channel, selfId: authority.selfId,
      conversationType: authority.conversationType, targetId: authority.targetId })
    const conversationId = `source-${sourceFingerprint(key)}`
    if (create) this.db.prepare(`INSERT OR IGNORE INTO source_conversations
      (conversation_id,owner_id,channel,self_id,conversation_type,target_id) VALUES (?,?,?,?,?,?)`)
      .run(conversationId, key.ownerId, key.channel, key.selfId, key.conversationType, key.targetId)
    return create || this.db.prepare('SELECT 1 FROM source_conversations WHERE conversation_id=?').get(conversationId) ? conversationId : undefined
  }
  private rawScope(scopeId: string): SourceScope {
    const row = this.db.prepare('SELECT data_json FROM source_scopes WHERE scope_id=?').get(scopeId) as JsonRow | undefined
    if (!row) sourceContextError('NOT_FOUND')
    return SourceScopeSchema.parse(JSON.parse(row.data_json))
  }
  private saveScope(scope: SourceScope): void {
    this.db.prepare('UPDATE source_scopes SET state=?,data_json=? WHERE scope_id=?')
      .run(scope.state, JSON.stringify(SourceScopeSchema.parse(scope)), scope.scopeId)
  }
  maintenanceAuthority(owner: { ownerId: string; channel: string; selfId: string; validate(): void }, scopeId: string): SourceAuthority {
    owner.validate()
    const scope = this.rawScope(scopeId)
    const row = this.db.prepare('SELECT owner_id,channel,self_id,conversation_type,target_id FROM source_conversations WHERE conversation_id=?')
      .get(scope.conversationId) as { owner_id: string; channel: string; self_id: string; conversation_type: 'group' | 'private'; target_id: string }
    if (row.owner_id !== owner.ownerId || row.channel !== owner.channel || row.self_id !== owner.selfId) sourceContextError('PERMISSION_DENIED')
    const authority: SourceAuthority = { ownerId: owner.ownerId, channel: owner.channel, selfId: owner.selfId, validate: owner.validate,
      conversationType: row.conversation_type, targetId: row.target_id, purpose: 'maintenance' }
    this.scope(authority, scopeId, ['maintenance'])
    return authority
  }
  scope(authority: SourceAuthority, scopeId: string, purposes: SourceAuthority['purpose'][] = ['execution', 'maintenance', 'management']): SourceScope {
    this.check(authority, purposes)
    const scope = this.rawScope(scopeId)
    if (scope.conversationId !== this.conversation(authority)) sourceContextError('PERMISSION_DENIED')
    if (authority.purpose !== 'management') {
      const owner = this.db.prepare('SELECT enabled FROM source_owner_access WHERE owner_id=?').get(authority.ownerId) as { enabled: number } | undefined
      if (!owner?.enabled) sourceContextError('PERMISSION_DENIED')
      const head = this.db.prepare('SELECT * FROM source_scope_heads WHERE conversation_id=?').get(scope.conversationId) as Head | undefined
      if (scope.state !== 'active' || head?.state !== 'active' || head.scope_id !== scopeId || head.permission_revision !== scope.permissionRevision)
        sourceContextError('PERMISSION_DENIED')
    }
    return scope
  }
  /** Atomic policy application; retrying a saved revision cannot create another generation. */
  applyScopes(owner: { ownerId: string; channel: string; selfId: string; validate(): void }, revision: number, targets: SourceScopeTarget[]): SourceScope[] {
    if (!Number.isSafeInteger(revision) || revision < 0) sourceContextError('INVALID_PARAMS')
    const normalized = targets.map(target => {
      SourceConversationKeySchema.parse({ ownerId: owner.ownerId, channel: owner.channel, selfId: owner.selfId,
        conversationType: target.conversationType, targetId: target.targetId })
      if (!target.presetId || target.presetId.length > 256 || target.qqContextEpoch.length > 256) sourceContextError('INVALID_PARAMS')
      return target
    }).sort((a, b) => canonical(a).localeCompare(canonical(b)))
    if (new Set(normalized.map(t => `${t.conversationType}:${t.targetId}`)).size !== normalized.length) sourceContextError('INVALID_PARAMS')
    const fingerprint = sourceFingerprint(normalized)
    return this.db.transaction(() => {
      owner.validate()
      this.db.prepare('INSERT INTO source_owner_access(owner_id,enabled) VALUES (?,1) ON CONFLICT(owner_id) DO UPDATE SET enabled=1').run(owner.ownerId)
      const application = this.db.prepare(`SELECT fingerprint,result_json FROM source_config_applications
        WHERE owner_id=? AND channel=? AND self_id=? AND config_revision=?`).get(owner.ownerId, owner.channel, owner.selfId, revision) as
        { fingerprint: string; result_json: string } | undefined
      if (application) {
        if (application.fingerprint !== fingerprint) sourceContextError('SOURCE_CONFLICT')
        return (JSON.parse(application.result_json) as string[]).map(scopeId => this.rawScope(scopeId))
      }
      const latest = this.db.prepare(`SELECT MAX(config_revision) AS revision FROM source_config_applications WHERE owner_id=? AND channel=? AND self_id=?`)
        .get(owner.ownerId, owner.channel, owner.selfId) as { revision: number | null }
      if (latest.revision !== null && latest.revision > revision) sourceContextError('REVISION_CONFLICT')
      const wanted = new Set<string>(), scopes: SourceScope[] = []
      for (const target of normalized) {
        const key = { ...owner, conversationType: target.conversationType, targetId: target.targetId }
        const conversationId = this.conversation(key, true)!
        wanted.add(conversationId)
        const head = this.db.prepare('SELECT * FROM source_scope_heads WHERE conversation_id=?').get(conversationId) as Head | undefined
        const previous = head?.scope_id ? this.rawScope(head.scope_id) : undefined
        if (previous?.state === 'active' && previous.presetId === target.presetId && previous.qqContextEpoch === target.qqContextEpoch) {
          this.db.prepare('UPDATE source_scope_heads SET applied_config_revision=? WHERE conversation_id=?').run(revision, conversationId)
          scopes.push(previous)
          continue
        }
        if (previous?.state === 'active') this.saveScope({ ...previous, state: 'retired' })
        const scope: SourceScope = { scopeId: id('scope'), conversationId, presetId: target.presetId, qqContextEpoch: target.qqContextEpoch,
          generation: (head?.generation ?? 0) + 1, permissionRevision: (head?.permission_revision ?? 0) + 1,
          selectionRevision: 0, state: 'active', createdAt: this.now() }
        this.db.prepare('INSERT INTO source_scopes(scope_id,conversation_id,generation,state,data_json) VALUES (?,?,?,?,?)')
          .run(scope.scopeId, conversationId, scope.generation, scope.state, JSON.stringify(scope))
        this.db.prepare(`INSERT INTO source_scope_heads(conversation_id,scope_id,generation,permission_revision,applied_config_revision,state)
          VALUES (?,?,?,?,?,'active') ON CONFLICT(conversation_id) DO UPDATE SET scope_id=excluded.scope_id,generation=excluded.generation,
          permission_revision=excluded.permission_revision,applied_config_revision=excluded.applied_config_revision,state='active'`)
          .run(conversationId, scope.scopeId, scope.generation, scope.permissionRevision, revision)
        this.db.prepare(`INSERT INTO source_completeness(completeness_id,scope_id,kind,observed_at,data_json) VALUES (?,?,'history_start',?,?)`)
          .run(id('completeness'), scope.scopeId, scope.createdAt, JSON.stringify({ observedAt: scope.createdAt }))
        scopes.push(scope)
      }
      const existing = this.db.prepare(`SELECT h.conversation_id,h.scope_id FROM source_scope_heads h JOIN source_conversations c USING(conversation_id)
        WHERE c.owner_id=? AND c.channel=? AND c.self_id=? AND h.state='active'`).all(owner.ownerId, owner.channel, owner.selfId) as
        { conversation_id: string; scope_id: string }[]
      for (const head of existing) if (!wanted.has(head.conversation_id)) {
        this.saveScope({ ...this.rawScope(head.scope_id), state: 'retired' })
        this.db.prepare(`UPDATE source_scope_heads SET state='disabled',permission_revision=permission_revision+1,applied_config_revision=? WHERE conversation_id=?`)
          .run(revision, head.conversation_id)
      }
      owner.validate()
      this.db.prepare(`INSERT INTO source_config_applications(owner_id,channel,self_id,config_revision,fingerprint,result_json) VALUES (?,?,?,?,?,?)`)
        .run(owner.ownerId, owner.channel, owner.selfId, revision, fingerprint, JSON.stringify(scopes.map(s => s.scopeId)))
      return scopes
    })()
  }
  ensureScope(authority: SourceAuthority, presetId: string, qqContextEpoch: string): SourceScope {
    this.check(authority, ['record', 'execution', 'maintenance'])
    const conversationId = this.conversation(authority)
    const row = conversationId ? this.db.prepare(`SELECT scope_id FROM source_scope_heads WHERE conversation_id=? AND state='active'`).get(conversationId) as { scope_id: string } | undefined : undefined
    if (!row) sourceContextError('PERMISSION_DENIED')
    const scope = this.scope(authority, row.scope_id, ['record', 'execution', 'maintenance'])
    if (scope.presetId !== presetId || scope.qqContextEpoch !== qqContextEpoch) sourceContextError('REVISION_CONFLICT')
    return scope
  }
  bindCore(authority: SourceAuthority, scopeId: string, binding: NonNullable<SourceScope['coreBinding']>): SourceScope {
    return this.db.transaction(() => {
      const scope = this.scope(authority, scopeId, ['execution'])
      if (scope.coreBinding && canonical(scope.coreBinding) !== canonical(binding)) {
        if (scope.coreBinding.chatId !== binding.chatId) sourceContextError('SOURCE_CONFLICT')
        const transition = this.db.prepare(`SELECT 1 FROM chats c
          JOIN chat_epochs previous ON previous.epoch_id=? AND previous.root_chat_id=c.id
          JOIN chat_epochs current ON current.epoch_id=c.active_epoch_id AND current.root_chat_id=c.id
          WHERE c.id=? AND c.active_epoch_id=? AND previous.status='historical'
            AND current.status='active' AND current.ordinal>previous.ordinal
            AND current.transition_reason='configuration-changed'
            AND json_extract(c.metadata,'$.presetId')=?`)
          .get(scope.coreBinding.epochId, binding.chatId, binding.epochId, scope.presetId)
        if (!transition) sourceContextError('SOURCE_CONFLICT')
      }
      const next = SourceScopeSchema.parse({ ...scope, coreBinding: binding })
      this.saveScope(next)
      this.db.prepare(`INSERT OR IGNORE INTO asset_chat_grants(asset_id,chat_id)
        SELECT DISTINCT asset_id,? FROM source_asset_grants WHERE scope_id=?`).run(binding.chatId, scopeId)
      authority.validate()
      return next
    })()
  }
  private rawRecord(recordId: string): SourceRecord {
    const row = this.db.prepare('SELECT data_json FROM source_records WHERE record_id=?').get(recordId) as JsonRow | undefined
    if (!row) sourceContextError('NOT_FOUND')
    return SourceRecordSchema.parse(JSON.parse(row.data_json))
  }
  private receipt(row: ReceiptRow): SourceReceipt {
    const record = ref(this.rawRecord(row.record_id))
    return row.state === 'completed'
      ? { state: 'completed', receiptId: row.receipt_id, version: row.version, record, result: JSON.parse(row.result_json!) as SourceReceiptResult }
      : { state: 'pending', receiptId: row.receipt_id, version: row.version, record }
  }
  beginReceipt(authority: SourceAuthority, scopeId: string, input: SourceReceiptInput): SourceReceipt {
    return this.db.transaction((): SourceReceipt => {
      const scope = this.scope(authority, scopeId, ['record'])
      if (!authority.actorId || input.sender.id !== authority.actorId || !input.eventId || input.eventId.length > 256 || !/^-?\d{1,100}$/.test(input.messageId))
        sourceContextError('IDENTITY_REJECTED')
      const parts = SourcePartsSchema.parse(input.parts).map(part => part.type === 'attachment'
        ? { ...part, attachmentId: `attachment-${sourceFingerprint([scope.conversationId, input.messageId, part.partId])}` } : part)
      const attachmentParts = parts.filter(p => p.type === 'attachment')
      const attachments = input.attachments ?? []
      if (attachments.length !== attachmentParts.length || new Set(attachments.map(a => a.partId)).size !== attachments.length ||
        attachments.some(a => !attachmentParts.some(p => p.partId === a.partId))) sourceContextError('INVALID_PARAMS')
      // Transport permits, fresh download locations, nickname and reception time cannot change a source identity.
      const fingerprint = sourceFingerprint({ senderId: input.sender.id, messageId: input.messageId, parts,
        attachments: [...attachments].sort((a, b) => a.partId.localeCompare(b.partId)) })
      const event = this.db.prepare(`SELECT r.* FROM source_receipt_events e JOIN source_receipts r USING(receipt_id)
        WHERE e.conversation_id=? AND e.event_id=?`).get(scope.conversationId, input.eventId) as ReceiptRow | undefined
      const original = event ?? this.db.prepare(`SELECT r.* FROM source_receipts r JOIN source_records s USING(record_id)
        WHERE s.conversation_id=? AND s.source_key=?`).get(scope.conversationId, `member:${input.messageId}`) as ReceiptRow | undefined
      if (original) {
        if (original.fingerprint !== fingerprint) sourceContextError('SOURCE_CONFLICT')
        this.db.prepare('INSERT OR IGNORE INTO source_receipt_events(conversation_id,event_id,receipt_id) VALUES (?,?,?)')
          .run(scope.conversationId, input.eventId, original.receipt_id)
        // In particular, do not grant the old record to a newly selected preset.
        authority.validate()
        return this.receipt(original)
      }
      const next = this.db.prepare('SELECT next_ordinal FROM source_conversations WHERE conversation_id=?').get(scope.conversationId) as { next_ordinal: number }
      const record = SourceRecordSchema.parse({ recordId: id('record'), conversationId: scope.conversationId, revision: 1,
        ingestOrdinal: next.next_ordinal, sourceKey: `member:${input.messageId}`, origin: 'member', sender: input.sender,
        platformMessageIds: [input.messageId], receivedAt: this.now(), platformSentAt: input.platformSentAt, sourceOrder: input.sourceOrder, parts })
      this.db.prepare('UPDATE source_conversations SET next_ordinal=next_ordinal+1 WHERE conversation_id=?').run(scope.conversationId)
      this.db.prepare(`INSERT INTO source_records(record_id,conversation_id,source_key,revision,ingest_ordinal,fingerprint,data_json) VALUES (?,?,?,?,?,?,?)`)
        .run(record.recordId, record.conversationId, record.sourceKey, record.revision, record.ingestOrdinal, fingerprint, JSON.stringify(record))
      this.db.prepare('INSERT INTO source_aliases(conversation_id,platform_message_id,record_id) VALUES (?,?,?)')
        .run(scope.conversationId, input.messageId, record.recordId)
      this.db.prepare('INSERT INTO source_scope_members(scope_id,record_id) VALUES (?,?)').run(scopeId, record.recordId)
      for (const attachment of attachments) {
        const part = attachmentParts.find(p => p.partId === attachment.partId)!
        const { partId: position, ...metadata } = attachment
        const version = SourceAttachmentVersionSchema.parse({ ...metadata, sourceId: `source-${sourceFingerprint([record.recordId, position])}`,
          attachmentId: part.attachmentId, version: 1,
          source: { ...ref(record), partId: position }, state: { kind: 'pending' } })
        this.db.prepare('INSERT INTO source_attachment_versions(attachment_id,version,record_id,data_json) VALUES (?,?,?,?)')
          .run(version.attachmentId, version.version, record.recordId, JSON.stringify(version))
      }
      const receiptId = id('receipt')
      this.db.prepare(`INSERT INTO source_receipts(receipt_id,conversation_id,scope_id,event_id,record_id,fingerprint,state,version) VALUES (?,?,?,?,?,?,'pending',1)`)
        .run(receiptId, scope.conversationId, scopeId, input.eventId, record.recordId, fingerprint)
      this.db.prepare('INSERT INTO source_receipt_events(conversation_id,event_id,receipt_id) VALUES (?,?,?)').run(scope.conversationId, input.eventId, receiptId)
      authority.validate()
      return { state: 'pending', receiptId, version: 1, record: ref(record) }
    })()
  }
  completeReceipt(authority: SourceAuthority, receiptId: string, expectedVersion: number, handling: SourceHandling,
    scopeId: string, eventId: string): SourceReceiptResult {
    return this.db.transaction(() => {
      this.check(authority, ['record'])
      SourceHandlingSchema.parse(handling)
      const row = this.db.prepare('SELECT * FROM source_receipts WHERE receipt_id=? AND conversation_id=?')
        .get(receiptId, this.conversation(authority) ?? '') as ReceiptRow | undefined
      if (!row) sourceContextError('NOT_FOUND')
      if (row.scope_id !== scopeId || !this.db.prepare(`SELECT 1 FROM source_receipt_events WHERE conversation_id=? AND event_id=? AND receipt_id=?`)
        .get(this.conversation(authority)!, eventId, receiptId) || this.rawRecord(row.record_id).sender.id !== authority.actorId)
        sourceContextError('PERMISSION_DENIED')
      if (row.state === 'completed') {
        const result = this.receipt(row)
        if (result.state !== 'completed' || canonical(result.result.handling) !== canonical(handling)) sourceContextError('SOURCE_CONFLICT')
        return result.result
      }
      if (row.version !== expectedVersion) sourceContextError('REVISION_CONFLICT')
      if (handling.kind === 'queued' || handling.kind === 'merged') {
        const known = this.db.prepare('SELECT scope_id FROM source_management_requests WHERE request_id=?').get(handling.requestId) as { scope_id: string } | undefined
        if (known && known.scope_id !== row.scope_id) sourceContextError('SOURCE_CONFLICT')
        this.db.prepare('INSERT OR IGNORE INTO source_management_requests VALUES (?,?,?)').run(handling.requestId, row.scope_id, this.now())
      }
      this.scope(authority, row.scope_id, ['record'])
      const result: SourceReceiptResult = { receiptId, version: row.version + 1, eventId: row.event_id,
        record: ref(this.rawRecord(row.record_id)), storage: 'stored', handling }
      this.db.prepare("UPDATE source_receipts SET state='completed',version=?,result_json=?,reason_code=NULL WHERE receipt_id=?")
        .run(result.version, JSON.stringify(result), receiptId)
      authority.validate()
      return result
    })()
  }
  receiptStatus(authority: SourceAuthority, eventId: string): SourceReceiptStatus {
    this.check(authority, ['record', 'management'])
    const row = this.db.prepare(`SELECT r.* FROM source_receipt_events e JOIN source_receipts r USING(receipt_id)
      WHERE e.conversation_id=? AND e.event_id=?`).get(this.conversation(authority) ?? '', eventId) as ReceiptRow | undefined
    if (!row) return { state: 'not_found' }
    if (authority.purpose === 'record' && this.rawRecord(row.record_id).sender.id !== authority.actorId) sourceContextError('PERMISSION_DENIED')
    const saved = this.receipt(row)
    authority.validate()
    return saved.state === 'completed'
      ? { state: 'completed', result: saved.result, currentSourceState: this.rawScope(row.scope_id).state === 'deleted' ? 'deleted' : 'retained' }
      : { state: 'pending', receiptId: row.receipt_id, record: saved.record, ...(row.reason_code ? { reasonCode: row.reason_code } : {}) }
  }
  lookupReceipt(input: { ownerId: string; channel: string; selfId: string; eventId: string; validateIdentity(): void }): SourceReceiptStatus {
    input.validateIdentity()
    const row = this.db.prepare(`SELECT r.* FROM source_receipt_events e JOIN source_receipts r USING(receipt_id)
      JOIN source_conversations c ON c.conversation_id=e.conversation_id
      WHERE c.owner_id=? AND c.channel=? AND c.self_id=? AND e.event_id=?`)
      .get(input.ownerId, input.channel, input.selfId, input.eventId) as ReceiptRow | undefined
    const saved = row && this.receipt(row)
    input.validateIdentity()
    if (!saved || !row) return { state: 'not_found' }
    return saved.state === 'completed' ? { state: 'completed', result: saved.result,
      currentSourceState: this.rawScope(row.scope_id).state === 'deleted' ? 'deleted' : 'retained' }
      : { state: 'pending', receiptId: saved.receiptId, record: saved.record, ...(row.reason_code ? { reasonCode: row.reason_code } : {}) }
  }
  read(authority: SourceAuthority, scopeId: string, refs: SourceRecordRef[]): SourceRecord[] {
    this.scope(authority, scopeId)
    const records = refs.map(reference => {
      const member = this.db.prepare(`SELECT s.data_json FROM source_scope_members m JOIN source_records s USING(record_id)
        WHERE m.scope_id=? AND m.record_id=?`).get(scopeId, reference.recordId) as JsonRow | undefined
      if (!member) sourceContextError('PERMISSION_DENIED')
      const record = SourceRecordSchema.parse(JSON.parse(member.data_json))
      if (record.revision !== reference.revision) sourceContextError('REVISION_CONFLICT')
      return record
    })
    authority.validate()
    return records
  }
  readSelection(authority: SourceAuthority, scopeId: string, value: SourceReadSelection): SourceReadResult {
    const selection = SourceReadSelectionSchema.parse(value)
    return this.db.transaction(() => {
      const scope = this.scope(authority, scopeId)
      let refs: SourceRecordRef[], nextCursor: string | null = null
      if (selection.kind === 'records') refs = selection.refs
      else {
        const snapshot = this.snapshot(authority, scopeId, selection.snapshotId)
        const all = snapshot.orderedItems.flatMap(item => item.type === 'message' ? [{ recordId: item.recordId, revision: item.revision }] : [])
        let position = 0
        if (selection.cursor) {
          const saved = this.db.prepare(`SELECT position FROM source_read_cursors WHERE cursor_id=? AND scope_id=? AND snapshot_id=? AND permission_revision=?`)
            .get(selection.cursor, scopeId, selection.snapshotId, scope.permissionRevision) as { position: number } | undefined
          if (!saved) sourceContextError('REVISION_CONFLICT')
          position = saved.position
        }
        refs = all.slice(position, position + (selection.limit ?? 50))
        const next = position + refs.length
        if (next < all.length) {
          this.db.prepare(`INSERT OR IGNORE INTO source_read_cursors(cursor_id,scope_id,snapshot_id,permission_revision,position) VALUES (?,?,?,?,?)`)
            .run(id('cursor'), scopeId, snapshot.snapshotId, scope.permissionRevision, next)
          nextCursor = (this.db.prepare(`SELECT cursor_id FROM source_read_cursors WHERE scope_id=? AND snapshot_id=? AND permission_revision=? AND position=?`)
            .get(scopeId, snapshot.snapshotId, scope.permissionRevision, next) as { cursor_id: string }).cursor_id
        }
      }
      const items: SourceReadResult['items'] = refs.map(reference => {
        const row = this.db.prepare(`SELECT r.data_json FROM source_scope_members m JOIN source_records r USING(record_id)
          WHERE m.scope_id=? AND m.record_id=?`).get(scopeId, reference.recordId) as JsonRow | undefined
        if (!row) return { ref: reference, state: 'unavailable', reasonCode: scope.state === 'deleted' ? 'source_deleted' : 'permission_denied' }
        const record = SourceRecordSchema.parse(JSON.parse(row.data_json))
        if (record.revision !== reference.revision) return { ref: reference, state: 'unavailable', reasonCode: 'not_retained' }
        return { ref: reference, state: 'available', record }
      })
      authority.validate()
      return { scopeId, observedAt: this.now(), items, nextCursor }
    })()
  }
  attachment(authority: SourceAuthority, scopeId: string, attachmentId: string, version?: number): SourceAttachmentVersion {
    this.scope(authority, scopeId)
    const result = this.scopedAttachment(scopeId, attachmentId, version)
    authority.validate()
    return result
  }
  private scopedAttachment(scopeId: string, attachmentId: string, version?: number): SourceAttachmentVersion {
    const row = this.db.prepare(`SELECT a.data_json FROM source_attachment_versions a JOIN source_scope_members m USING(record_id)
      WHERE m.scope_id=? AND a.attachment_id=? ${version === undefined ? '' : 'AND a.version=?'} ORDER BY a.version DESC LIMIT 1`)
      .get(...(version === undefined ? [scopeId, attachmentId] : [scopeId, attachmentId, version])) as JsonRow | undefined
    if (!row) sourceContextError('PERMISSION_DENIED')
    return SourceAttachmentVersionSchema.parse(JSON.parse(row.data_json))
  }
  /** Record-only access is restricted to the exact authenticated event, never projected as execution. */
  receiptContent(authority: SourceAuthority, scopeId: string, eventId: string): { record: SourceRecord; attachments: SourceAttachmentVersion[] } {
    this.scope(authority, scopeId, ['record'])
    const receipt = this.receiptStatus(authority, eventId)
    if (receipt.state === 'not_found') sourceContextError('NOT_FOUND')
    const reference = receipt.state === 'completed' ? receipt.result.record : receipt.record
    if (!this.db.prepare('SELECT 1 FROM source_scope_members WHERE scope_id=? AND record_id=?').get(scopeId, reference.recordId))
      sourceContextError('PERMISSION_DENIED')
    const record = this.rawRecord(reference.recordId)
    const attachments = record.parts.flatMap(part => part.type === 'attachment' ? [this.scopedAttachment(scopeId, part.attachmentId)] : [])
    authority.validate()
    return { record, attachments }
  }
  assetSource(authority: SourceAuthority, scopeId: string, assetId: string, assetVersionId: string): SourceAttachmentVersion {
    this.scope(authority, scopeId, ['execution'])
    const row = this.db.prepare(`SELECT a.data_json FROM source_asset_grants g
      JOIN source_attachment_versions a ON a.record_id=g.record_id
      WHERE g.scope_id=? AND g.asset_id=? AND g.asset_version_id=?
        AND json_extract(a.data_json,'$.source.partId')=g.part_id
        AND json_extract(a.data_json,'$.state.assetId')=g.asset_id
        AND json_extract(a.data_json,'$.state.assetVersionId')=g.asset_version_id
      ORDER BY a.version DESC,g.record_id,g.part_id LIMIT 1`).get(scopeId, assetId, assetVersionId) as JsonRow | undefined
    if (!row) sourceContextError('PERMISSION_DENIED')
    authority.validate()
    return SourceAttachmentVersionSchema.parse(JSON.parse(row.data_json))
  }
  updateAttachment(authority: SourceAuthority, scopeId: string, attachmentId: string, expectedVersion: number,
    state: SourceAttachmentVersion['state']): SourceAttachmentVersion {
    return this.db.transaction(() => {
      this.scope(authority, scopeId, ['record', 'execution'])
      const previous = this.scopedAttachment(scopeId, attachmentId)
      if (authority.purpose === 'record' && this.rawRecord(previous.source.recordId).sender.id !== authority.actorId)
        sourceContextError('PERMISSION_DENIED')
      if (canonical(previous.state) === canonical(state)) return previous
      if (previous.version !== expectedVersion) sourceContextError('REVISION_CONFLICT')
      if (previous.state.kind === 'stored' || previous.state.kind === 'unavailable') sourceContextError('SOURCE_CONFLICT')
      if (state.kind === 'stored' && !this.db.prepare(`SELECT 1 FROM source_asset_grants WHERE scope_id=? AND record_id=? AND part_id=?
        AND asset_id=? AND asset_version_id=?`).get(scopeId, previous.source.recordId, previous.source.partId, state.assetId, state.assetVersionId))
        sourceContextError('PERMISSION_DENIED')
      const next = SourceAttachmentVersionSchema.parse({ ...previous, version: previous.version + 1, state })
      this.db.prepare('INSERT INTO source_attachment_versions(attachment_id,version,record_id,data_json) VALUES (?,?,?,?)')
        .run(attachmentId, next.version, next.source.recordId, JSON.stringify(next))
      authority.validate()
      return next
    })()
  }
  private allRecords(scopeId: string, through = Number.MAX_SAFE_INTEGER): SourceRecord[] {
    return (this.db.prepare(`SELECT s.data_json FROM source_scope_members m JOIN source_records s USING(record_id)
      WHERE m.scope_id=? AND s.ingest_ordinal<=? ORDER BY s.ingest_ordinal`).all(scopeId, through) as JsonRow[])
      .map(row => SourceRecordSchema.parse(JSON.parse(row.data_json)))
  }
  registerWorkspace(authority: SourceAuthority, scopeId: string, attachmentId: string, version: number, value: SourceWorkspaceMount): void {
    this.db.transaction(() => {
      const scope = this.scope(authority, scopeId, ['execution']), attachment = this.attachment(authority, scopeId, attachmentId, version)
      const mount = SourceWorkspaceMountSchema.parse(value)
      if (attachment.state.kind !== 'stored' || mount.scopeId !== scopeId || mount.slotKey !==
        `${attachment.source.recordId}-${attachment.source.partId}-${mount.sha256.slice(0, 12)}`) sourceContextError('SOURCE_CONFLICT')
      const saved = this.workspace(authority, scopeId, attachmentId, version)
      if (saved && canonical(saved) !== canonical(mount)) sourceContextError('SOURCE_CONFLICT')
      this.db.prepare(`INSERT OR IGNORE INTO source_workspaces(scope_id,attachment_id,attachment_version,permission_revision,data_json) VALUES (?,?,?,?,?)`)
        .run(scopeId, attachmentId, version, scope.permissionRevision, JSON.stringify(mount))
      authority.validate()
    })()
  }
  workspace(authority: SourceAuthority, scopeId: string, attachmentId: string, version: number): SourceWorkspaceMount | undefined {
    const scope = this.scope(authority, scopeId), row = this.db.prepare(`SELECT data_json FROM source_workspaces
      WHERE scope_id=? AND attachment_id=? AND attachment_version=? AND permission_revision=?`)
      .get(scopeId, attachmentId, version, scope.permissionRevision) as JsonRow | undefined
    return row ? SourceWorkspaceMountSchema.parse(JSON.parse(row.data_json)) : undefined
  }
  summary(authority: SourceAuthority, scopeId: string, summaryId?: string): SourceSummary | undefined {
    this.scope(authority, scopeId)
    const row = summaryId
      ? this.db.prepare('SELECT data_json FROM source_summaries WHERE scope_id=? AND summary_id=?').get(scopeId, summaryId) as JsonRow | undefined
      : this.db.prepare(`SELECT s.data_json FROM source_scopes c JOIN source_summaries s ON s.summary_id=c.active_summary_id WHERE c.scope_id=?`).get(scopeId) as JsonRow | undefined
    return row ? SourceSummarySchema.parse(JSON.parse(row.data_json)) : undefined
  }
  freeze(authority: SourceAuthority, scopeId: string, input: SourceFreezeInput): SourceSnapshot {
    return this.db.transaction(() => {
      const scope = this.scope(authority, scopeId, ['execution'])
      if (!input.requestId || input.requestId.length > 256 || !input.inputRecords.length || input.inputRecords.length > 16 ||
        new Set(input.inputRecords.map(r => r.recordId)).size !== input.inputRecords.length ||
        !input.inputRecords.some(r => canonical(r) === canonical(input.actorRecord))) sourceContextError('INVALID_PARAMS')
      const fingerprint = sourceFingerprint({ ...input, scopeId })
      const previous = this.db.prepare('SELECT fingerprint,data_json FROM source_snapshots WHERE request_id=? AND parent_snapshot_id IS NULL')
        .get(input.requestId) as (JsonRow & { fingerprint: string }) | undefined
      if (previous) {
        if (previous.fingerprint !== fingerprint) sourceContextError('SOURCE_CONFLICT')
        const saved = SourceSnapshotSchema.parse(JSON.parse(previous.data_json))
        if (saved.scopeId !== scopeId) sourceContextError('PERMISSION_DENIED')
        return saved
      }
      if (scope.selectionRevision !== input.expectedSelectionRevision) sourceContextError('REVISION_CONFLICT')
      const current = this.read(authority, scopeId, input.inputRecords)
      if (current.some(record => record.sender.id !== authority.actorId)) sourceContextError('IDENTITY_REJECTED')
      if (input.observationCandidates && (!input.observationCandidates.length || input.observationCandidates.length > 1000 ||
        this.read(authority, scopeId, input.observationCandidates).some(record => record.origin !== 'member'))) sourceContextError('INVALID_PARAMS')
      const policy = input.policy
      if (!Number.isSafeInteger(policy.historyLimit) || policy.historyLimit < 1 || policy.historyLimit > 1000 ||
        !Number.isSafeInteger(policy.backgroundMaxAgeMs) || policy.backgroundMaxAgeMs < 0 ||
        !Number.isSafeInteger(policy.backgroundMaxChars) || policy.backgroundMaxChars < 0 ||
        !Number.isSafeInteger(policy.qqConfigRevision) || policy.qqConfigRevision < 0) sourceContextError('INVALID_PARAMS')
      const selectedAt = this.now(), records = this.allRecords(scopeId)
      const time = (r: SourceRecord) => r.platformSentAt ?? r.deliveryConfirmedAt ?? r.receivedAt
      records.sort((a, b) => time(a) - time(b) || a.ingestOrdinal - b.ingestOrdinal || a.recordId.localeCompare(b.recordId))
      const selected = new Map<string, Array<'current' | 'recent' | 'explicit_quote'>>()
      for (const record of current) selected.set(record.recordId, ['current'])
      const quotes: SourceSnapshot['quoteRelations'] = []
      for (const record of current) for (const part of record.parts) if (part.type === 'reply') {
        const alias = this.db.prepare(`SELECT a.record_id,m.scope_id FROM source_aliases a LEFT JOIN source_scope_members m
          ON m.record_id=a.record_id AND m.scope_id=? WHERE a.conversation_id=? AND a.platform_message_id=?`)
          .get(scopeId, scope.conversationId, part.platformMessageId) as { record_id: string; scope_id: string | null } | undefined
        const result: SourceSnapshot['quoteRelations'][number]['result'] = !alias ? { kind: 'not_retained' }
          : !alias.scope_id ? { kind: 'out_of_scope' } : { kind: 'resolved', target: ref(this.rawRecord(alias.record_id)) }
        quotes.push({ source: { ...ref(record), partId: part.partId }, platformMessageId: part.platformMessageId, result })
        if (result.kind === 'resolved') {
          const reasons = selected.get(result.target.recordId) ?? []
          if (!reasons.includes('explicit_quote')) reasons.push('explicit_quote')
          selected.set(result.target.recordId, reasons)
        }
      }
      const summary = this.summary(authority, scopeId)
      const replacements = new Map((summary?.replacement ?? []).map(r => [r.record.recordId, new Set(r.partIds)]))
      let recentCount = 0, recentChars = 0
      for (const record of [...records].reverse()) {
        if (selected.has(record.recordId)) continue
        if (Math.max(0, selectedAt - record.receivedAt) > policy.backgroundMaxAgeMs) continue
        const replaced = replacements.get(record.recordId)
        const chars = record.parts.reduce((n, part) => n + Array.from(replaced?.has(part.partId)
          ? '此段由摘要代替' : part.type === 'text' ? part.text : canonical(part)).length, 0)
        if (recentCount >= policy.historyLimit || recentChars + chars > policy.backgroundMaxChars) break
        selected.set(record.recordId, ['recent']); recentCount++; recentChars += chars
      }
      const snapshotId = id('snapshot'), orderedItems: SourceSnapshotItem[] = []
      if (summary) orderedItems.push({ type: 'summary', summaryId: summary.summaryId, revision: summary.revision })
      for (const row of this.db.prepare('SELECT completeness_id,kind FROM source_completeness WHERE scope_id=? ORDER BY observed_at,completeness_id')
        .all(scopeId) as { completeness_id: string; kind: 'history_start' | 'reception_unconfirmed' | 'source_deleted' }[])
        orderedItems.push({ type: 'gap', reason: row.kind, completenessRecordId: row.completeness_id })
      const omittedSets: Array<{ setId: string; refs: SourceRecordRef[] }> = []
      let omitted: SourceRecord[] = []
      const flush = () => {
        if (!omitted.length) return
        const setId = id('omitted')
        orderedItems.push({ type: 'gap', reason: 'omitted_from_context', omittedSetId: setId, knownMessageCount: omitted.length,
          firstRecord: ref(omitted[0]!), lastRecord: ref(omitted[omitted.length - 1]!),
          partiallySummarizedCount: omitted.filter(r => (replacements.get(r.recordId)?.size ?? 0) > 0).length })
        omittedSets.push({ setId, refs: omitted.map(ref) }); omitted = []
      }
      for (const record of records) {
        const reasons = selected.get(record.recordId), replaced = replacements.get(record.recordId)
        if (!reasons) {
          if (!record.parts.length || !record.parts.every(p => replaced?.has(p.partId))) omitted.push(record)
          continue
        }
        flush()
        const restore = reasons.includes('current') || reasons.includes('explicit_quote')
        orderedItems.push({ type: 'message', ...ref(record), selectionReasons: reasons,
          parts: record.parts.map(p => !restore && replaced?.has(p.partId) && summary
            ? { partId: p.partId, mode: 'summary_reference' as const, summaryId: summary.summaryId }
            : { partId: p.partId, mode: 'expand' as const }) })
      }
      flush()
      const snapshot = SourceSnapshotSchema.parse({ snapshotId, requestId: input.requestId, turnId: input.requestId, scopeId, snapshotVersion: 1,
        selectionRevision: scope.selectionRevision, throughIngestOrdinal: records.reduce((n, r) => Math.max(n, r.ingestOrdinal), 0),
        selectedAt, qqConfigRevision: policy.qqConfigRevision, ordering: 'time_approximate',
        selectionStats: { recentRecordCount: recentCount, recentTextCodePoints: recentChars },
        actorRecord: input.actorRecord, inputRecords: input.inputRecords, orderedItems, quoteRelations: quotes })
      this.db.prepare('INSERT INTO source_snapshots(snapshot_id,request_id,scope_id,fingerprint,data_json) VALUES (?,?,?,?,?)')
        .run(snapshotId, input.requestId, scopeId, fingerprint, JSON.stringify(snapshot))
      if (input.observationCandidates) this.db.prepare('INSERT INTO source_observation_batches VALUES (?,?,?,?)')
        .run(input.requestId, scopeId, scope.permissionRevision, JSON.stringify(input.observationCandidates))
      for (const set of omittedSets) this.db.prepare('INSERT INTO source_omitted_sets(set_id,snapshot_id,refs_json) VALUES (?,?,?)')
        .run(set.setId, snapshotId, JSON.stringify(set.refs))
      authority.validate()
      return snapshot
    })()
  }
  snapshot(authority: SourceAuthority, scopeId: string, snapshotId: string): SourceSnapshot {
    this.scope(authority, scopeId)
    const row = this.db.prepare('SELECT data_json FROM source_snapshots WHERE scope_id=? AND snapshot_id=?').get(scopeId, snapshotId) as JsonRow | undefined
    if (!row) sourceContextError('NOT_FOUND')
    return SourceSnapshotSchema.parse(JSON.parse(row.data_json))
  }
  /** Answers are provenance for the completed question tool, never a second user-text copy. */
  answerSnapshot(authority: SourceAuthority, input: { parentSnapshotId: string; commandId: string; runId: string; batchId: string;
    answers: Array<{ questionId: string; record: SourceRecordRef; text: string }> }): { snapshot: SourceSnapshot; sourceInput: import('@chery/protocol').SourceInput } {
    return this.db.transaction(() => {
      this.check(authority, ['execution'])
      const parentRow = this.db.prepare('SELECT scope_id FROM source_snapshots WHERE snapshot_id=?').get(input.parentSnapshotId) as { scope_id: string } | undefined
      if (!parentRow) sourceContextError('NOT_FOUND')
      let parent = this.snapshot(authority, parentRow.scope_id, input.parentSnapshotId)
      if (!this.db.prepare('SELECT 1 FROM source_runs WHERE request_id=? AND run_id=? AND scope_id=?')
        .get(parent.requestId, input.runId, parent.scopeId)) sourceContextError('PERMISSION_DENIED')
      if (!parent.actorRecord || this.read(authority, parent.scopeId, [parent.actorRecord])[0]?.sender.id !== authority.actorId)
        sourceContextError('PERMISSION_DENIED')
      if (!input.answers.length || input.answers.length > 16 || new Set(input.answers.map(answer => answer.questionId)).size !== input.answers.length ||
        new Set(input.answers.map(answer => answer.record.recordId)).size !== input.answers.length) sourceContextError('INVALID_PARAMS')
      const snapshotId = `source-answer-${sourceFingerprint([input.commandId, input.parentSnapshotId])}`, fingerprint = sourceFingerprint(input)
      const previous = this.db.prepare('SELECT fingerprint,data_json FROM source_snapshots WHERE snapshot_id=?').get(snapshotId) as (JsonRow & { fingerprint: string }) | undefined
      let snapshot: SourceSnapshot
      if (previous) {
        if (previous.fingerprint !== fingerprint) sourceContextError('SOURCE_CONFLICT')
        snapshot = SourceSnapshotSchema.parse(JSON.parse(previous.data_json))
      } else {
        // The QQ state may still name the pre-compaction snapshot. Only a snapshot
        // actually used by this run can advance it; prepared candidates grant nothing.
        const used = this.db.prepare(`SELECT p.snapshot_id FROM source_projections p JOIN source_attempts a USING(projection_id)
          WHERE p.request_id=? AND json_extract(a.data_json,'$.startedAt') IS NOT NULL ORDER BY p.rowid DESC LIMIT 1`)
          .get(parent.requestId) as { snapshot_id: string } | undefined
        if (used && used.snapshot_id !== parent.snapshotId) {
          const latest = this.snapshot(authority, parent.scopeId, used.snapshot_id)
          let cursor = latest
          const seen = new Set<string>()
          while (cursor.snapshotId !== parent.snapshotId) {
            if (!cursor.parentSnapshotId || seen.has(cursor.snapshotId) || cursor.requestId !== parent.requestId)
              sourceContextError('SOURCE_CONFLICT')
            seen.add(cursor.snapshotId)
            cursor = this.snapshot(authority, parent.scopeId, cursor.parentSnapshotId)
          }
          parent = latest
        }
        const records = input.answers.map(answer => {
          const record = this.read(authority, parent.scopeId, [answer.record])[0]!
          const receipt = this.db.prepare("SELECT result_json FROM source_receipts WHERE record_id=? AND scope_id=? AND state='completed'")
            .get(record.recordId, parent.scopeId) as { result_json: string } | undefined
          const result = receipt ? JSON.parse(receipt.result_json) as SourceReceiptResult : undefined
          if (record.origin !== 'member' || record.sender.id !== authority.actorId || record.parts.some(part => part.type === 'attachment') ||
            record.parts.flatMap(part => part.type === 'text' ? [part.text] : []).join('') !== answer.text ||
            result?.handling.kind !== 'question_answer' || result.handling.requestId !== parent.requestId ||
            result.handling.runId !== input.runId || result.handling.batchId !== input.batchId || result.handling.questionId !== answer.questionId)
            sourceContextError('PERMISSION_DENIED')
          return record
        })
        const answers = new Map(input.answers.map(answer => [answer.record.recordId, answer.questionId]))
        const selected = parent.orderedItems.filter(item => item.type !== 'message' || !answers.has(item.recordId))
        snapshot = SourceSnapshotSchema.parse({ ...parent, snapshotId, turnId: input.commandId, parentSnapshotId: parent.snapshotId,
          throughIngestOrdinal: Math.max(parent.throughIngestOrdinal, ...records.map(record => record.ingestOrdinal)),
          orderedItems: [...selected, ...records.map(record => ({ type: 'message' as const, ...ref(record),
            selectionReasons: ['current' as const], parts: record.parts.map(part => ({ partId: part.partId,
              mode: 'tool_result_reference' as const, toolMessageId: answers.get(record.recordId)! })) }))] })
        this.db.prepare('INSERT INTO source_snapshots(snapshot_id,request_id,scope_id,fingerprint,data_json,parent_snapshot_id) VALUES (?,?,?,?,?,?)')
          .run(snapshotId, parent.requestId, parent.scopeId, fingerprint, JSON.stringify(snapshot), parent.snapshotId)
      }
      authority.validate()
      return { snapshot, sourceInput: { kind: 'source_snapshot' as const, requestId: snapshot.requestId, turnId: snapshot.turnId ?? snapshot.requestId,
        scopeId: snapshot.scopeId, snapshotId: snapshot.snapshotId, actorRecord: snapshot.actorRecord!, inputRecords: snapshot.inputRecords } }
    })()
  }
  /** Reconciliation records uncertainty; it never schedules work or calls an executor. */
  recover(): void {
    this.db.transaction(() => {
      this.db.prepare("UPDATE source_receipts SET reason_code='interrupted_before_queue' WHERE state='pending' AND reason_code IS NULL").run()
      for (const row of this.db.prepare("SELECT data_json FROM source_attempts WHERE state='invoking'").all() as JsonRow[]) {
        const attempt = SourceAttemptSchema.parse(JSON.parse(row.data_json))
        const next: SourceAttempt = { ...attempt, state: 'unknown', version: attempt.version + 1, outcomeKnown: false, reasonCode: 'PROCESS_INTERRUPTED' }
        this.db.prepare("UPDATE source_attempts SET state='unknown',data_json=? WHERE attempt_id=?").run(JSON.stringify(next), attempt.attemptId)
      }
      this.db.prepare("UPDATE source_run_messages SET state='unknown' WHERE state='started'").run()
    })()
  }
  saveProjection(authority: SourceAuthority, scopeId: string, value: SourceModelProjection,
    reason: 'initial' | 'tool_continue' | 'question_resume' | 'approval_resume'): SourceModelProjection {
    return this.db.transaction(() => {
      const projection = SourceModelProjectionSchema.parse(value)
      const snapshot = this.snapshot(authority, scopeId, projection.snapshotId)
      if (snapshot.maintenancePurpose ? authority.purpose !== 'maintenance' || projection.toolNames.length > 0 ||
        projection.toolHistoryRefs.length > 0 || projection.executionFactRefs.length > 0 || reason !== 'initial'
        : authority.purpose !== 'execution') sourceContextError('PERMISSION_DENIED')
      const previous = this.db.prepare('SELECT data_json FROM source_projections WHERE projection_id=?').get(projection.projectionId) as JsonRow | undefined
      if (previous) {
        if (canonical(JSON.parse(previous.data_json)) !== canonical(projection)) sourceContextError('SOURCE_CONFLICT')
        return projection
      }
      const steps = this.db.prepare('SELECT model_step_id,step_sequence,MAX(projection_sequence) AS projection_sequence FROM source_projections WHERE request_id=? GROUP BY model_step_id,step_sequence')
        .all(snapshot.requestId) as { model_step_id: string; step_sequence: number; projection_sequence: number }[]
      const step = steps.find(s => s.model_step_id === projection.modelStepId)
      const stepSequence = step?.step_sequence ?? Math.max(0, ...steps.map(s => s.step_sequence)) + 1
      this.db.prepare(`INSERT INTO source_projections(projection_id,model_step_id,snapshot_id,request_id,step_sequence,projection_sequence,reason,prepared_at,data_json)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(projection.projectionId, projection.modelStepId, projection.snapshotId, snapshot.requestId,
          stepSequence, (step?.projection_sequence ?? 0) + 1, reason, this.now(), JSON.stringify(projection))
      authority.validate()
      return projection
    })()
  }
  saveRenderedText(authority: SourceAuthority, scopeId: string, body: string): string {
    this.scope(authority, scopeId, ['execution', 'maintenance'])
    const textId = id('source-text')
    this.db.prepare('INSERT INTO source_rendered_texts(text_id,scope_id,body) VALUES (?,?,?)').run(textId, scopeId, body)
    return textId
  }
  saveDataSnapshot(authority: SourceAuthority, scopeId: string, value: SourceDataRef, body: string): SourceDataRef {
    this.scope(authority, scopeId, ['execution', 'maintenance'])
    const data = SourceDataRefSchema.parse(value)
    const old = this.db.prepare('SELECT data_json,body FROM source_data_snapshots WHERE data_id=? AND scope_id=?')
      .get(data.dataId, scopeId) as { data_json: string; body: string } | undefined
    if (old && (canonical(JSON.parse(old.data_json)) !== canonical(data) || old.body !== body)) sourceContextError('SOURCE_CONFLICT')
    this.db.prepare('INSERT OR IGNORE INTO source_data_snapshots(data_id,scope_id,data_json,body) VALUES (?,?,?,?)')
      .run(data.dataId, scopeId, JSON.stringify(data), body)
    return data
  }
  savePreparationResult(authority: SourceAuthority, scopeId: string, kind: 'budget' | 'transport' | 'response' | 'description', value: object): string {
    this.scope(authority, scopeId, ['execution', 'maintenance'])
    const resultId = id(`source-${kind}`)
    this.db.prepare('INSERT INTO source_preparation_results(result_id,scope_id,kind,data_json) VALUES (?,?,?,?)')
      .run(resultId, scopeId, kind, JSON.stringify(value))
    return resultId
  }
  /** Only a persisted successful observation tool decision can authorize a derived request. */
  deriveReply(authority: SourceAuthority, scopeId: string, observationRequestId: string, anchor: SourceRecordRef) {
    return this.db.transaction(() => {
      const scope = this.scope(authority, scopeId, ['execution'])
      const batch = this.db.prepare('SELECT candidates_json,permission_revision FROM source_observation_batches WHERE request_id=? AND scope_id=?')
        .get(observationRequestId, scopeId) as { candidates_json: string; permission_revision: number } | undefined
      if (!batch || batch.permission_revision !== scope.permissionRevision || !(JSON.parse(batch.candidates_json) as SourceRecordRef[])
        .some(candidate => canonical(candidate) === canonical(anchor))) sourceContextError('PERMISSION_DENIED')
      const row = this.db.prepare('SELECT data_json FROM source_snapshots WHERE request_id=? AND scope_id=? AND parent_snapshot_id IS NULL')
        .get(observationRequestId, scopeId) as JsonRow | undefined
      if (!row) sourceContextError('PERMISSION_DENIED')
      const snapshot = SourceSnapshotSchema.parse(JSON.parse(row.data_json))
      if (!snapshot.actorRecord || this.read(authority, scopeId, [snapshot.actorRecord])[0]?.sender.id !== authority.actorId ||
        !snapshot.orderedItems.some(item => item.type === 'message' && item.recordId === anchor.recordId && item.revision === anchor.revision && item.parts.some(part => part.mode === 'expand')))
        sourceContextError('PERMISSION_DENIED')
      const record = this.read(authority, scopeId, [anchor])[0]!
      const messages = this.completedRunMessages(authority, scopeId, observationRequestId)
      const permitted = messages.some(message => message.body.role === 'assistant' && (message.body.senseCalls ?? []).some(call => {
        if (call.name !== 'qq_participation_decide') return false
        let args: { action?: string; batchId?: string; anchorRecord?: SourceRecordRef }
        try { args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments as typeof args } catch { return false }
        return args?.action === 'reply' && args.batchId === observationRequestId && canonical(args.anchorRecord) === canonical(anchor) &&
          messages.some(result => result.body.role === 'sense' && result.body.id === call.id && result.state === 'completed' && (() => {
            try { return JSON.parse(result.body.content).accepted === true } catch { return false }
          })())
      }))
      if (!permitted || record.origin !== 'member') sourceContextError('PERMISSION_DENIED')
      const receipt = this.db.prepare("SELECT event_id,result_json FROM source_receipts WHERE scope_id=? AND record_id=? AND state='completed'")
        .get(scopeId, anchor.recordId) as { event_id: string; result_json: string } | undefined
      if (!receipt) sourceContextError('PERMISSION_DENIED')
      const handling = (JSON.parse(receipt.result_json) as SourceReceiptResult).handling
      if (handling.kind !== 'background' && !(['queued','merged'].includes(handling.kind) && 'requestId' in handling && handling.requestId === observationRequestId))
        sourceContextError('PERMISSION_DENIED')
      const requestId = `qq-reply-${sourceFingerprint([scopeId, observationRequestId, anchor])}`
      const old = this.db.prepare('SELECT * FROM source_derived_replies WHERE observation_request_id=? OR (scope_id=? AND record_id=? AND record_revision=?)')
        .all(observationRequestId, scopeId, anchor.recordId, anchor.revision) as Array<{ request_id: string; permission_revision: number }>
      if (old.some(value => value.request_id !== requestId || value.permission_revision !== scope.permissionRevision)) sourceContextError('SOURCE_CONFLICT')
      if (!old.length) this.db.prepare('INSERT INTO source_derived_replies VALUES (?,?,?,?,?,?,?)')
        .run(requestId, observationRequestId, scopeId, anchor.recordId, anchor.revision, record.sender.id, scope.permissionRevision)
      authority.validate()
      return { requestId, eventId: receipt.event_id, record }
    })()
  }
  saveToolObservation(authority: SourceAuthority, scopeId: string, runId: string, callId: string, name: string,
    result: { content: string; status?: string; observation?: import('@chery/plugin-api/sense').ObservationEnvelope; truncated?: boolean }): void {
    this.scope(authority, scopeId, ['execution'])
    if (!this.db.prepare('SELECT 1 FROM source_runs WHERE run_id=? AND scope_id=?').get(runId, scopeId)) sourceContextError('PERMISSION_DENIED')
    // Only actual web observations are retained here; arbitrary tool parameters never enter learning.
    if (!['web_fetch','web_search'].includes(name)) return
    const value = { status: result.status ?? 'unknown', observation: result.observation, truncated: result.truncated ?? false }
    const hash = sourceFingerprint(value), old = this.db.prepare('SELECT content_hash FROM source_tool_observations WHERE run_id=? AND call_id=?')
      .get(runId, callId) as { content_hash: string } | undefined
    if (old && old.content_hash !== hash) sourceContextError('SOURCE_CONFLICT')
    if (!old) this.db.prepare('INSERT INTO source_tool_observations VALUES (?,?,?,?,?,?)').run(runId, callId, scopeId, name, hash, JSON.stringify(value))
    authority.validate()
  }
  prepareLearning(authority: SourceAuthority, scopeId: string, input: import('@chery/plugin-api').IngressLearningPrepare): import('@chery/plugin-api').IngressLearningPreparation | null {
    return this.db.transaction(() => {
      const scope = this.scope(authority, scopeId, ['maintenance'])
      SourceIdSchema.parse(input.operationId)
      if (!['automatic','candidate'].includes(input.purpose)) sourceContextError('INVALID_PARAMS')
      if (![input.afterOrdinal,input.afterRun,input.qqConfigRevision].every(value => Number.isSafeInteger(value) && value >= 0) || input.completedRequests.length > 10000) sourceContextError('INVALID_PARAMS')
      const old = this.db.prepare('SELECT input_json FROM source_learning_operations WHERE operation_id=? AND scope_id=?').get(input.operationId, scopeId) as { input_json: string } | undefined
      if (old) {
        const operation=this.learningStatus(authority,scopeId,input.operationId)
        if(operation.purpose!==input.purpose)sourceContextError('SOURCE_CONFLICT')
        return { ...JSON.parse(old.input_json), operation }
      }
      const selected = this.allRecords(scopeId).filter(record => record.ingestOrdinal > input.afterOrdinal).slice(0, 100)
      const records = selected.filter(record => record.receivedAt >= (input.since ?? 0))
      const selectedRuns = this.db.prepare(`SELECT r.rowid AS ordinal,r.* FROM source_runs r
        WHERE r.scope_id=? AND r.request_id IN (SELECT value FROM json_each(?))
          AND EXISTS (SELECT 1 FROM source_snapshots s WHERE s.request_id=r.request_id AND s.scope_id=r.scope_id
            AND s.parent_snapshot_id IS NULL AND json_extract(s.data_json,'$.selectedAt')>=?)
          AND (?='candidate' OR NOT EXISTS (SELECT 1 FROM source_learning_operations l, json_each(l.input_json,'$.runs') registered
            WHERE l.scope_id=r.scope_id AND json_extract(l.data_json,'$.purpose')='automatic'
              AND json_extract(registered.value,'$.runId')=r.run_id))
        ORDER BY r.rowid LIMIT 50`).all(scopeId,JSON.stringify(input.completedRequests),input.since??0,input.purpose) as Array<{ordinal:number;run_id:string;request_id:string}>
      const runs=selectedRuns
      if (!selected.length && !selectedRuns.length) return null
      const evidence: import('@chery/plugin-api').IngressWebEvidence[] = []
      for (const run of runs) for (const row of this.db.prepare("SELECT * FROM source_tool_observations WHERE scope_id=? AND run_id=? AND tool_name='web_fetch'").all(scopeId, run.run_id) as Array<{ call_id: string; data_json: string }>) {
        const snapshotRow = this.db.prepare('SELECT data_json FROM source_snapshots WHERE request_id=? AND scope_id=? AND parent_snapshot_id IS NULL').get(run.request_id, scopeId) as JsonRow | undefined
        if (!snapshotRow || JSON.parse(snapshotRow.data_json).selectedAt < (input.since ?? 0)) continue
        const saved = JSON.parse(row.data_json)
        if (saved.status !== 'ok' || saved.observation?.kind !== 'observation') continue
        let body: any
        try { body = JSON.parse(saved.observation.content) } catch { continue }
        if (body.ok !== true || typeof body.text !== 'string' || !body.text.trim() || typeof body.observedAt !== 'string') continue
        let url: URL
        try { url = new URL(body.url) } catch { continue }
        if (!['https:','http:'].includes(url.protocol) || url.username || url.password) continue
        const contentHash = sourceFingerprint(body.text)
        evidence.push({ evidenceId: contentHash, runId: run.run_id, callId: row.call_id,
          url: url.href, observedAt: body.observedAt, text: body.text, contentHash, truncated: body.truncated === true,
          publicEligible: body.publicEligible === true && !url.search })
      }
      const snapshot = SourceSnapshotSchema.parse({ snapshotId: id('learning-snapshot'), requestId: input.operationId, scopeId, snapshotVersion: 1,
        maintenancePurpose: 'learning', selectionRevision: scope.selectionRevision, throughIngestOrdinal: selected.at(-1)?.ingestOrdinal ?? input.afterOrdinal,
        selectedAt: this.now(), qqConfigRevision: input.qqConfigRevision, ordering: 'time_approximate', inputRecords: [], quoteRelations: [],
        selectionStats: { recentRecordCount: records.length, recentTextCodePoints: 0 },
        orderedItems: records.map(record => ({ type: 'message', ...ref(record), selectionReasons: ['recent'], parts: record.parts.map(part => ({ partId: part.partId, mode: 'expand' })) })) })
      this.db.prepare('INSERT INTO source_snapshots(snapshot_id,request_id,scope_id,fingerprint,data_json) VALUES (?,?,?,?,?)')
        .run(snapshot.snapshotId, input.operationId, scopeId, sourceFingerprint(input), JSON.stringify(snapshot))
      const operation: import('@chery/plugin-api').IngressLearningOperation = { operationId: input.operationId, purpose:input.purpose, scopeId, snapshotId: snapshot.snapshotId, permissionRevision: scope.permissionRevision, version: 1, status: 'pending' }
      const deliveries = (this.db.prepare(`SELECT d.frame_json,f.data_json AS result_json FROM source_deliveries d LEFT JOIN source_delivery_facts f
        ON f.delivery_id=d.delivery_id AND f.revision=(SELECT MAX(revision) FROM source_delivery_facts WHERE delivery_id=d.delivery_id) WHERE d.scope_id=?`).all(scopeId) as Array<{ frame_json: string; result_json?: string }>).map(row => {
        const frame = JSON.parse(row.frame_json)
        return { type: frame.type, text: frame.data.text, requestId: frame.data.requestId, completeReply: frame.data.completeReply,
          status: row.result_json ? JSON.parse(row.result_json).status : 'pending' }
      }).filter(delivery => runs.some(run => run.request_id === delivery.requestId))
      const prepared: import('@chery/plugin-api').IngressLearningPreparation = { operation, records, evidence, deliveries,
        throughOrdinal: snapshot.throughIngestOrdinal, throughRun: Math.max(input.afterRun,selectedRuns.at(-1)?.ordinal??0),
        runs: runs.map(run => ({ requestId: run.request_id, runId: run.run_id, messages: this.runMessages(authority, scopeId, run.request_id)
          .map(message => ({ state: message.state, body: { role: message.body.role, content: message.body.content } })) })) }
      this.db.prepare('INSERT INTO source_learning_operations VALUES (?,?,?,?)').run(input.operationId, scopeId, JSON.stringify(operation), JSON.stringify(prepared))
      authority.validate(); return prepared
    })()
  }
  learningStatus(authority: SourceAuthority, scopeId: string, operationId: string): import('@chery/plugin-api').IngressLearningOperation {
    const scope = this.scope(authority, scopeId, ['maintenance'])
    const row = this.db.prepare('SELECT data_json,input_json FROM source_learning_operations WHERE operation_id=? AND scope_id=?').get(operationId, scopeId) as (JsonRow & { input_json: string }) | undefined
    if (!row) sourceContextError('SOURCE_NOT_FOUND')
    const operation = JSON.parse(row.data_json)
    if (operation.permissionRevision !== scope.permissionRevision) sourceContextError('PERMISSION_DENIED')
    // Summary selection changes deliberately do not invalidate a learning operation.
    const snapshot=this.snapshot(authority, scopeId, operation.snapshotId)
    this.read(authority,scopeId,snapshot.orderedItems.flatMap(item=>item.type==='message'?[{recordId:item.recordId,revision:item.revision}]:[]))
    const prepared = JSON.parse(row.input_json) as import('@chery/plugin-api').IngressLearningPreparation
    for (const run of prepared.runs) if (!this.db.prepare('SELECT 1 FROM source_runs WHERE request_id=? AND run_id=? AND scope_id=?')
      .get(run.requestId, run.runId, scopeId)) sourceContextError('SOURCE_NOT_FOUND')
    for (const evidence of prepared.evidence) {
      const saved = this.db.prepare("SELECT data_json FROM source_tool_observations WHERE scope_id=? AND run_id=? AND call_id=? AND tool_name='web_fetch'")
        .get(scopeId,evidence.runId,evidence.callId) as JsonRow | undefined
      if (!saved) sourceContextError('SOURCE_NOT_FOUND')
      const result = JSON.parse(saved.data_json)
      if (result.status !== 'ok' || result.observation?.kind !== 'observation') sourceContextError('SOURCE_CONFLICT')
      const body = JSON.parse(result.observation.content)
      if (body.ok !== true || sourceFingerprint(body.text) !== evidence.contentHash || body.url !== evidence.url || body.observedAt !== evidence.observedAt)
        sourceContextError('SOURCE_CONFLICT')
    }
    return operation
  }
  updateLearning(authority: SourceAuthority, scopeId: string, input: import('@chery/plugin-api').IngressLearningUpdate): import('@chery/plugin-api').IngressLearningOperation {
    return this.db.transaction(()=>{
    const old = this.learningStatus(authority, scopeId, input.operationId)
    if (old.version !== input.expectedVersion || ['completed','cancelled'].includes(old.status)) sourceContextError('REVISION_CONFLICT')
    const next = { ...old, status: input.status, reason: input.reason, localReceipt: input.localReceipt ?? old.localReceipt,
      publicReceipt: input.publicReceipt ?? old.publicReceipt, version: old.version + 1 }
    this.db.prepare('UPDATE source_learning_operations SET data_json=? WHERE operation_id=?').run(JSON.stringify(next), input.operationId)
    authority.validate(); return next
    })()
  }
  ensureRun(authority: SourceAuthority, scopeId: string, requestId: string, runId: string): string {
    return this.db.transaction(() => {
      const scope = this.scope(authority, scopeId, ['execution'])
      SourceIdSchema.parse(runId)
      const row = this.db.prepare('SELECT data_json FROM source_snapshots WHERE request_id=? AND scope_id=? AND parent_snapshot_id IS NULL')
        .get(requestId, scopeId) as JsonRow | undefined
      if (!row) sourceContextError('PERMISSION_DENIED')
      const snapshot = SourceSnapshotSchema.parse(JSON.parse(row.data_json))
      if (!snapshot.actorRecord || this.read(authority, scopeId, [snapshot.actorRecord])[0]?.sender.id !== authority.actorId ||
        snapshot.inputRecords.some(reference => !this.db.prepare(`SELECT 1 FROM source_receipts WHERE scope_id=? AND record_id=?
          AND state='completed' AND json_extract(result_json,'$.handling.requestId')=?
           AND json_extract(result_json,'$.handling.kind') IN ('queued','merged')`).get(scopeId, reference.recordId, requestId) &&
           !this.db.prepare(`SELECT 1 FROM source_derived_replies WHERE request_id=? AND scope_id=? AND record_id=?
             AND record_revision=? AND actor_id=? AND permission_revision=?`).get(requestId, scopeId, reference.recordId, reference.revision, authority.actorId, scope.permissionRevision)))
        sourceContextError('PERMISSION_DENIED')
      const old = this.db.prepare('SELECT request_id,run_id,scope_id FROM source_runs WHERE request_id=? OR run_id=?')
        .all(requestId, runId) as Array<{ request_id: string; run_id: string; scope_id: string }>
      if (old.some(saved => saved.request_id !== requestId || saved.run_id !== runId || saved.scope_id !== scopeId)) sourceContextError('PERMISSION_DENIED')
      if (!old.length) this.db.prepare('INSERT INTO source_runs(request_id,run_id,scope_id) VALUES (?,?,?)').run(requestId, runId, scopeId)
      authority.validate()
      return runId
    })()
  }
  saveRunMessage(authority: SourceAuthority, scopeId: string, runId: string, body: LLMResponse,
    state: 'planned' | 'started' | 'completed'): SourceToolMessageRef {
    return this.db.transaction((): SourceToolMessageRef => {
      this.scope(authority, scopeId, ['execution'])
      if (!this.db.prepare('SELECT 1 FROM source_runs WHERE run_id=? AND scope_id=?').get(runId, scopeId) ||
        !['assistant', 'sense', 'role'].includes(body.role)) sourceContextError('PERMISSION_DENIED')
      // Do not retain transient source handles or binary attachments in execution history.
      const value: LLMResponse = { id: body.id, role: body.role, content: body.content,
        thinking: body.thinking, thinkingBlocks: body.thinkingBlocks, senseCalls: body.senseCalls,
        providerContinuation: body.providerContinuation, serverToolCalls: body.serverToolCalls,
        createdAt: body.createdAt, updateAt: body.updateAt }
      const hash = sourceFingerprint(value)
      const old = this.db.prepare('SELECT sequence,state,body_hash FROM source_run_messages WHERE run_id=? AND message_id=?').get(runId, body.id) as
        { sequence: number; state: string; body_hash: string } | undefined
      if (old && (old.state === 'completed' || old.state === 'unknown') && (old.body_hash !== hash || old.state !== state)) sourceContextError('SOURCE_CONFLICT')
      if (old?.state === 'started' && state === 'planned') sourceContextError('SOURCE_CONFLICT')
      const sequence = old?.sequence ?? (this.db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS n FROM source_run_messages WHERE run_id=?').get(runId) as { n: number }).n
      this.db.prepare(`INSERT INTO source_run_messages(run_id,message_id,scope_id,sequence,state,body_hash,data_json) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(run_id,message_id) DO UPDATE SET state=excluded.state,body_hash=excluded.body_hash,data_json=excluded.data_json`)
        .run(runId, body.id, scopeId, sequence, state, hash, JSON.stringify(value))
      authority.validate()
      return { runId, messageId: body.id, sequence, kind: body.role === 'sense' ? 'tool_result' : body.role === 'role' ? 'role_return' : 'assistant_call', bodyHash: hash }
    })()
  }
  runMessages(authority: SourceAuthority, scopeId: string, requestId: string): Array<{ ref: SourceToolMessageRef; state: string; body: LLMResponse }> {
    this.scope(authority, scopeId, ['execution', 'management', 'maintenance'])
    const rows = this.db.prepare(`SELECT m.* FROM source_run_messages m JOIN source_runs r ON r.run_id=m.run_id AND r.scope_id=m.scope_id
      WHERE r.request_id=? AND m.scope_id=? ORDER BY m.sequence`).all(requestId, scopeId) as
      Array<{ run_id: string; message_id: string; sequence: number; state: string; body_hash: string; data_json: string }>
    return rows.map(row => {
      const body = JSON.parse(row.data_json) as LLMResponse
      return { state: row.state, body, ref: { runId: row.run_id, messageId: row.message_id, sequence: row.sequence,
        kind: body.role === 'sense' ? 'tool_result' : body.role === 'role' ? 'role_return' : 'assistant_call', bodyHash: row.body_hash } }
    })
  }
  completedRunMessages(authority: SourceAuthority, scopeId: string, requestId: string) {
    const messages = this.runMessages(authority, scopeId, requestId)
    const calls = new Set<string>(), results = new Set<string>()
    for (const message of messages) {
      if (message.state !== 'completed') sourceContextError('SOURCE_TOOL_OUTCOME_UNKNOWN')
      if (message.body.role === 'assistant') for (const call of message.body.senseCalls ?? []) {
        if (calls.has(call.id)) sourceContextError('SOURCE_TOOL_OUTCOME_UNKNOWN')
        calls.add(call.id)
      }
      if (message.body.role === 'sense') {
        if (!calls.has(message.body.id) || results.has(message.body.id)) sourceContextError('SOURCE_TOOL_OUTCOME_UNKNOWN')
        results.add(message.body.id)
      }
    }
    if (calls.size !== results.size) sourceContextError('SOURCE_TOOL_OUTCOME_UNKNOWN')
    return messages
  }
  prepareAttempt(authority: SourceAuthority, scopeId: string, projectionId: string, attemptId: string): SourceAttempt {
    return this.db.transaction(() => {
      this.scope(authority, scopeId, ['execution', 'maintenance'])
      const projection = this.db.prepare(`SELECT s.data_json FROM source_projections p JOIN source_snapshots s USING(snapshot_id)
        WHERE p.projection_id=? AND s.scope_id=?`).get(projectionId, scopeId) as JsonRow | undefined
      if (!projection) sourceContextError('PERMISSION_DENIED')
      if (!!SourceSnapshotSchema.parse(JSON.parse(projection.data_json)).maintenancePurpose !== (authority.purpose === 'maintenance')) sourceContextError('PERMISSION_DENIED')
      const row = this.db.prepare('SELECT data_json FROM source_attempts WHERE projection_id=? OR attempt_id=?').get(projectionId, attemptId) as JsonRow | undefined
      if (row) {
        const saved = SourceAttemptSchema.parse(JSON.parse(row.data_json))
        if (saved.attemptId !== attemptId || saved.projectionId !== projectionId) sourceContextError('SOURCE_CONFLICT')
        return saved
      }
      const count = this.db.prepare(`SELECT COUNT(*) AS n FROM source_attempts a JOIN source_projections p USING(projection_id)
        WHERE p.model_step_id=(SELECT model_step_id FROM source_projections WHERE projection_id=?)`).get(projectionId) as { n: number }
      const attempt = SourceAttemptSchema.parse({ attemptId, projectionId, attemptSequence: count.n + 1, state: 'prepared', version: 1, outcomeKnown: true })
      this.db.prepare('INSERT INTO source_attempts(attempt_id,projection_id,state,data_json) VALUES (?,?,?,?)')
        .run(attempt.attemptId, projectionId, attempt.state, JSON.stringify(attempt))
      authority.validate()
      return attempt
    })()
  }
  private attempt(authority: SourceAuthority, scopeId: string, attemptId: string): SourceAttempt {
    this.scope(authority, scopeId, ['execution', 'maintenance', 'management'])
    const row = this.db.prepare(`SELECT a.data_json,s.data_json AS snapshot_json FROM source_attempts a JOIN source_projections p USING(projection_id)
      JOIN source_snapshots s USING(snapshot_id) WHERE a.attempt_id=? AND s.scope_id=?`).get(attemptId, scopeId) as (JsonRow & { snapshot_json: string }) | undefined
    if (!row) sourceContextError('PERMISSION_DENIED')
    if (authority.purpose !== 'management' && !!SourceSnapshotSchema.parse(JSON.parse(row.snapshot_json)).maintenancePurpose !== (authority.purpose === 'maintenance')) sourceContextError('PERMISSION_DENIED')
    return SourceAttemptSchema.parse(JSON.parse(row.data_json))
  }
  invokeAttempt(authority: SourceAuthority, scopeId: string, attemptId: string, turnId: string, commit?: () => void): { attempt: SourceAttempt; turnOrdinal: number } {
    return this.db.transaction(() => {
      this.check(authority, ['execution'])
      const previous = this.attempt(authority, scopeId, attemptId)
      if (previous.state !== 'prepared') sourceContextError('SOURCE_CONFLICT')
      if (!turnId || turnId.length > 256) sourceContextError('INVALID_PARAMS')
      const projection = this.db.prepare('SELECT snapshot_id FROM source_projections WHERE projection_id=?')
        .get(previous.projectionId) as { snapshot_id: string }
      this.activateCapacitySummary(authority, scopeId, projection.snapshot_id)
      const adopted = this.db.prepare('SELECT ordinal FROM source_turns WHERE scope_id=? AND turn_id=?').get(scopeId, turnId) as { ordinal: number } | undefined
      const max = this.db.prepare('SELECT COALESCE(MAX(ordinal),0) AS n FROM source_turns WHERE scope_id=?').get(scopeId) as { n: number }
      const turnOrdinal = adopted?.ordinal ?? max.n + 1
      if (!adopted) this.db.prepare('INSERT INTO source_turns(scope_id,turn_id,ordinal) VALUES (?,?,?)').run(scopeId, turnId, turnOrdinal)
      const attempt = SourceAttemptSchema.parse({ ...previous, state: 'invoking', version: previous.version + 1, startedAt: this.now(), outcomeKnown: false })
      this.db.prepare('UPDATE source_attempts SET state=?,data_json=? WHERE attempt_id=?').run(attempt.state, JSON.stringify(attempt), attemptId)
      commit?.()
      authority.validate()
      return { attempt, turnOrdinal }
    })()
  }
  /** Maintenance calls have no member, execution run or user-turn adoption. */
  invokeMaintenanceAttempt(authority: SourceAuthority, scopeId: string, attemptId: string): SourceAttempt {
    return this.db.transaction(() => {
      this.scope(authority, scopeId, ['maintenance'])
      const previous = this.attempt(authority, scopeId, attemptId)
      const row = this.db.prepare(`SELECT s.data_json FROM source_projections p JOIN source_snapshots s USING(snapshot_id)
        WHERE p.projection_id=? AND s.scope_id=?`).get(previous.projectionId, scopeId) as JsonRow | undefined
      if (!row) sourceContextError('PERMISSION_DENIED')
      const snapshot = SourceSnapshotSchema.parse(JSON.parse(row.data_json))
      if (!snapshot.maintenancePurpose) sourceContextError('PERMISSION_DENIED')
      const operation = snapshot.maintenancePurpose === 'learning'
        ? this.learningStatus(authority, scopeId, snapshot.requestId) : this.summaryStatus(authority, scopeId, snapshot.requestId)
      if (!['pending', 'running'].includes(operation.status) || previous.state !== 'prepared') sourceContextError('SOURCE_CONFLICT')
      const next = SourceAttemptSchema.parse({ ...previous, state: 'invoking', startedAt: this.now(), version: previous.version + 1, outcomeKnown: false })
      this.db.prepare('UPDATE source_attempts SET state=?,data_json=? WHERE attempt_id=?').run(next.state, JSON.stringify(next), attemptId)
      authority.validate()
      return next
    })()
  }
  finishAttempt(authority: SourceAuthority, scopeId: string, attemptId: string, expectedVersion: number,
    result: Pick<SourceAttempt, 'state' | 'outcomeKnown' | 'reasonCode' | 'responseRef' | 'usage'>): SourceAttempt {
    return this.db.transaction(() => {
      this.check(authority, ['execution', 'maintenance'])
      const previous = this.attempt(authority, scopeId, attemptId)
      if (!['responded', 'failed', 'unknown', 'cancelled'].includes(result.state)) sourceContextError('INVALID_PARAMS')
      const terminal = previous.state === 'responded' || previous.state === 'failed'
      const fields = (v: typeof result) => ({ state: v.state, outcomeKnown: v.outcomeKnown,
        reasonCode: v.reasonCode, responseRef: v.responseRef, usage: v.usage })
      if (canonical(fields(previous)) === canonical(fields(result))) return previous
      if (terminal) sourceContextError('SOURCE_CONFLICT')
      if (previous.version !== expectedVersion) sourceContextError('REVISION_CONFLICT')
      if (previous.state === 'prepared' && !['failed', 'cancelled'].includes(result.state)) sourceContextError('SOURCE_CONFLICT')
      if (result.state === 'responded' && (!result.outcomeKnown || !result.responseRef)) sourceContextError('INVALID_PARAMS')
      if (result.state === 'failed' && !result.outcomeKnown) sourceContextError('INVALID_PARAMS')
      const attempt = SourceAttemptSchema.parse({ ...previous, ...result, version: previous.version + 1, finishedAt: this.now() })
      this.db.prepare('UPDATE source_attempts SET state=?,data_json=? WHERE attempt_id=?').run(attempt.state, JSON.stringify(attempt), attemptId)
      authority.validate()
      return attempt
    })()
  }
  /** A bounded completion callback records this attempt even after execution access is revoked.
   * It cannot read source text, grant access, adopt inputs, or start another call. */
  attemptCompletion(authority: SourceAuthority, scopeId: string, attemptId: string):
    (status: 'completed' | 'failed' | 'cancelled', responseSeen: boolean, usage: SourceAttempt['usage']) => SourceAttempt {
    this.scope(authority, scopeId, ['execution', 'maintenance'])
    this.attempt(authority, scopeId, attemptId)
    return (status, responseSeen, usage) => this.db.transaction(() => {
      const row = this.db.prepare('SELECT data_json FROM source_attempts WHERE attempt_id=?').get(attemptId) as JsonRow | undefined
      if (!row) sourceContextError('NOT_FOUND')
      const previous = SourceAttemptSchema.parse(JSON.parse(row.data_json))
      if (!['prepared', 'invoking', 'unknown', 'cancelled'].includes(previous.state)) return previous
      const started = previous.startedAt !== undefined
      const state = status === 'completed' && started && responseSeen ? 'responded'
        : status === 'cancelled' ? 'cancelled' : started ? 'unknown' : 'failed'
      if (['unknown', 'cancelled'].includes(previous.state) && state !== 'responded') return previous
      const responseRef = state === 'responded' ? id('source-response') : undefined
      if (responseRef) this.db.prepare('INSERT INTO source_preparation_results(result_id,scope_id,kind,data_json) VALUES (?,?,?,?)')
        .run(responseRef, scopeId, 'response', JSON.stringify({ received: true, usage }))
      const result = SourceAttemptSchema.parse({ ...previous, state, version: previous.version + 1, finishedAt: this.now(),
        outcomeKnown: state === 'responded' || !started, ...(responseRef ? { responseRef } : {}), ...(usage ? { usage } : {}) })
      this.db.prepare('UPDATE source_attempts SET state=?,data_json=? WHERE attempt_id=?').run(result.state, JSON.stringify(result), attemptId)
      return result
    })()
  }
  prepareMaintenanceSummary(authority: SourceAuthority, scopeId: string, input: {
    operationId: string; purpose: 'capacity' | 'discussion'; qqConfigRevision: number; parentSnapshotId?: string
  }): SourceSummaryPreparation {
    SourceIdSchema.parse(input.operationId)
    if (!['capacity', 'discussion'].includes(input.purpose) || !Number.isSafeInteger(input.qqConfigRevision) || input.qqConfigRevision < 0)
      sourceContextError('INVALID_PARAMS')
    return this.db.transaction(() => {
      const scope = this.scope(authority, scopeId, ['maintenance'])
      const saved = this.db.prepare(`SELECT i.data_json FROM source_summary_inputs i JOIN source_summary_operations o USING(operation_id)
        WHERE o.operation_id=? AND o.scope_id=?`).get(input.operationId, scopeId) as JsonRow | undefined
      if (saved) {
        const prepared = JSON.parse(saved.data_json) as SourceSummaryPreparation
        if (prepared.operation.purpose !== input.purpose || prepared.snapshot.parentSnapshotId !== input.parentSnapshotId) sourceContextError('SOURCE_CONFLICT')
        return { ...prepared, operation: this.summaryStatus(authority, scopeId, input.operationId) }
      }
      const baseSummary = this.summary(authority, scopeId), covered = new Map((baseSummary?.replacement ?? []).map(r => [r.record.recordId, new Set(r.partIds)]))
      if (input.purpose === 'capacity' && !input.parentSnapshotId || input.purpose === 'discussion' && input.parentSnapshotId) sourceContextError('INVALID_PARAMS')
      const parent = input.parentSnapshotId ? this.snapshot(authority, scopeId, input.parentSnapshotId) : undefined
      if (parent?.maintenancePurpose) sourceContextError('PERMISSION_DENIED')
      if (parent && parent.orderedItems.find(item => item.type === 'summary')?.summaryId !== baseSummary?.summaryId) sourceContextError('SUMMARY_CONFLICT')
      const eligible = parent?.orderedItems.filter(item => item.type === 'message' && !item.selectionReasons.includes('current') &&
        !item.selectionReasons.includes('explicit_quote'))
      const candidates = parent ? this.read(authority, scopeId, eligible!.flatMap(item => item.type === 'message' ? [{ recordId: item.recordId, revision: item.revision }] : [])) : this.allRecords(scopeId)
      const all = candidates.sort((a, b) => (a.platformSentAt ?? a.deliveryConfirmedAt ?? a.receivedAt) -
        (b.platformSentAt ?? b.deliveryConfirmedAt ?? b.receivedAt) || a.ingestOrdinal - b.ingestOrdinal || a.recordId.localeCompare(b.recordId))
      const records = all.filter(record => !record.parts.length || record.parts.some(part => !covered.get(record.recordId)?.has(part.partId)))
      const attachments = records.flatMap(record => record.parts.flatMap(part => part.type === 'attachment' ? [this.attachment(authority, scopeId, part.attachmentId)] : []))
      const orderedItems: SourceSnapshotItem[] = [
        ...(baseSummary ? [{ type: 'summary' as const, summaryId: baseSummary.summaryId, revision: baseSummary.revision }] : []),
        ...records.map(record => ({ type: 'message' as const, ...ref(record), selectionReasons: ['recent' as const],
          parts: record.parts.map(part => covered.get(record.recordId)?.has(part.partId) && baseSummary
            ? { partId: part.partId, mode: 'summary_reference' as const, summaryId: baseSummary.summaryId }
            : { partId: part.partId, mode: 'expand' as const }) })),
      ]
      const snapshot = SourceSnapshotSchema.parse({ snapshotId: id('maintenance-snapshot'), requestId: input.operationId, scopeId,
        maintenancePurpose: input.purpose, snapshotVersion: 1, selectionRevision: scope.selectionRevision,
        throughIngestOrdinal: parent?.throughIngestOrdinal ?? all.reduce((n, record) => Math.max(n, record.ingestOrdinal), 0), selectedAt: parent?.selectedAt ?? this.now(),
        ...(parent ? { parentSnapshotId: parent.snapshotId } : {}),
        qqConfigRevision: input.qqConfigRevision, ordering: 'time_approximate', inputRecords: [], orderedItems, quoteRelations: [],
        selectionStats: { recentRecordCount: records.length, recentTextCodePoints: 0 } })
      this.db.prepare('INSERT INTO source_snapshots(snapshot_id,request_id,scope_id,fingerprint,data_json) VALUES (?,?,?,?,?)')
        .run(snapshot.snapshotId, input.operationId, scopeId, sourceFingerprint(input), JSON.stringify(snapshot))
      const evidence: SourceSummaryEvidence[] = records.map(record => ({ record: ref(record),
        textPartIds: record.parts.filter(part => part.type === 'text' && !covered.get(record.recordId)?.has(part.partId)).map(part => part.partId),
        attachments: attachments.filter(file => file.source.recordId === record.recordId).map(file => ({ partId: file.source.partId,
          attachmentVersion: file.version, representation: 'metadata_only' as const })) }))
      const operation = this.prepareSummary(authority, scopeId, { operationId: input.operationId, snapshotId: snapshot.snapshotId,
        purpose: input.purpose, baseSummaryId: baseSummary?.summaryId, evidence })
      const rows = this.db.prepare(`SELECT d.*,f.data_json AS result_json,f.revision AS fact_revision FROM source_deliveries d
        LEFT JOIN source_delivery_facts f ON f.delivery_id=d.delivery_id AND f.revision=(SELECT MAX(revision) FROM source_delivery_facts WHERE delivery_id=d.delivery_id)
        WHERE d.scope_id=? ORDER BY d.created_at,d.delivery_id`).all(scopeId) as Array<{ delivery_id: string; record_id: string | null; purpose: string; kind: string; frame_json: string; result_json: string | null; fact_revision: number | null }>
      const toolObservations=(this.db.prepare(`SELECT t.run_id,t.call_id,t.tool_name,t.data_json FROM source_tool_observations t JOIN source_runs r ON r.run_id=t.run_id AND r.scope_id=t.scope_id
        JOIN source_snapshots s ON s.request_id=r.request_id AND s.scope_id=r.scope_id AND s.parent_snapshot_id IS NULL
        WHERE t.scope_id=? AND json_extract(s.data_json,'$.selectedAt')<=?`).all(scopeId,snapshot.selectedAt) as Array<{run_id:string;call_id:string;tool_name:string;data_json:string}>)
        .map(row=>({runId:row.run_id,callId:row.call_id,toolName:row.tool_name,result:JSON.parse(row.data_json)}))
      const prepared: SourceSummaryPreparation = { operation, snapshot, records, attachments, toolObservations, ...(baseSummary ? { baseSummary } : {}),
        deliveries: rows.map(row => ({ deliveryId: row.delivery_id, purpose: row.purpose, kind: row.kind, frame: JSON.parse(row.frame_json),
          ...(row.record_id ? { source: ref(this.rawRecord(row.record_id)) } : {}),
          ...(row.result_json ? { result: JSON.parse(row.result_json) } : {}), revision: row.fact_revision ?? 0 })) }
      this.db.prepare('INSERT INTO source_summary_inputs VALUES (?,?)').run(input.operationId, JSON.stringify(prepared))
      authority.validate()
      return prepared
    })()
  }
  /** A capacity result replaces only proven old text in the original fixed selection. */
  capacitySnapshot(authority: SourceAuthority, scopeId: string, parentSnapshotId: string, operationId: string): SourceSnapshot {
    return this.db.transaction(() => {
      this.scope(authority, scopeId, ['execution'])
      const parent = this.snapshot(authority, scopeId, parentSnapshotId)
      if (parent.maintenancePurpose || !parent.actorRecord || this.read(authority, scopeId, [parent.actorRecord])[0]?.sender.id !== authority.actorId)
        sourceContextError('PERMISSION_DENIED')
      const maintenance = this.maintenanceAuthority(authority, scopeId)
      const operation = this.summaryStatus(maintenance, scopeId, operationId)
      const prepared = this.snapshot(maintenance, scopeId, operation.snapshotId)
      const summary = operation.summaryId ? this.summary(maintenance, scopeId, operation.summaryId) : undefined
      if (!['running', 'completed'].includes(operation.status) || operation.phase !== 'commit' || operation.purpose !== 'capacity' ||
        prepared.parentSnapshotId !== parentSnapshotId || !summary)
        sourceContextError('SUMMARY_CONFLICT')
      const snapshotId = `capacity-snapshot-${sourceFingerprint([parentSnapshotId, operationId])}`
      const saved = this.db.prepare('SELECT data_json FROM source_snapshots WHERE snapshot_id=?').get(snapshotId) as JsonRow | undefined
      if (saved) return SourceSnapshotSchema.parse(JSON.parse(saved.data_json))
      const coverage = new Map(summary.replacement.map(item => [canonical(item.record), new Set(item.partIds)]))
      let replaced = 0
      const orderedItems: SourceSnapshotItem[] = [{ type: 'summary', summaryId: summary.summaryId, revision: summary.revision }]
      for (const item of parent.orderedItems) {
        if (item.type === 'summary') continue
        if (item.type !== 'message' || item.selectionReasons.includes('current') || item.selectionReasons.includes('explicit_quote')) {
          orderedItems.push(item); continue
        }
        const parts = coverage.get(canonical({ recordId: item.recordId, revision: item.revision }))
        orderedItems.push({ ...item, parts: item.parts.map(part => {
          if (part.mode !== 'tool_result_reference' && parts?.has(part.partId)) {
            if (part.mode === 'expand') replaced++
            return { partId: part.partId, mode: 'summary_reference' as const, summaryId: summary.summaryId }
          }
          return part
        }) })
      }
      if (!replaced) sourceContextError('SUMMARY_BUDGET_FAILED')
      const child = SourceSnapshotSchema.parse({ ...parent, snapshotId, parentSnapshotId, orderedItems })
      this.db.prepare('INSERT INTO source_snapshots(snapshot_id,request_id,scope_id,fingerprint,data_json,parent_snapshot_id) VALUES (?,?,?,?,?,?)')
        .run(snapshotId, parent.requestId, scopeId, sourceFingerprint([parentSnapshotId, operationId]), JSON.stringify(child), parentSnapshotId)
      authority.validate()
      return child
    })()
  }
  /** Called inside model admission, after the final budget and projection checks. */
  private activateCapacitySummary(authority: SourceAuthority, scopeId: string, snapshotId: string): void {
    const snapshot = this.snapshot(authority, scopeId, snapshotId)
    const item = snapshot.orderedItems.find(item => item.type === 'summary')
    if (!item || item.type !== 'summary') return
    const summary = this.summary(authority, scopeId, item.summaryId)
    if (!summary || summary.purpose !== 'capacity') return
    const maintenance = this.maintenanceAuthority(authority, scopeId)
    const operation = this.summaryStatus(maintenance, scopeId, summary.operationId)
    if (operation.status === 'completed') return
    const scope = this.scope(authority, scopeId, ['execution'])
    if (operation.status !== 'running' || operation.phase !== 'commit' || operation.summaryId !== summary.summaryId ||
      operation.permissionRevision !== scope.permissionRevision || operation.baseSelectionRevision !== scope.selectionRevision ||
      this.summary(authority, scopeId)?.summaryId !== operation.baseSummaryId) sourceContextError('SUMMARY_CONFLICT')
    const prepared = this.snapshot(maintenance, scopeId, operation.snapshotId)
    if (prepared.parentSnapshotId !== snapshot.parentSnapshotId ||
      snapshot.snapshotId !== `capacity-snapshot-${sourceFingerprint([snapshot.parentSnapshotId, operation.operationId])}`)
      sourceContextError('SUMMARY_CONFLICT')
    this.saveScope({ ...scope, selectionRevision: scope.selectionRevision + 1 })
    this.db.prepare('UPDATE source_scopes SET active_summary_id=? WHERE scope_id=?').run(summary.summaryId, scopeId)
    this.db.prepare('UPDATE source_summary_operations SET data_json=? WHERE operation_id=?')
      .run(JSON.stringify({ ...operation, status: 'completed', version: operation.version + 1 }), operation.operationId)
  }
  prepareSummary(authority: SourceAuthority, scopeId: string, input: {
    operationId: string; snapshotId: string; purpose: 'capacity' | 'discussion'; baseSummaryId?: string; evidence: SourceSummaryEvidence[]
  }): SourceSummaryOperation {
    return this.db.transaction(() => {
      const scope = this.scope(authority, scopeId, ['maintenance'])
      const snapshot = this.snapshot(authority, scopeId, input.snapshotId)
      const fingerprint = sourceFingerprint(input)
      const saved = this.db.prepare('SELECT fingerprint,data_json FROM source_summary_operations WHERE operation_id=?')
        .get(input.operationId) as (JsonRow & { fingerprint: string }) | undefined
      if (saved) {
        if (saved.fingerprint !== fingerprint) sourceContextError('SOURCE_CONFLICT')
        const operation = JSON.parse(saved.data_json) as SourceSummaryOperation
        if (operation.scopeId !== scopeId) sourceContextError('PERMISSION_DENIED')
        return operation
      }
      const active = this.summary(authority, scopeId)
      if (active?.summaryId !== input.baseSummaryId) sourceContextError('SUMMARY_CONFLICT')
      if (new Set(input.evidence.map(e => e.record.recordId)).size !== input.evidence.length) sourceContextError('INVALID_PARAMS')
      for (const value of input.evidence) {
        const evidence = SourceSummaryEvidenceSchema.parse(value)
        const item = snapshot.orderedItems.find(i => i.type === 'message' && i.recordId === evidence.record.recordId && i.revision === evidence.record.revision)
        if (!item || item.type !== 'message') sourceContextError('PERMISSION_DENIED')
        const record = this.read(authority, scopeId, [evidence.record])[0]!
        for (const partId of evidence.textPartIds) if (!record.parts.some(p => p.partId === partId && p.type === 'text') ||
          !item.parts.some(p => p.partId === partId && p.mode === 'expand')) sourceContextError('SUMMARY_CONFLICT')
        for (const file of evidence.attachments) {
          const part = record.parts.find(p => p.partId === file.partId && p.type === 'attachment')
          if (!part || part.type !== 'attachment') sourceContextError('SUMMARY_CONFLICT')
          this.attachment(authority, scopeId, part.attachmentId, file.attachmentVersion)
          // Rich representations require a saved, final projection of this exact maintenance input.
          if (file.representation !== 'metadata_only') {
            const projection = file.evidenceRef ? this.db.prepare(`SELECT p.data_json FROM source_projections p JOIN source_attempts a USING(projection_id)
              WHERE p.projection_id=? AND p.snapshot_id=? AND a.state='responded'`)
              .get(file.evidenceRef, input.snapshotId) as JsonRow | undefined : undefined
            if (!projection) sourceContextError('SUMMARY_CONFLICT')
            if (!snapshot.maintenancePurpose || snapshot.maintenancePurpose !== input.purpose) sourceContextError('SUMMARY_CONFLICT')
            const provided = SourceModelProjectionSchema.parse(JSON.parse(projection.data_json)).fileInputs.find(p =>
              p.source.recordId === record.recordId && p.source.partId === part.partId && p.source.revision === record.revision &&
              p.attachmentVersion === file.attachmentVersion && p.representation === file.representation)
            if (!provided || (provided.representation === 'extracted_text' && canonical(provided.range) !== canonical(file.range))) sourceContextError('SUMMARY_CONFLICT')
          }
        }
      }
      const operation: SourceSummaryOperation = { ...input, scopeId, baseSelectionRevision: scope.selectionRevision,
        permissionRevision: scope.permissionRevision, status: 'pending', phase: 'history', version: 1 }
      this.db.prepare('INSERT INTO source_summary_operations(operation_id,scope_id,fingerprint,data_json) VALUES (?,?,?,?)')
        .run(input.operationId, scopeId, fingerprint, JSON.stringify(operation))
      this.db.prepare(`INSERT OR IGNORE INTO source_summary_request_links(request_id,operation_id)
        SELECT m.request_id,? FROM source_management_requests m JOIN source_receipts r ON r.scope_id=m.scope_id
          AND json_extract(r.result_json,'$.handling.requestId')=m.request_id
        WHERE m.scope_id=? AND r.record_id IN (SELECT json_extract(value,'$.record.recordId') FROM json_each(?))`)
        .run(input.operationId,scopeId,JSON.stringify(input.evidence))
      authority.validate()
      return operation
    })()
  }
  summaryStatus(authority: SourceAuthority, scopeId: string, operationId: string): SourceSummaryOperation {
    this.scope(authority, scopeId, ['maintenance', 'management'])
    const row = this.db.prepare('SELECT data_json FROM source_summary_operations WHERE operation_id=? AND scope_id=?').get(operationId, scopeId) as JsonRow | undefined
    if (!row) sourceContextError('NOT_FOUND')
    return JSON.parse(row.data_json) as SourceSummaryOperation
  }
  updateSummaryProgress(authority: SourceAuthority, scopeId: string, input: {
    operationId: string; expectedVersion: number; status: 'running' | 'failed' | 'cancelled'; phase: SourceSummaryOperation['phase']; reasonCode?: string
  }): SourceSummaryOperation {
    return this.db.transaction(() => {
      this.scope(authority, scopeId, ['maintenance'])
      const previous = this.summaryStatus(authority, scopeId, input.operationId)
      if (!['running', 'failed', 'cancelled'].includes(input.status) || !['history', 'memory', 'summary', 'commit'].includes(input.phase) ||
        !Number.isSafeInteger(input.expectedVersion) || input.reasonCode !== undefined && !/^SUMMARY_[A-Z_]{1,80}$/.test(input.reasonCode)) sourceContextError('INVALID_PARAMS')
      if (previous.status === 'completed') sourceContextError('SOURCE_CONFLICT')
      // Foreground priority pauses maintenance, not its fixed input or saved blocks.
      // Only an explicit, revision-checked restart may leave that cancelled state.
      if (previous.status === 'cancelled' && !(previous.reasonCode === 'SUMMARY_FOREGROUND_PRIORITY' && input.status === 'running'))
        sourceContextError('SOURCE_CONFLICT')
      if (previous.status === input.status && previous.phase === input.phase && previous.reasonCode === input.reasonCode) return previous
      if (previous.version !== input.expectedVersion) sourceContextError('REVISION_CONFLICT')
      const next: SourceSummaryOperation = { ...previous, status: input.status, phase: input.phase, reasonCode: input.reasonCode, version: previous.version + 1 }
      this.db.prepare('UPDATE source_summary_operations SET data_json=? WHERE operation_id=?').run(JSON.stringify(next), input.operationId)
      authority.validate()
      return next
    })()
  }
  commitSummary(authority: SourceAuthority, scopeId: string, input: {
    operationId: string; expectedBaseSummaryId?: string; text: string; prerequisiteReceipt: string
  }, validatePrerequisite: (receipt: string, operationId: string) => boolean): SourceSummary {
    if (!input.text.trim() || input.text.length > 12000) sourceContextError('SUMMARY_INVALID')
    return this.db.transaction(() => {
      const scope = this.scope(authority, scopeId, ['maintenance'])
      const operation = this.summaryStatus(authority, scopeId, input.operationId)
      const previous = this.db.prepare('SELECT data_json FROM source_summaries WHERE operation_id=?').get(input.operationId) as JsonRow | undefined
      if (previous) {
        const summary = SourceSummarySchema.parse(JSON.parse(previous.data_json))
        if (summary.text !== input.text || operation.baseSummaryId !== input.expectedBaseSummaryId) sourceContextError('SOURCE_CONFLICT')
        return summary
      }
      if (operation.status === 'cancelled' || operation.permissionRevision !== scope.permissionRevision) sourceContextError('PERMISSION_DENIED')
      if (operation.baseSelectionRevision !== scope.selectionRevision || operation.baseSummaryId !== input.expectedBaseSummaryId ||
        this.summary(authority, scopeId)?.summaryId !== input.expectedBaseSummaryId) sourceContextError('SUMMARY_CONFLICT')
      if (operation.purpose === 'discussion') {
        const prepared = this.snapshot(authority, scopeId, operation.snapshotId)
        const maxOrdinal = (this.db.prepare(`SELECT COALESCE(MAX(r.ingest_ordinal),0) AS n FROM source_scope_members m
          JOIN source_records r USING(record_id) WHERE m.scope_id=?`).get(scopeId) as { n: number }).n
        if (maxOrdinal > prepared.throughIngestOrdinal) sourceContextError('SUMMARY_CONFLICT')
      }
      if (!validatePrerequisite(input.prerequisiteReceipt, input.operationId)) sourceContextError('SUMMARY_PREREQUISITE_FAILED')
      const base = this.summary(authority, scopeId)
      const replacement = new Map<string, { record: SourceRecordRef; partIds: Set<string> }>()
      for (const item of base?.replacement ?? []) replacement.set(item.record.recordId, { record: item.record, partIds: new Set(item.partIds) })
      const evidenceByRecord = new Map<string, SourceSummaryEvidence>()
      for (const evidence of [...(base?.evidence ?? []), ...operation.evidence]) {
        const old = evidenceByRecord.get(evidence.record.recordId)
        evidenceByRecord.set(evidence.record.recordId, old ? { record: evidence.record,
          textPartIds: [...new Set([...old.textPartIds, ...evidence.textPartIds])],
          attachments: [...new Map([...old.attachments, ...evidence.attachments].map(a => [canonical(a), a])).values()] } : evidence)
      }
      for (const evidence of evidenceByRecord.values()) {
        const entry = replacement.get(evidence.record.recordId) ?? { record: evidence.record, partIds: new Set<string>() }
        for (const partId of evidence.textPartIds) entry.partIds.add(partId)
        const record = this.rawRecord(evidence.record.recordId)
        for (const file of evidence.attachments) if ((file.representation === 'native' || file.representation === 'description') &&
          record.parts.some(p => p.partId === file.partId && p.type === 'attachment' && this.attachment(authority, scopeId, p.attachmentId).version === file.attachmentVersion))
          entry.partIds.add(file.partId)
        replacement.set(evidence.record.recordId, entry)
      }
      const summary = SourceSummarySchema.parse({ summaryId: id('summary'), scopeId, revision: (base?.revision ?? 0) + 1,
        operationId: input.operationId, purpose: operation.purpose, text: input.text, committedAt: this.now(),
        evidence: [...evidenceByRecord.values()], replacement: [...replacement.values()].map(r => ({ record: r.record, partIds: [...r.partIds] })) })
      this.db.prepare('INSERT INTO source_summaries(summary_id,scope_id,operation_id,data_json) VALUES (?,?,?,?)')
        .run(summary.summaryId, scopeId, input.operationId, JSON.stringify(summary))
      if (operation.purpose !== 'capacity') {
        this.saveScope({ ...scope, selectionRevision: scope.selectionRevision + 1 })
        this.db.prepare('UPDATE source_scopes SET active_summary_id=? WHERE scope_id=?').run(summary.summaryId, scopeId)
      }
      this.db.prepare('UPDATE source_summary_operations SET data_json=? WHERE operation_id=?')
        .run(JSON.stringify({ ...operation, status: operation.purpose === 'capacity' ? 'running' : 'completed', phase: 'commit',
          version: operation.version + 1, summaryId: summary.summaryId }), input.operationId)
      authority.validate()
      return summary
    })()
  }
}
