import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, open, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { FileCapabilityOperation, FileOperationRecord, MessagePart } from '@chery/protocol'
import { deriveTextContentFromParts, buildFileServiceToolName } from '@chery/protocol'
import { captureRuntimeConfig } from '@/utils/config.js'
import { getSoulDb } from '@/db/index.js'
import { imageRevision, stable } from '../config/impact.js'
import { getAssetStore } from '../media/store.js'
import { fileAccessForChat } from '../media/access.js'
import { identifyFile } from '../media/fileFormat.js'
import { executeFileServiceAdapter } from './adapters/index.js'
import { boundedBody } from './adapters/http.js'
import { downloadProviderResult } from './download.js'
import type { FileServiceAdapterOutput } from './adapters/types.js'
import { FileServiceAdapterError } from './adapters/types.js'
import { saveImageDescription } from './imageContext.js'
import type { FileServiceConfig } from '@chery/plugin-api'
import { executeLocalFileAdapter } from './localAdapters.js'
import { assertFileServiceRoleAllowed } from './runtime.js'
import type { SenseRuntimeContext } from '@/core/sense/senseCreator.js'

interface OperationRow { operation_id: string; owner_id: string; chat_id: string | null; fingerprint: string; data_json: string; request_json: string }
export interface FileOperationInput {
  ownerId: string; chatId?: string; requestId: string; serviceId: string; operation: FileCapabilityOperation
  params: Record<string, unknown>; assets: Array<{ assetId: string; assetVersionId: string }>
  providerContinuation?: Record<string, unknown>; signal?: AbortSignal; sourceCallId?: string
  serviceOverride?: FileServiceConfig
  enforceRolePolicy?: boolean
  requireInspection?: boolean
  requestView?: SenseRuntimeContext['requestView']
}
const active = new Map<string, AbortController>()
const executions = new Map<string, Promise<FileOperationRecord>>()
const serviceCounts = new Map<string, number>()
const saving = new Map<string, Promise<FileOperationRecord>>()

function db() {
  const database = getSoulDb()
  database.exec(`CREATE TABLE IF NOT EXISTS file_operations (
    operation_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE,
    request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, data_json TEXT NOT NULL, request_json TEXT NOT NULL,
    UNIQUE(owner_id, request_id)); CREATE INDEX IF NOT EXISTS idx_file_operations_chat ON file_operations(chat_id);`)
  return database
}
function row(id: string): OperationRow {
  const stored = db().prepare('SELECT * FROM file_operations WHERE operation_id = ?').get(id) as OperationRow | undefined
  if (!stored) throw new Error('文件操作不存在')
  return stored
}
function authorize(stored: OperationRow, ownerId: string, chatId?: string): void {
  if (stored.owner_id !== ownerId || chatId && stored.chat_id !== chatId) throw new Error('文件操作不存在或无权访问')
  if (stored.chat_id) fileAccessForChat(stored.chat_id, ownerId)
}
function update(record: FileOperationRecord): FileOperationRecord {
  record.updatedAt = Date.now()
  db().prepare('UPDATE file_operations SET data_json = ? WHERE operation_id = ?').run(JSON.stringify(record), record.operationId)
  return record
}
function spoolRoot() { return resolve(process.env.CHERY_DIR || process.cwd(), '.chery', 'file-operation-results') }
function spoolPath(id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('文件操作标识无效')
  return resolve(spoolRoot(), `${id}.json`)
}
async function persistSpool(path: string, value: unknown) {
  await mkdir(spoolRoot(), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    const file = await open(temporary, 'wx', 0o600)
    try { await file.writeFile(JSON.stringify(value)); await file.sync() } finally { await file.close() }
    await rename(temporary, path)
  } finally { await unlink(temporary).catch(() => undefined) }
}

export function getFileOperation(id: string, ownerId: string, chatId?: string): FileOperationRecord {
  const stored = row(id)
  authorize(stored, ownerId, chatId)
  return JSON.parse(stored.data_json)
}
export function listFileOperations(chatId: string, ownerId: string): FileOperationRecord[] {
  fileAccessForChat(chatId, ownerId)
  return (db().prepare('SELECT data_json FROM file_operations WHERE chat_id = ? AND owner_id = ? ORDER BY rowid').all(chatId, ownerId) as { data_json: string }[]).map(item => JSON.parse(item.data_json))
}

