import { createHash, randomUUID } from 'node:crypto'
import { getSoulDb } from '@/db/index.js'
import { getChat, getChatType, updateChatMetadata } from '@/db/chat.js'
import { captureRuntimeConfig } from '@/utils/config.js'
import { buildFileServiceToolName, withoutImageCountParams, requestedImageCount, type DrawingIntent, type DrawingTask, type DrawingRound, type DrawingCandidate, type MessagePart, type FileOperationRecord, type ImageOutputOperation } from '@chery/protocol'
import { fileAccessForChat } from '../media/access.js'
import { getAssetStore } from '../media/store.js'
import { resolveImageOutput, imageCountParams } from './imageOutput.js'
import { resolveChatFileCapability, fileCapabilityContext } from './runtime.js'
import { resolveFileCapability } from './capabilityResolver.js'
import { stable, imageRevision } from '../config/impact.js'
import type { UserInputEntry } from '@/core/middleware/types.js'
import type { IngressRequestView } from '../ingress/api.js'
import { validateFileServiceAdapterParams, FILE_SERVICE_ADAPTER_PARAM_SCHEMAS } from './adapters/params.js'
import { getSessionRoleRuntime } from '../chat/sessionRoleRuntime.js'

function db() {
  const database = getSoulDb()
  database.exec(`CREATE TABLE IF NOT EXISTS drawing_tasks (
    task_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    selection_revision INTEGER NOT NULL DEFAULT 0, final_candidate_id TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS drawing_rounds (
      round_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES drawing_tasks(task_id) ON DELETE CASCADE,
      input_id TEXT NOT NULL UNIQUE, message_id TEXT NOT NULL UNIQUE, operation_id TEXT UNIQUE, data_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS drawing_finalizations (
      owner_id TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, result_json TEXT NOT NULL,
      task_id TEXT NOT NULL REFERENCES drawing_tasks(task_id) ON DELETE CASCADE, PRIMARY KEY(owner_id,request_id));
    CREATE TABLE IF NOT EXISTS drawing_continuations (
      round_id TEXT PRIMARY KEY REFERENCES drawing_rounds(round_id) ON DELETE CASCADE,
      connection_revision TEXT NOT NULL, continuation_json TEXT NOT NULL);`)
  return database
}
interface TaskRow { task_id: string; owner_id: string; chat_id: string; selection_revision: number; final_candidate_id: string | null; created_at: number }
function taskRow(taskId: string, chatId: string, ownerId: string): TaskRow {
  fileAccessForChat(chatId, ownerId)
  const row = db().prepare('SELECT * FROM drawing_tasks WHERE task_id = ? AND chat_id = ? AND owner_id = ?').get(taskId, chatId, ownerId) as TaskRow | undefined
  if (!row) throw new Error('绘图任务不存在或无权访问')
  return row
}
function roundRows(taskId: string): DrawingRound[] {
  return (db().prepare('SELECT data_json, operation_id FROM drawing_rounds WHERE task_id = ? ORDER BY rowid').all(taskId) as Array<{ data_json: string; operation_id: string | null }>).map(row => ({ ...JSON.parse(row.data_json), ...(row.operation_id ? { operationId: row.operation_id } : {}) }))
}
export function getDrawingRound(roundId: string): DrawingRound {
  const row = db().prepare('SELECT data_json, operation_id FROM drawing_rounds WHERE round_id = ?').get(roundId) as { data_json: string; operation_id: string | null } | undefined
  if (!row) throw new Error('绘图轮不存在')
  return { ...JSON.parse(row.data_json), ...(row.operation_id ? { operationId: row.operation_id } : {}) }
}
function operationForRound(round: DrawingRound): FileOperationRecord | undefined {
  if (!round.operationId) return
  const row = db().prepare('SELECT data_json FROM file_operations WHERE operation_id = ?').get(round.operationId) as { data_json: string } | undefined
  return row ? JSON.parse(row.data_json) : round.operation
}
function candidates(round: DrawingRound, operation?: FileOperationRecord): DrawingCandidate[] {
  return (operation?.outputParts ?? []).flatMap((part, partIndex) => part.type === 'asset' && part.kind === 'image' && part.assetVersionId
    ? [{ candidateId: `${round.roundId}:${part.partId}`, roundId: round.roundId, operationId: operation!.operationId, partIndex, assetId: part.assetId, assetVersionId: part.assetVersionId }] : [])
}
export function getDrawingTask(taskId: string, chatId: string, ownerId: string): DrawingTask {
  const row = taskRow(taskId, chatId, ownerId)
  const access = fileAccessForChat(chatId, ownerId)
  const rounds = roundRows(taskId).map(round => {
    const original = operationForRound(round)
    const { providerContinuation: _private, ...operation } = original ?? {} as FileOperationRecord
    const saved = candidates(round, original).filter(candidate => {
      try { return getAssetStore().get(candidate.assetId, access, candidate.assetVersionId).availability === 'available' } catch { return false }
    })
    return { ...round, ...(original ? { operation } : {}), candidates: saved }
  })
  return { taskId, chatId, selectionRevision: row.selection_revision, ...(row.final_candidate_id ? { finalCandidateId: row.final_candidate_id } : {}), createdAt: row.created_at, rounds }
}
export function listDrawingTasks(chatId: string, ownerId: string): DrawingTask[] {
  fileAccessForChat(chatId, ownerId)
  return (db().prepare('SELECT task_id FROM drawing_tasks WHERE chat_id = ? AND owner_id = ? ORDER BY created_at').all(chatId, ownerId) as { task_id: string }[]).map(row => getDrawingTask(row.task_id, chatId, ownerId))
}
function findCandidate(task: DrawingTask, candidateId: string): DrawingCandidate {
  const candidate = task.rounds.flatMap(round => round.candidates).find(item => item.candidateId === candidateId)
  if (!candidate) throw new Error('候选图不存在、未保存或无权使用')
  getAssetStore().get(candidate.assetId, fileAccessForChat(task.chatId), candidate.assetVersionId)
  return candidate
}
export function resolveDrawingRole(chatId: string, serviceId: string, operation: ImageOutputOperation, roleId?: string) {
  const base = fileCapabilityContext(chatId)
  if (roleId) {
    const role = Object.entries(base.config.roles ?? {}).find(([name, role]) => role.id === roleId || name === roleId)
    if (!role) throw new Error('所选绘图角色不存在')
    const delegated = resolveFileCapability({ ...base, operation, explicit: { mode: 'role', targetId: roleId } })
    if (!['available', 'requires_approval'].includes(delegated.availability)) return delegated
    return resolveFileCapability({ ...base, roleName: role[0], roleId: role[1].id,
      runtimeSelection: getSessionRoleRuntime(chatId, role[0]) ?? { brain: role[1].brain, senseGroup: role[1].senseGroup, mcpServers: role[1].mcpServers },
      operation, explicit: { mode: 'tool', targetId: buildFileServiceToolName(serviceId, operation) } })
  }
  return resolveFileCapability({ ...base, operation, explicit: { mode: 'tool', targetId: buildFileServiceToolName(serviceId, operation) } })
}
export function createDrawingRound(input: { ownerId: string; chatId: string; inputId: string; messageId: string; feedback: string; intent: DrawingIntent; parts: MessagePart[] }): DrawingRound {
  const { intent } = input
  const config = captureRuntimeConfig()
  const service = config.file_services?.[intent.serviceId]
  if (!service || service.enabled === false || !service.operations.includes(intent.operation)) throw new Error('所选绘图服务不可用或不支持此操作')
  const access = fileAccessForChat(input.chatId, input.ownerId)
  const resolution = resolveChatFileCapability(input.chatId, intent.operation)
  if (resolution.mode === 'disabled') throw new Error('当前角色已禁用此绘图操作')
  const target = resolveDrawingRole(input.chatId, intent.serviceId, intent.operation, intent.roleId)
  if (!['available', 'requires_approval'].includes(target.availability)) throw new Error(target.reason)
  const references = input.parts.flatMap(part => part.type === 'asset' && part.usage !== 'reference-only' ? [part] : []).map(part => {
    const asset = getAssetStore().get(part.assetId, access, part.assetVersionId)
    if (asset.kind !== 'image' || asset.availability !== 'available') throw new Error('绘图参考内容必须为可读取的图片')
    return { assetId: asset.id, assetVersionId: asset.versionId }
  })
  let sourceTask: DrawingTask | undefined
  let reuseTask = !!intent.taskId
  if (intent.taskId) {
    const inThisChat = db().prepare('SELECT 1 FROM drawing_tasks WHERE task_id = ? AND chat_id = ? AND owner_id = ?').get(intent.taskId, input.chatId, input.ownerId)
    const branchSource = JSON.parse(getChat(input.chatId)?.metadata ?? '{}').drawingSourceChatId
    if (!inThisChat && typeof branchSource === 'string') { sourceTask = getDrawingTask(intent.taskId, branchSource, input.ownerId); reuseTask = false }
    else sourceTask = getDrawingTask(intent.taskId, input.chatId, input.ownerId)
  }
  if (intent.sourceCandidateId) {
    const candidate = findCandidate(sourceTask!, intent.sourceCandidateId)
    if (!references.some(ref => ref.assetId === candidate.assetId && ref.assetVersionId === candidate.assetVersionId)) throw new Error('所选修改图的固定版本必须包含在本次输入中')
    if (intent.operation === 'image.generate') throw new Error('修改候选图须选择参考或编辑操作，不能当作纯文字重画')
    if (service.adapter === 'minimax-images') throw new Error('MiniMax 人物参考不能用于通用候选图修改')
  }
  if (intent.operation === 'image.generate' && references.length) throw new Error('文生图不能携带参考图，请选择参考或编辑操作')
  const resolved = resolveImageOutput({ service, operation: intent.operation, desiredCount: intent.desiredCount, params: intent.params, inputImages: references.filter(ref => ref.assetId !== intent.params.maskAssetId).length, config })
  if (intent.configRevision !== resolved.configRevision) throw new Error('绘图连接、型号或限制已变化，请重新确认参数')
  const preparedParams = imageCountParams(service, resolved, { ...mergeImageParameters(withoutImageCountParams(service.defaults ?? {}), intent.params), prompt: input.feedback })
  if (Object.hasOwn(FILE_SERVICE_ADAPTER_PARAM_SCHEMAS, service.adapter)) validateFileServiceAdapterParams(service.adapter, preparedParams, resolved.model)
  const round: DrawingRound = { roundId: randomUUID(), taskId: reuseTask ? intent.taskId! : randomUUID(), sourceMessageId: input.messageId, feedback: input.feedback, intent: structuredClone(intent),
    inputAssets: references, referencesResolved: intent.operation === 'image.generate' || references.length > 0,
    imageCount: resolved.count, imageConfigRevision: resolved.configRevision, imageModel: resolved.imageModel, adapter: service.adapter, createdAt: Date.now(), candidates: [] }
  db().transaction(() => {
    if (!reuseTask) db().prepare('INSERT INTO drawing_tasks(task_id,owner_id,chat_id,created_at) VALUES (?,?,?,?)').run(round.taskId, input.ownerId, input.chatId, round.createdAt)
    db().prepare('INSERT INTO drawing_rounds(round_id,task_id,input_id,message_id,data_json) VALUES (?,?,?,?,?)').run(round.roundId, round.taskId, input.inputId, input.messageId, JSON.stringify(round))
    getAssetStore().reference(references.map((ref, index) => ({ type: 'asset', partId: `${round.roundId}:${index}`, usage: 'content', ...ref,
      variant: getAssetStore().get(ref.assetId, access, ref.assetVersionId).transform?.variant ?? 'original' })), access, 'operation', round.roundId)
  })()
  return round
}
export function drawingRoundForInput(chatId: string, input: UserInputEntry): DrawingRound | undefined {
  const row = db().prepare('SELECT round_id FROM drawing_rounds WHERE input_id = ? OR message_id = ?').get(input.inputId ?? '', input.messageId ?? '') as { round_id: string } | undefined
  if (row) {
    const round = getDrawingRound(row.round_id)
    const task = db().prepare('SELECT chat_id FROM drawing_tasks WHERE task_id = ?').get(round.taskId) as { chat_id: string }
    if (chatId !== task.chat_id && chatId !== round.delegatedChatId) throw new Error('绘图输入不属于当前会话')
    updateChatMetadata(chatId, { drawingRoundId: row.round_id }); return round
  }
  const chat = getChat(chatId)
  const metadata = JSON.parse(chat?.metadata ?? '{}')
  if ((input.inputId || input.messageId) && (input.role === undefined || input.role === 'user') && (!chat?.parent_chat_id || input.commandId)) {
    updateChatMetadata(chatId, { drawingRoundId: null }); return
  }
  if (typeof metadata.drawingRoundId === 'string') return getDrawingRound(metadata.drawingRoundId)
}
export function drawingRoundFromView(view?: Readonly<IngressRequestView>): DrawingRound | undefined {
  const context = view?.contexts.find(item => item.ownerId === 'drawing' && item.key === 'round')
  if (!context) return
  return getDrawingRound(JSON.parse(context.content).roundId)
}
export function drawingModelContext(round: DrawingRound): string {
  const task = db().prepare('SELECT chat_id,owner_id FROM drawing_tasks WHERE task_id = ?').get(round.taskId) as { chat_id: string; owner_id: string }
  const history = listDrawingTasks(task.chat_id, task.owner_id).map(task => ({ taskId: task.taskId,
    rounds: task.rounds.map(round => ({ roundId: round.roundId, feedback: round.feedback, candidates: round.candidates })) }))
  return JSON.stringify({ instruction: '这是用户明确提交的绘图轮。按所选服务、操作、参数、固定图片版本执行一次原生生成；禁止拆单、并行、另派多名角色或不足补图。返回后等待用户选图或反馈，不自行再生成。自然语言与参数冲突时先向用户确认，不自行改参数。没有用户点击的来源图时，由你理解指代，通过文件查询取得明确的固定版本，必要时以 drawingSourceCandidateId 指定候选，无法确定则提问。referencesResolved=false 表示尚待你明确输入，不能无图编辑。', ...round, history })
}
export function assertDrawingExecution(roundId: string, input: { ownerId: string; chatId?: string; serviceId: string; operation: string; desiredCount?: number; drawingSourceCandidateId?: string; params: Record<string, unknown>; assets: Array<{ assetId: string; assetVersionId: string }> }): DrawingRound {
  const round = getDrawingRound(roundId)
  const row = db().prepare('SELECT chat_id FROM drawing_tasks WHERE task_id = ?').get(round.taskId) as { chat_id: string }
  if (input.chatId !== row.chat_id && input.chatId !== round.delegatedChatId) throw new Error('此会话未获本轮绘图执行权')
  if (round.intent.roleId) {
    const config = captureRuntimeConfig()
    const name = getChatType(input.chatId!)
    if (name !== round.intent.roleId && (!name || config.roles?.[name]?.id !== round.intent.roleId)) throw new Error('本轮须由用户选定的绘图角色执行')
  }
  if (round.intent.serviceId !== input.serviceId || round.intent.operation !== input.operation) throw new Error('工具不能改变用户已确认的绘图服务或操作')
  if (input.desiredCount !== undefined && input.desiredCount !== round.intent.desiredCount) throw new Error('工具不能改写本轮已确认的张数')
  const requested = requestedImageCount(input.params)
  if (requested !== undefined && requested !== round.imageCount.effectiveCount) throw new Error('工具数量参数与本轮已确认的有效张数不同')
  for (const [key, value] of Object.entries(withoutImageCountParams(input.params))) {
    if (key === 'prompt') continue
    if (stable(value) !== stable(round.intent.params[key])) throw new Error(`工具不能改写本轮已确认的参数：${key}`)
  }
  if (round.referencesResolved !== false) {
    if (input.assets.length && stable(input.assets) !== stable(round.inputAssets)) throw new Error('工具不能改换本轮已确认的图片版本')
    if (input.drawingSourceCandidateId && input.drawingSourceCandidateId !== round.intent.sourceCandidateId) throw new Error('工具不能改变已选候选图')
  } else {
    const access = fileAccessForChat(row.chat_id, input.ownerId)
    const references = input.assets.map(ref => {
      const asset = getAssetStore().get(ref.assetId, access, ref.assetVersionId)
      if (asset.kind !== 'image' || asset.availability !== 'available') throw new Error('参考图缺失或不是可读图片')
      return { assetId: asset.id, assetVersionId: asset.versionId }
    })
    if (!references.length) throw new Error('请由模型明确历史图片的固定版本；不能无图编辑，不能由程序自动选图')
    if (input.drawingSourceCandidateId) {
      if (captureRuntimeConfig().file_services?.[input.serviceId]?.adapter === 'minimax-images') throw new Error('MiniMax 人物参考不能用于通用候选图修改')
      const task = listDrawingTasks(row.chat_id, input.ownerId).find(task => task.rounds.some(round => round.candidates.some(candidate => candidate.candidateId === input.drawingSourceCandidateId)))
      if (!task) throw new Error('来源候选不属于当前可访问绘图记录')
      const selected = findCandidate(task, input.drawingSourceCandidateId)
      if (!references.some(ref => ref.assetId === selected.assetId && ref.assetVersionId === selected.assetVersionId)) throw new Error('本次输入未包含明确选定的候选版本')
      round.intent.sourceCandidateId = selected.candidateId
      round.intent.taskId = task.taskId
    }
    round.inputAssets = references
    round.referencesResolved = true
    const config = captureRuntimeConfig()
    const service = config.file_services![input.serviceId]!
    round.imageCount = resolveImageOutput({ service, operation: round.intent.operation, desiredCount: round.intent.desiredCount,
      params: round.intent.params, inputImages: references.filter(ref => ref.assetId !== round.intent.params.maskAssetId).length, config }).count
  }
  return round
}
export function claimDrawingOperation(roundId: string, operationId: string, resolved?: DrawingRound) {
  const round = resolved ?? getDrawingRound(roundId)
  if (db().prepare('UPDATE drawing_rounds SET operation_id = ?, data_json = ? WHERE round_id = ? AND operation_id IS NULL').run(operationId, JSON.stringify(round), roundId).changes !== 1)
    throw new Error('本轮已经执行或正在执行一次生成；不足不会自动补图，请等待用户提交新一轮')
}
/** 子会话清理后仍可查询已有候选；私有续接不放入公开绘图记录。 */
export function recordDrawingOperation(operation: FileOperationRecord, connectionRevision?: string) {
  const row = db().prepare('SELECT round_id FROM drawing_rounds WHERE operation_id = ?').get(operation.operationId) as { round_id: string } | undefined
  if (!row) return
  const round = getDrawingRound(row.round_id)
  const { providerContinuation: _private, ...publicOperation } = operation
  round.operation = publicOperation
  db().prepare('UPDATE drawing_rounds SET data_json = ? WHERE round_id = ?').run(JSON.stringify(round), round.roundId)
  if (operation.providerContinuation && connectionRevision) db().prepare('INSERT OR REPLACE INTO drawing_continuations(round_id,connection_revision,continuation_json) VALUES (?,?,?)')
    .run(round.roundId, connectionRevision, JSON.stringify(operation.providerContinuation))
}