async function deliver(record: FileOperationRecord, input: FileOperationInput, output: FileServiceAdapterOutput): Promise<FileOperationRecord> {
  record.providerContinuation = output.providerContinuation
  record.deliveryStatus = 'saving'
  update(record)
  const parts: MessagePart[] = []
  const previous = record.outputParts ?? []
  try {
    for (let index = 0; index < output.parts.length; index++) {
      const existing = previous[index]
      if (existing) { parts.push(existing); continue }
      const part = output.parts[index]!
      if (part.type === 'text') parts.push({ partId: `${record.operationId}:${index}`, type: 'text', text: part.text })
      else {
        const format = identifyFile(part.data, part.mimeType)
        const asset = await getAssetStore().save(part.data, { ownerId: input.ownerId, originalName: part.originalName, source: 'provider', ...format })
        const saved: MessagePart = { partId: `${record.operationId}:${index}`, type: 'asset', assetId: asset.id, assetVersionId: asset.versionId, variant: 'original', usage: 'content', originalName: asset.originalName, mimeType: asset.mimeType, kind: asset.kind }
        if (input.chatId) getAssetStore().attachOwned([saved], fileAccessForChat(input.chatId, input.ownerId), 'operation', record.operationId)
        else getAssetStore().referenceOperation([{ assetId: asset.id, assetVersionId: asset.versionId }], { ownerId: input.ownerId }, record.operationId)
        parts.push(saved)
      }
      record.outputParts = [...parts]
      update(record)
    }
    record.outputParts = parts
    record.outputAssetIds = parts.filter(part => part.type === 'asset').map(part => part.assetId)
    record.deliveryStatus = output.incomplete?.retryable
      ? parts.some(part => part.type === 'asset') ? 'partial_saved' : 'delivery_failed' : 'saved'
    if (record.executionStatus === 'succeeded') record.error = undefined
    const saved = update(record)
    if (!output.incomplete?.retryable) {
      for (const path of [spoolPath(record.operationId), `${spoolPath(record.operationId)}.remote`]) await unlink(path).catch(() => undefined)
    }
    return saved
  } catch (error) {
    record.outputParts = parts
    record.outputAssetIds = parts.filter(part => part.type === 'asset').map(part => part.assetId)
    record.deliveryStatus = parts.some(part => part.type === 'asset') ? 'partial_saved' : 'delivery_failed'
    record.error = { code: 'FILE_SAVE_FAILED', message: (error as Error).message, retryable: true }
    return update(record)
  }
}

async function saveAdapterOutput(record: FileOperationRecord, input: FileOperationInput, output: FileServiceAdapterOutput) {
  const understanding = ['image.inspect', 'document.extract', 'audio.transcribe', 'video.inspect'].includes(input.operation)
  const usable = output.parts.some(part => understanding ? part.type === 'text' && !!part.text.trim() : part.type === 'file')
  record.executionStatus = usable ? output.incomplete ? 'partial' : 'succeeded' : 'failed'
  record.error = output.incomplete
    ? { code: output.incomplete.code, message: output.incomplete.message, retryable: output.incomplete.retryable }
    : !usable ? { code: 'FILE_OUTPUT_MISSING', message: understanding ? '服务未返回有效的理解文字' : '服务没有返回文件；文字结果不能视为图片生成成功' } : undefined
  record.remoteJobId = output.remoteJobId
  record.usage = output.usage
  update(record)
  // 未取得的下载须重新解析原响应，不能把前序文件当作完整响应覆盖它。
  if (!output.incomplete?.retryable) {
    try {
      await persistSpool(spoolPath(record.operationId), { ...output, parts: output.parts.map(part => part.type === 'file' ? { ...part, data: part.data.toString('base64') } : part) })
    } catch {
      record.deliveryStatus = 'delivery_failed'
      record.error = { code: 'FILE_SAVE_FAILED', message: '已收到远程结果，但本地暂存失败。不会自动重新生成。', retryable: existsSync(`${spoolPath(record.operationId)}.remote`) }
      return update(record)
    }
  }
  return deliver(record, input, output)
}

async function execute(record: FileOperationRecord, input: FileOperationInput): Promise<FileOperationRecord> {
  const snapshot = captureRuntimeConfig()
  const service = input.serviceOverride ?? snapshot.file_services?.[input.serviceId]
  if (!service || service.enabled === false || !service.operations.includes(input.operation)) {
    record.executionStatus = 'failed'
    record.error = { code: 'FILE_SERVICE_UNAVAILABLE', message: '文件服务已关闭或不支持此操作' }
    return update(record)
  }
  const controller = new AbortController()
  active.set(record.operationId, controller)
  let signal = AbortSignal.any([controller.signal, ...(input.signal ? [input.signal] : [])])
  let acquired = false
  let started = false
  let received = false
  try {
    const queuedAt = Date.now()
    while ((serviceCounts.get(input.serviceId) ?? 0) >= (service.maxConcurrent ?? 2)) {
      signal.throwIfAborted()
      if (Date.now() - queuedAt > (service.queueTimeoutMs ?? 600_000)) throw new Error('文件服务排队超时')
      await new Promise<void>(resolveWait => { const timer = setTimeout(resolveWait, 100); timer.unref?.() })
    }
    signal.throwIfAborted()
    serviceCounts.set(input.serviceId, (serviceCounts.get(input.serviceId) ?? 0) + 1)
    acquired = true
    signal = AbortSignal.any([signal, AbortSignal.timeout(service.timeoutMs ?? 600_000)])
    if (!input.serviceOverride) {
      const latest = captureRuntimeConfig().file_services?.[input.serviceId]
      const current = captureRuntimeConfig()
      if (!latest || latest.enabled === false || !latest.operations.includes(input.operation) || stable(latest) !== stable(service) || service.connection.brainRef && stable(current.llm.brain[service.connection.brainRef]) !== stable(snapshot.llm.brain[service.connection.brainRef])) throw new Error('文件服务或连接在排队期间改变，请重新确认后执行')
    }
    if (input.enforceRolePolicy && input.chatId) assertFileServiceRoleAllowed(input.chatId, input.serviceId, input.operation)
    const access = input.chatId ? fileAccessForChat(input.chatId, input.ownerId) : { ownerId: input.ownerId }
    const assets: Array<{ assetId: string; assetVersionId: string; mimeType: string; data: Buffer }> = []
    if (new Set(input.assets.map(ref => `${ref.assetId}:${ref.assetVersionId}`)).size > (snapshot.files?.context?.maxAssets ?? 10)) throw new Error('本次文件数量超过请求预算')
    let inputBytes = 0
    for (const ref of input.assets) {
      const metadata = getAssetStore().get(ref.assetId, access, ref.assetVersionId)
      inputBytes += metadata.sizeBytes
      if (inputBytes > (snapshot.files?.context?.maxBinaryBytes ?? 16 * 1024 * 1024)) throw new Error('本次文件内容超过请求预算')
      const asset = await getAssetStore().read(ref.assetId, access, ref.assetVersionId)
      assets.push({ ...ref, mimeType: asset.asset.mimeType, data: asset.data })
    }
    const brain = service.connection.brainRef ? snapshot.llm.brain[service.connection.brainRef] : undefined
    const baseUrl = brain?.url ?? service.connection.baseUrl
    const model = service.connection.model ?? brain?.model
    const key = brain?.key ?? service.connection.keyRef
    const local = ['vision-brain', 'custom-sense-mcp'].includes(service.adapter)
    if (!local && (!baseUrl || !model || key?.startsWith('$'))) throw new Error('文件服务连接或凭据尚未配置完整')
    record.executionStatus = 'running'
    update(record)
    const adapterInput = { adapter: service.adapter, operation: input.operation,
      connection: { baseUrl: baseUrl ?? '', model: model ?? '', key, authType: service.connection.authType, endpoints: service.connection.endpointOverrides }, params: { ...service.defaults, ...input.params }, assets,
      providerContinuation: input.providerContinuation, signal }
    const output = local ? await executeLocalFileAdapter(adapterInput, service, snapshot, input.chatId, input.requestView, record.operationId, () => { started = true }) : await executeFileServiceAdapter(adapterInput, { timeoutMs: service.timeoutMs,
      fetch: async (url, options) => {
        started = true
        const response = await fetch(url, { ...options, redirect: 'error' })
        if (response.ok) {
          const body = await boundedBody(response.clone(), 256 * 1024 * 1024, signal)
          received = true
          await persistSpool(`${spoolPath(record.operationId)}.remote`, {
            status: response.status, contentType: response.headers.get('content-type'), body: body.toString('base64'),
             input: { ...adapterInput, signal: undefined, connection: { ...adapterInput.connection, key: undefined }, assets: assets.map(asset => ({ ...asset, data: asset.data.toString('base64') })) },
             connectionRevision: imageRevision({ service, brain }),
          })
        }
        return response
      }, download: (url, context) => downloadProviderResult(url, context.signal) })
    const saved = await saveAdapterOutput(record, input, output)
    if (input.chatId && input.operation === 'image.inspect' && input.assets.length === 1 && saved.executionStatus === 'succeeded' && saved.deliveryStatus === 'saved' && !signal.aborted) {
      const text = deriveTextContentFromParts(saved.outputParts ?? [])
      if (text.trim()) {
        try { saveImageDescription(input.chatId, input.assets[0]!, { text, source: 'observation', scope: `针对当时问题的图片观察：${String(input.params.prompt ?? '').slice(0, 200)}`, operationId: saved.operationId, sourceMessageId: input.sourceCallId }) }
        catch { /* A failed optional description cache must not change an already saved operation. */ }
      }
    }
    return saved
  } catch (error) {
    if (error instanceof FileServiceAdapterError && error.partialOutput) {
      // 原始响应已经暂存；成功的前序项先保存，缺失项只允许重试下载。
      return await saveAdapterOutput(record, input, error.partialOutput)
    }
    const aborted = signal.aborted
    const code = (error as { code?: string }).code
    const rejected = code === 'file_service.provider_error'
    record.executionStatus = record.executionStatus === 'succeeded' ? 'succeeded' : rejected ? 'failed' : started ? 'result_unknown' : aborted ? 'cancelled' : 'failed'
    if (rejected && error instanceof FileServiceAdapterError && error.outputParts?.some(part => part.type === 'asset')) {
      record.outputParts = error.outputParts
      record.outputAssetIds = error.outputParts.filter(part => part.type === 'asset').map(part => part.assetId)
      record.executionStatus = 'partial'
      record.deliveryStatus = 'saved'
    }
    if ((received || record.executionStatus === 'succeeded') && !rejected) record.deliveryStatus = 'delivery_failed'
    record.error = rejected
      ? { code: 'FILE_PROVIDER_REJECTED', message: (error as Error).message, retryable: false }
      : record.executionStatus === 'succeeded'
        ? { code: 'FILE_SAVE_FAILED', message: '已收到远程结果，但本地保存失败。不会自动重新生成。', retryable: received }
        : { code: started ? 'FILE_RESULT_UNKNOWN' : aborted ? 'FILE_CANCELLED' : 'FILE_EXECUTION_FAILED', message: started ? '请求已发出，但未能确认远程结果。再次执行可能重复计费。' : (error as Error).message, retryable: !started }
    return update(record)
  } finally {
    active.delete(record.operationId)
    if (acquired) serviceCounts.set(input.serviceId, Math.max(0, (serviceCounts.get(input.serviceId) ?? 1) - 1))
  }
}