export function drawingContinuation(round: DrawingRound, service: NonNullable<ReturnType<typeof captureRuntimeConfig>['file_services']>[string], config = captureRuntimeConfig()): Record<string, unknown> | undefined {
  if (!round.intent.sourceCandidateId || !round.intent.taskId) return
  const selectedRoundId = round.intent.sourceCandidateId.slice(0, round.intent.sourceCandidateId.indexOf(':'))
  const origin = getDrawingRound(selectedRoundId)
  const operation = operationForRound(origin)
  const selected = candidates(origin, operation).find(candidate => candidate.candidateId === round.intent.sourceCandidateId)
  if (!selected || !round.inputAssets.some(ref => ref.assetId === selected.assetId && ref.assetVersionId === selected.assetVersionId)) throw new Error('续接来源不匹配选定候选')
  // 多个最终图没有可精确指定的私有分支时，显式本地文件是唯一合法修改对象。
  if (candidates(origin, operation).length !== 1) return
  const stored = db().prepare('SELECT connection_revision,continuation_json FROM drawing_continuations WHERE round_id = ?').get(origin.roundId) as { connection_revision: string; continuation_json: string } | undefined
  const brain = service.connection.brainRef ? config.llm.brain[service.connection.brainRef] : undefined
  if (!stored || stored.connection_revision !== imageRevision({ service, brain }) || origin.imageModel !== round.imageModel) return
  const continuation = JSON.parse(stored.continuation_json)
  // Gemini 的完整私有历史计入预算；超限时使用已选文件重建合法参考请求。
  let images = round.inputAssets.length, bytes = 0
  for (const content of continuation.contents ?? []) for (const part of content.parts ?? []) {
    if (part.inlineData?.data) { images++; bytes += Buffer.byteLength(part.inlineData.data, 'base64') }
  }
  const owner = db().prepare('SELECT chat_id,owner_id FROM drawing_tasks WHERE task_id = ?').get(round.taskId) as { chat_id: string; owner_id: string }
  const access = fileAccessForChat(owner.chat_id, owner.owner_id)
  if (continuation.responseId) {
    let current: DrawingRound | undefined = origin
    const visited = new Set<string>()
    while (current && !visited.has(current.roundId)) {
      visited.add(current.roundId)
      const refs = [...current.inputAssets, ...candidates(current, operationForRound(current))]
      for (const ref of refs) { images++; bytes += getAssetStore().get(ref.assetId, access, ref.assetVersionId).sizeBytes }
      const source: string | undefined = current.intent.sourceCandidateId
      current = source ? getDrawingRound(source.slice(0, source.indexOf(':'))) : undefined
    }
  }
  for (const ref of round.inputAssets) bytes += getAssetStore().get(ref.assetId, access, ref.assetVersionId).sizeBytes
  if (images > (config.files?.context?.maxAssets ?? 10) || bytes > (config.files?.context?.maxBinaryBytes ?? 16 * 1024 * 1024)) return
  return continuation
}
export function attachDrawingOutputs(roundId: string, parts: MessagePart[], ownerId: string) {
  const round = getDrawingRound(roundId)
  const row = db().prepare('SELECT chat_id FROM drawing_tasks WHERE task_id = ?').get(round.taskId) as { chat_id: string }
  getAssetStore().attachOwned(parts.filter(part => part.type === 'asset'), fileAccessForChat(row.chat_id, ownerId), 'operation', roundId)
}
export function grantDrawingInputs(round: DrawingRound, chatId: string, ownerId: string) {
  if (round.delegatedChatId !== chatId) return
  const task = db().prepare('SELECT chat_id FROM drawing_tasks WHERE task_id = ?').get(round.taskId) as { chat_id: string }
  const access = fileAccessForChat(task.chat_id, ownerId)
  const parts: MessagePart[] = round.inputAssets.map((ref, index) => ({ ...ref, type: 'asset', partId: `${round.roundId}:${index}`, usage: 'content',
    variant: getAssetStore().get(ref.assetId, access, ref.assetVersionId).transform?.variant ?? 'original' }))
  getAssetStore().grantToChat(parts, access, chatId)
}
export function assertDrawingDelegation(roundId: string, parentChatId: string, roleName: string) {
  const round = getDrawingRound(roundId)
  const task = db().prepare('SELECT chat_id FROM drawing_tasks WHERE task_id = ?').get(round.taskId) as { chat_id: string }
  if (round.delegatedChatId || round.operationId || parentChatId !== task.chat_id) throw new Error('同一绘图批次只允许一名执行角色，不能再次分派或拆单')
  const role = captureRuntimeConfig().roles?.[roleName]
  if (round.intent.roleId && roleName !== round.intent.roleId && role?.id !== round.intent.roleId) throw new Error('不能更换用户选定的绘图角色')
}
export function bindDrawingDelegate(roundId: string, childChatId: string) {
  const round = getDrawingRound(roundId)
  round.delegatedChatId = childChatId
  db().prepare('UPDATE drawing_rounds SET data_json = ? WHERE round_id = ?').run(JSON.stringify(round), roundId)
  updateChatMetadata(childChatId, { drawingRoundId: roundId })
}
export async function finalizeDrawing(input: { ownerId: string; chatId: string; taskId: string; candidateId: string; expectedSelectionRevision: number; requestId: string }): Promise<DrawingTask> {
  const task = getDrawingTask(input.taskId, input.chatId, input.ownerId)
  const fingerprint = createHash('sha256').update(stable(input)).digest('hex')
  const prior = db().prepare('SELECT fingerprint,result_json FROM drawing_finalizations WHERE owner_id = ? AND request_id = ?').get(input.ownerId, input.requestId) as { fingerprint: string; result_json: string } | undefined
  if (prior) { if (prior.fingerprint !== fingerprint) throw new Error('定稿请求标识已用于不同选择'); return JSON.parse(prior.result_json) }
  const selected = findCandidate(task, input.candidateId)
  await getAssetStore().readChunk(selected.assetId, fileAccessForChat(input.chatId, input.ownerId), selected.assetVersionId, 0)
  return db().transaction(() => {
    const task = getDrawingTask(input.taskId, input.chatId, input.ownerId)
    const fingerprint = createHash('sha256').update(stable(input)).digest('hex')
    const prior = db().prepare('SELECT fingerprint,result_json FROM drawing_finalizations WHERE owner_id = ? AND request_id = ?').get(input.ownerId, input.requestId) as { fingerprint: string; result_json: string } | undefined
    if (prior) { if (prior.fingerprint !== fingerprint) throw new Error('定稿请求标识已用于不同选择'); return JSON.parse(prior.result_json) }
    findCandidate(task, input.candidateId)
    if (task.selectionRevision !== input.expectedSelectionRevision) throw Object.assign(new Error('另一窗口已改变定稿，请刷新后重新选择'), { status: 409 })
    db().prepare('UPDATE drawing_tasks SET final_candidate_id = ?, selection_revision = selection_revision + 1 WHERE task_id = ?').run(input.candidateId, input.taskId)
    const result = getDrawingTask(input.taskId, input.chatId, input.ownerId)
    db().prepare('INSERT INTO drawing_finalizations(owner_id,request_id,fingerprint,result_json,task_id) VALUES (?,?,?,?,?)').run(input.ownerId, input.requestId, fingerprint, JSON.stringify(result), input.taskId)
    return result
  })()
}
import { mergeImageParameters } from '@chery/protocol'