export async function runFileOperation(input: FileOperationInput, wait = true): Promise<FileOperationRecord> {
  if (!input.ownerId || !input.requestId) throw new Error('文件操作需要身份和唯一请求标识')
  if (input.chatId) fileAccessForChat(input.chatId, input.ownerId)
  if (input.enforceRolePolicy && input.chatId) assertFileServiceRoleAllowed(input.chatId, input.serviceId, input.operation)
  const fingerprint = createHash('sha256').update(stable({ ...input, signal: undefined, requestId: undefined, requestView: input.requestView?.identity })).digest('hex')
  const existing = db().prepare('SELECT * FROM file_operations WHERE owner_id = ? AND request_id = ?').get(input.ownerId, input.requestId) as OperationRow | undefined
  if (existing) {
    authorize(existing, input.ownerId, input.chatId)
    if (existing.fingerprint !== fingerprint) throw new Error('请求标识已用于不同的文件操作')
    return wait ? executions.get(existing.operation_id) ?? JSON.parse(existing.data_json) : JSON.parse(existing.data_json)
  }
  const snapshot = captureRuntimeConfig()
  const record: FileOperationRecord = { operationId: randomUUID(), operation: input.operation, inputAssets: input.assets,
    params: input.params, targetKind: 'tool', targetId: buildFileServiceToolName(input.serviceId, input.operation), configRevision: imageRevision(snapshot), sourceCallId: input.sourceCallId,
    executionStatus: 'queued', deliveryStatus: 'pending_save', inspectionStatus: input.requireInspection ? 'pending_inspection' : 'not_requested', createdAt: Date.now(), updatedAt: Date.now() }
  db().transaction(() => {
    db().prepare('INSERT INTO file_operations (operation_id,owner_id,chat_id,request_id,fingerprint,data_json,request_json) VALUES (?,?,?,?,?,?,?)')
      .run(record.operationId, input.ownerId, input.chatId ?? null, input.requestId, fingerprint, JSON.stringify(record), JSON.stringify({ ...input, signal: undefined, requestView: undefined, serviceOverride: input.serviceOverride ? { ...input.serviceOverride, connection: { ...input.serviceOverride.connection, keyRef: undefined } } : undefined }))
    getAssetStore().referenceOperation(input.assets, input.chatId ? fileAccessForChat(input.chatId, input.ownerId) : { ownerId: input.ownerId }, record.operationId)
  })()
  const promise = execute(record, input).finally(() => executions.delete(record.operationId))
  executions.set(record.operationId, promise)
  return wait ? promise : structuredClone(record)
}

export function cancelFileOperation(id: string, ownerId: string, chatId?: string): FileOperationRecord {
  const record = getFileOperation(id, ownerId, chatId)
  if (active.has(id)) { record.executionStatus = 'cancel_requested'; update(record); active.get(id)!.abort() }
  return record
}
export function recordFileInspection(id: string, evidenceId: string, passed: boolean, summary: string, ownerId: string, chatId: string): FileOperationRecord {
  if (!summary.trim() || summary.length > 20000) throw new Error('检查结论不能为空且不能超过 20000 字')
  return db().transaction(() => {
    const record = getFileOperation(id, ownerId, chatId)
    const evidence = getFileOperation(evidenceId, ownerId, chatId)
    if (id === evidenceId || !['image.inspect', 'document.extract', 'audio.transcribe', 'video.inspect'].includes(evidence.operation)) throw new Error('检查依据必须是另一次文件理解操作')
    if (record.deliveryStatus !== 'saved' || !['succeeded', 'partial'].includes(record.executionStatus)) throw new Error('生成结果必须先完整保存后再记录检查')
    const outputs = record.outputParts?.filter(part => part.type === 'asset') ?? []
    if (!outputs.length || outputs.some(part => !evidence.inputAssets.some(input => input.assetId === part.assetId && input.assetVersionId === part.assetVersionId))) throw new Error('检查操作没有读取本次全部输出的固定版本')
    record.inspectionOperationId = evidenceId
    record.inspectionSummary = summary.trim()
    record.inspectionStatus = evidence.executionStatus === 'succeeded' && evidence.deliveryStatus === 'saved'
      ? passed ? 'passed' : 'failed_inspection' : 'inspection_error'
    return update(record)
  })()
}
export async function retryFileOperationSave(id: string, ownerId: string, chatId?: string): Promise<FileOperationRecord> {
  const record = getFileOperation(id, ownerId, chatId)
  if (!['delivery_failed', 'partial_saved'].includes(record.deliveryStatus)) throw new Error('此操作不需要重新保存')
  if (saving.has(id)) return saving.get(id)!
  const stored = row(id)
  const input = JSON.parse(stored.request_json) as FileOperationInput
  const work = (async () => {
    let output: FileServiceAdapterOutput
    try {
      const raw = JSON.parse(await readFile(spoolPath(id), 'utf8'))
      output = { ...raw, parts: raw.parts.map((part: any) => part.type === 'file' ? { ...part, data: Buffer.from(part.data, 'base64') } : part) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const remote = JSON.parse(await readFile(`${spoolPath(id)}.remote`, 'utf8'))
      const access = input.chatId ? fileAccessForChat(input.chatId, ownerId) : { ownerId }
      const savedParts = await Promise.all((record.outputParts ?? []).map(async part => part.type === 'asset'
        ? { type: 'file' as const, data: (await getAssetStore().read(part.assetId, access, part.assetVersionId)).data,
          mimeType: part.mimeType ?? 'application/octet-stream', originalName: part.originalName ?? 'file' }
        : { type: 'text' as const, text: part.type === 'text' ? part.text : '' }))
      try {
        output = await executeFileServiceAdapter({ ...remote.input, assets: remote.input.assets.map((asset: any) => ({ ...asset, data: Buffer.from(asset.data, 'base64') })) }, {
          savedParts,
          fetch: async () => new Response(new Uint8Array(Buffer.from(remote.body, 'base64')), { status: remote.status, headers: { 'content-type': remote.contentType ?? 'application/json' } }),
          download: (url, options) => {
            const config = captureRuntimeConfig()
            const service = config.file_services?.[input.serviceId]
            if (!service || service.enabled === false || !service.operations.includes(input.operation)) throw new FileServiceAdapterError('file_operation.delivery_failed', '原文件服务已删除或关闭，不能重新取得远程结果；已保存文件不受影响')
            if (remote.connectionRevision !== imageRevision({ service, brain: service.connection.brainRef ? config.llm.brain[service.connection.brainRef] : undefined })) throw new FileServiceAdapterError('file_operation.delivery_failed', '文件服务连接已改变，请先恢复原连接后再保存远程结果')
            return downloadProviderResult(url, options.signal)
          },
        })
      } catch (error) {
        if (!(error instanceof FileServiceAdapterError) || !error.partialOutput) throw error
        output = error.partialOutput
      }
    }
    return saveAdapterOutput(record, input, output)
  })().finally(() => saving.delete(id))
  saving.set(id, work)
  return work
}
export function recoverFileOperations(): void {
  for (const item of db().prepare('SELECT * FROM file_operations').all() as OperationRow[]) {
    const record = JSON.parse(item.data_json) as FileOperationRecord
    if (['queued', 'running', 'cancel_requested'].includes(record.executionStatus)) {
      record.executionStatus = record.executionStatus === 'queued' ? 'failed' : 'result_unknown'
      record.error = { code: 'FILE_OPERATION_INTERRUPTED', message: '服务重启中断了操作。不会自动重复发起可能计费的请求。', retryable: false }
      update(record)
    }
    const hasSavedResponse = existsSync(spoolPath(record.operationId)) || existsSync(`${spoolPath(record.operationId)}.remote`)
    if (record.deliveryStatus === 'saving' || record.deliveryStatus === 'pending_save' && (record.executionStatus === 'succeeded' || hasSavedResponse)) {
      record.deliveryStatus = 'delivery_failed'
      record.error = { code: 'FILE_SAVE_INTERRUPTED', message: '本地保存被重启中断，可尝试恢复已有结果，不会重新生成。', retryable: true }
      update(record)
    }
  }
}

export function listTrialFileOperations(ownerId: string, serviceId: string): FileOperationRecord[] {
  return (db().prepare("SELECT data_json FROM file_operations WHERE owner_id = ? AND chat_id IS NULL AND json_extract(request_json, '$.serviceId') = ? ORDER BY rowid DESC LIMIT 100")
    .all(ownerId, serviceId) as { data_json: string }[]).map(item => JSON.parse(item.data_json))
}
export async function deleteTrialFileOperation(id: string, ownerId: string): Promise<void> {
  const stored = row(id)
  authorize(stored, ownerId)
  if (stored.chat_id || active.has(id) || saving.has(id)) throw new Error('只能删除已停止的试用记录')
  db().prepare('DELETE FROM file_operations WHERE operation_id = ?').run(id)
  for (const path of [spoolPath(id), `${spoolPath(id)}.remote`]) await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
}

export function fileOperationText(record: FileOperationRecord): string { return deriveTextContentFromParts(record.outputParts ?? []) || record.error?.message || record.executionStatus }
