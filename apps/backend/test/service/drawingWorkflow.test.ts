import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DrawingIntent, MessagePart, AssetRecord } from '@chery/protocol'
import config from '@/utils/config.js'
import { createChat, deleteChat } from '@/db/chat.js'
import { getSoulDb } from '@/db/index.js'
import { getAssetStore } from '@/service/media/store.js'
import { fileAccessForChat } from '@/service/media/access.js'
import { resolveImageOutput } from '@/service/fileServices/imageOutput.js'
import { runFileOperation, recoverFileOperations, getFileOperation } from '@/service/fileServices/operations.js'
import { handleFileServiceHttp } from '@/service/fileServices/http.js'
import { fileOperationSense } from '@/service/fileServices/assetSenses.js'
import { createDrawingRound, getDrawingTask, finalizeDrawing, assertDrawingDelegation, bindDrawingDelegate, drawingContinuation } from '@/service/fileServices/drawings.js'
import { handleChatInputSubmit } from '@/service/chat/input.js'
import { listDrawingTasks, drawingRoundForInput } from '@/service/fileServices/drawings.js'
import { findPendingInput } from '@/db/pendingInput.js'
import { requestSchemas } from '@/service/message/schemas.js'
import { responseSchemas } from '@/service/message/responseSchemas.js'
import { Method } from '@chery/protocol'

const inputRuntime = vi.hoisted(() => ({ running: false, enqueue: vi.fn(), send: vi.fn(async function* () {}) }))
vi.mock('@/service/chat/runtime.js', async original => ({
  ...await original<typeof import('@/service/chat/runtime.js')>(),
  ensureChat: async () => ({ isRunning: () => inputRuntime.running, enqueueInput: inputRuntime.enqueue, removeInput: vi.fn() }),
}))
vi.mock('@/service/chat/send.js', () => ({ handleChatSend: inputRuntime.send }))

vi.mock('@/service/fileServices/runtime.js', async () => ({
  fileCapabilityContext: () => ({ config: (awaitConfig()), roleName: 'artist' }),
  resolveChatFileCapability: () => ({ availability: 'available', mode: 'auto' }),
  assertFileServiceRoleAllowed: vi.fn(),
}))
vi.mock('@/service/fileServices/capabilityResolver.js', () => ({ resolveFileCapability: () => ({ availability: 'available' }) }))
function awaitConfig() { return config }
const originalServices = config.file_services
const ownerId = 'drawing-owner'
const serviceId = 'drawing-test'
let chatId: string
const children: string[] = []
// 只有文件格式签名和普通文字，不包含可解码图片；测试不检查图片内容。
const fixture = (value: string) => Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from(value)]).toString('base64')
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const fetcher = vi.fn()
const refPart = (asset: AssetRecord): MessagePart => ({ type: 'asset', partId: randomUUID(), assetId: asset.id, assetVersionId: asset.versionId, variant: 'original', usage: 'content' })
function intent(extra: Partial<DrawingIntent> = {}): DrawingIntent {
  const base = { serviceId, operation: 'image.generate' as const, desiredCount: 3, params: {}, ...extra }
  return { ...base, configRevision: resolveImageOutput({ service: config.file_services![serviceId]!, operation: base.operation, desiredCount: base.desiredCount, params: base.params }).configRevision }
}
function round(extra: Partial<DrawingIntent> = {}, parts: MessagePart[] = []) {
  const access = fileAccessForChat(chatId, ownerId)
  if (parts.length) getAssetStore().attachOwned(parts, access, 'message', randomUUID())
  return createDrawingRound({ ownerId, chatId, inputId: randomUUID(), messageId: randomUUID(), feedback: '明确的用户反馈', intent: intent(extra), parts })
}
function run(drawing: ReturnType<typeof round>, extra: Partial<Parameters<typeof runFileOperation>[0]> = {}) {
  return runFileOperation({ ownerId, chatId, serviceId, operation: drawing.intent.operation, drawingRoundId: drawing.roundId,
    requestId: randomUUID(), params: { prompt: '明确的用户反馈' }, assets: [], ...extra })
}
async function http(url: string, body?: unknown, identity = ownerId) {
  const req = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), { url, method: body ? 'POST' : 'GET', headers: {} }) as IncomingMessage
  let status = 0, response: unknown
  const res = { writeHead: (value: number) => { status = value }, end: (value: string) => { response = JSON.parse(value) } } as ServerResponse
  expect(await handleFileServiceHttp(req, res, identity)).toBe(true)
  return { status, response }
}
beforeEach(() => {
  inputRuntime.running = false; inputRuntime.enqueue.mockReset(); inputRuntime.enqueue.mockImplementation((content, meta) => ({ content, ...meta })); inputRuntime.send.mockClear()
  fetcher.mockReset(); fetcher.mockImplementation(async () => json({ data: [{ b64_json: fixture('one') }, { b64_json: fixture('two') }] }))
  vi.stubGlobal('fetch', fetcher)
  chatId = randomUUID(); createChat(chatId, { fileOwnerId: ownerId })
  config.file_services = { [serviceId]: { name: '离线绘图', enabled: true, adapter: 'openai-images',
    connection: { baseUrl: 'https://provider.example', model: 'gpt-image-1', keyRef: 'offline-secret',
      capabilities: { imageOutput: { 'image.generate': { nativeMultiImage: 'supported', countControl: 'requested', maxImagesPerRequest: 10 },
        'image.edit': { nativeMultiImage: 'supported', countControl: 'requested', maxImagesPerRequest: 10 } } } },
    operations: ['image.generate', 'image.edit'] } }
})
afterEach(() => { children.splice(0).forEach(id => deleteChat(id)); deleteChat(chatId); config.file_services = originalServices; vi.unstubAllGlobals() })

describe('会话绘图单次操作与用户选择', () => {
  it.each([false, true])('绘图输入 ACK 丢失重发只保留同一轮和持久输入；running=%s', async running => {
    inputRuntime.running = running
    const input = { chatId, commandId: randomUUID(), clientMessageId: randomUUID(), messageId: randomUUID(), content: '提交绘图', drawing: intent() }
    const ctx = { requestId: randomUUID(), connectionId: 'offline-drawing-input', authenticatedUserId: ownerId }
    expect(requestSchemas[Method.CHAT_INPUT_SUBMIT].safeParse(input).success).toBe(true)
    const accepted = await handleChatInputSubmit(ctx, input)
    expect(accepted.state).toBe(running ? 'queued' : 'started')
    expect(responseSchemas[Method.CHAT_INPUT_SUBMIT].safeParse(accepted).success).toBe(true)
    expect(accepted.drawing).toBeDefined()
    expect(await handleChatInputSubmit({ ...ctx, requestId: randomUUID() }, input)).toEqual(accepted)
    await expect(handleChatInputSubmit(ctx, { ...input, drawing: { ...input.drawing, desiredCount: 4 } })).rejects.toThrow('commandId')
    expect(inputRuntime.enqueue).toHaveBeenCalledTimes(1)
    expect(inputRuntime.send).toHaveBeenCalledTimes(1)
    const tasks = listDrawingTasks(chatId, ownerId)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.rounds).toHaveLength(1)
    expect(findPendingInput(chatId, { inputId: accepted.inputId })).toMatchObject({ message_id: input.messageId, state: accepted.state })
    const adopted = drawingRoundForInput(chatId, { inputId: accepted.inputId, messageId: input.messageId, content: input.content, time: Date.now() })
    expect(adopted).toMatchObject({ roundId: accepted.drawing!.roundId, taskId: accepted.drawing!.taskId, intent: input.drawing })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('绘图配置变化时输入事务整体撤销；同请求标识修正后可提交', async () => {
    const input = { chatId, commandId: randomUUID(), clientMessageId: randomUUID(), messageId: randomUUID(), content: '提交绘图', drawing: intent() }
    const ctx = { requestId: randomUUID(), connectionId: 'offline-drawing-input', authenticatedUserId: ownerId }
    config.file_services![serviceId]!.connection.model = 'gpt-image-2'
    await expect(handleChatInputSubmit(ctx, input)).rejects.toThrow('已变化')
    expect(listDrawingTasks(chatId, ownerId)).toEqual([])
    expect(findPendingInput(chatId, { clientMessageId: input.clientMessageId })).toBeUndefined()
    expect(getSoulDb().prepare('SELECT 1 FROM request_journal WHERE request_id = ?').get(input.commandId)).toBeUndefined()
    expect(inputRuntime.enqueue).not.toHaveBeenCalled()
    const accepted = await handleChatInputSubmit(ctx, { ...input, drawing: intent() })
    expect(accepted.drawing).toBeDefined()
    expect(listDrawingTasks(chatId, ownerId)).toHaveLength(1)
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('单批只有一次原生请求；少返回保留候选，重复标识复用，不自动补图', async () => {
    const drawing = round()
    const requestId = randomUUID()
    const result = await run(drawing, { requestId })
    expect(JSON.parse(fetcher.mock.calls[0]![1].body).n).toBe(3)
    expect(result).toMatchObject({ executionStatus: 'partial', deliveryStatus: 'saved', receivedImageCount: 2, savedImageCount: 2 })
    expect(result.reportedFailedImageCount).toBeUndefined()
    expect(result.error?.message).toContain('未提供')
    expect((await run(drawing, { requestId })).operationId).toBe(result.operationId)
    await expect(run(drawing)).rejects.toThrow('本轮已经执行')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(getDrawingTask(drawing.taskId, chatId, ownerId).rounds[0]!.candidates).toHaveLength(2)
  })
  it('选中较早候选的固定版本，定稿与后续修改独立；冲突和重复请求不生成', async () => {
    const first = round(); await run(first)
    const task = getDrawingTask(first.taskId, chatId, ownerId)
    const selected = task.rounds[0]!.candidates[1]!
    const request = { ownerId, chatId, taskId: task.taskId, candidateId: selected.candidateId, expectedSelectionRevision: 0, requestId: randomUUID() }
    const finalized = await finalizeDrawing(request)
    expect((await finalizeDrawing(request)).selectionRevision).toBe(1)
    await expect(finalizeDrawing({ ...request, requestId: randomUUID(), candidateId: task.rounds[0]!.candidates[0]!.candidateId })).rejects.toMatchObject({ status: 409 })
    const asset = getAssetStore().get(selected.assetId, fileAccessForChat(chatId), selected.assetVersionId)
    const next = round({ taskId: task.taskId, sourceCandidateId: selected.candidateId, operation: 'image.edit' }, [refPart(asset)])
    await run(next)
    const form = fetcher.mock.calls[1]![1].body as FormData
    const image = form.get('image[]') as File
    expect(Buffer.from(await image.arrayBuffer()).toString('base64')).toBe(fixture('two'))
    const updated = getDrawingTask(task.taskId, chatId, ownerId)
    expect(updated.finalCandidateId).toBe(finalized.finalCandidateId)
    expect(updated.rounds).toHaveLength(2)
    expect(updated.rounds[1]!.inputAssets).toEqual([{ assetId: selected.assetId, assetVersionId: selected.assetVersionId }])
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('文字指代由模型提交明确候选，不要求点击，也不让程序自动选图', async () => {
    const first = round(); await run(first)
    const selected = getDrawingTask(first.taskId, chatId, ownerId).rounds[0]!.candidates[0]!
    const pending = round({ taskId: first.taskId, operation: 'image.edit' })
    expect(pending.referencesResolved).toBe(false)
    await expect(run(pending)).rejects.toThrow('模型明确')
    expect(fetcher).toHaveBeenCalledTimes(1)
    await run(pending, { assets: [{ assetId: selected.assetId, assetVersionId: selected.assetVersionId }], drawingSourceCandidateId: selected.candidateId })
    expect(getDrawingTask(first.taskId, chatId, ownerId).rounds[1]).toMatchObject({ referencesResolved: true, intent: { sourceCandidateId: selected.candidateId } })
  })
  it('禁止工具改张数和尺寸，禁止委派拆单；删除执行子会话后主会话候选可读', async () => {
    const drawing = round({ params: { size: '1024x1024' } })
    await expect(run(drawing, { desiredCount: 4 })).rejects.toThrow('不能改写')
    await expect(run(drawing, { params: { size: '1536x1024', prompt: '反馈' } })).rejects.toThrow('不能改写')
    const childId = randomUUID(); children.push(childId); createChat(childId, { fileOwnerId: ownerId }, chatId)
    assertDrawingDelegation(drawing.roundId, chatId, 'artist'); bindDrawingDelegate(drawing.roundId, childId)
    expect(() => assertDrawingDelegation(drawing.roundId, chatId, 'artist')).toThrow('一名执行角色')
    await run(drawing, { chatId: childId })
    deleteChat(childId); children.pop()
    const task = getDrawingTask(drawing.taskId, chatId, ownerId)
    expect(task.rounds[0]!.candidates).toHaveLength(2)
    const candidate = task.rounds[0]!.candidates[0]!
    expect((await getAssetStore().read(candidate.assetId, fileAccessForChat(chatId), candidate.assetVersionId)).data.length).toBeGreaterThan(0)
  })
  it('提交后配置变化在请求前拒绝；恢复中断操作不重新生成', async () => {
    const drawing = round()
    config.file_services![serviceId]!.connection.model = 'gpt-image-2'
    await expect(run(drawing)).rejects.toThrow('配置已变化')
    recoverFileOperations()
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('排队期间配置变化拒绝第二轮，不沿用旧数量或自动重新请求', async () => {
    config.file_services![serviceId]!.maxConcurrent = 1
    let finish!: (value: Response) => void
    fetcher.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve }))
    const first = round(), second = round()
    const running = run(first)
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    const queued = run(second)
    config.file_services = { [serviceId]: { ...config.file_services![serviceId]!, connection: {
      ...config.file_services![serviceId]!.connection, model: 'gpt-image-2',
    } } }
    finish(json({ data: [{ b64_json: fixture('first') }] })); await running
    const result = await queued
    expect(result).toMatchObject({ executionStatus: 'failed', error: { code: 'FILE_CONFIG_CHANGED' } })
    expect(result.error?.message).toContain('排队期间改变')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('重启恢复保留唯一操作和已保存候选，不补发或释放本轮执行权', async () => {
    const drawing = round(), record = await run(drawing)
    getSoulDb().prepare('UPDATE file_operations SET data_json = ? WHERE operation_id = ?').run(JSON.stringify({ ...record, executionStatus: 'running' }), record.operationId)
    recoverFileOperations()
    expect(getFileOperation(record.operationId, ownerId, chatId).executionStatus).toBe('result_unknown')
    expect(getDrawingTask(drawing.taskId, chatId, ownerId).rounds[0]!.candidates).toHaveLength(2)
    await expect(run(drawing)).rejects.toThrow('本轮已经执行')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('分支只继承明确选中的固定版本，不占用来源轮或改变来源定稿', async () => {
    const first = round(); await run(first)
    const task = getDrawingTask(first.taskId, chatId, ownerId), selected = task.rounds[0]!.candidates[1]!
    const branchId = randomUUID(); children.push(branchId)
    createChat(branchId, { fileOwnerId: ownerId, drawingSourceChatId: chatId })
    const access = fileAccessForChat(chatId, ownerId)
    const part = refPart(getAssetStore().get(selected.assetId, access, selected.assetVersionId))
    getAssetStore().grantToChat([part], access, branchId)
    const branchRound = createDrawingRound({ ownerId, chatId: branchId, inputId: randomUUID(), messageId: randomUUID(), feedback: '分支修改',
      intent: intent({ taskId: first.taskId, sourceCandidateId: selected.candidateId, operation: 'image.edit' }), parts: [part] })
    expect(branchRound.taskId).not.toBe(first.taskId)
    await run(branchRound, { chatId: branchId })
    expect(getDrawingTask(first.taskId, chatId, ownerId).rounds).toHaveLength(1)
    expect(getDrawingTask(branchRound.taskId, branchId, ownerId).rounds[0]!.inputAssets).toEqual([{ assetId: selected.assetId, assetVersionId: selected.assetVersionId }])
  })
  it('单图完整私有续接来自所选轮；跨连接和同批多个候选改用本地文件', async () => {
    config.file_services![serviceId] = { name: '离线 Gemini', enabled: true, adapter: 'google-gemini-image',
      connection: { baseUrl: 'https://provider.example', model: 'gemini-3.1-flash-image-preview', keyRef: 'offline-secret',
        capabilities: { imageOutput: { 'image.generate': { nativeMultiImage: 'unsupported', countControl: 'requested', maxImagesPerRequest: 1 }, 'image.edit': { nativeMultiImage: 'unsupported', countControl: 'requested', maxImagesPerRequest: 1 } } } }, operations: ['image.generate', 'image.edit'] }
    fetcher.mockImplementation(async () => json({ candidates: [{ content: { parts: [{ thought: true, text: 'private' },
      { thoughtSignature: 'opaque-signature', inlineData: { mimeType: 'image/png', data: fixture('source') } }] }, finishReason: 'STOP' }] }))
    const first = round(); const result = await run(first)
    const task = getDrawingTask(first.taskId, chatId, ownerId)
    expect(JSON.stringify(task)).not.toContain('opaque-signature')
    const lookup = await http(`/api/file-operations/${result.operationId}?chatId=${chatId}`)
    expect(lookup.status).toBe(200)
    expect(JSON.stringify(lookup.response)).not.toContain('opaque-signature')
    const list = await http('/api/file-operations/list', { chatId })
    expect(list.status).toBe(200)
    expect(JSON.stringify(list.response)).not.toContain('opaque-signature')
    expect(getFileOperation(result.operationId, ownerId, chatId).providerContinuation).toBeDefined()
    for (const action of ['get', 'list'] as const) {
      const visible = await fileOperationSense.executor.execute({ action, operationId: result.operationId }, new Map(), { chatId, messageId: 'query-operation' })
      expect(JSON.stringify(visible)).not.toContain('opaque-signature')
      expect(JSON.stringify(visible)).not.toContain('providerContinuation')
    }
    const selected = task.rounds[0]!.candidates[0]!
    const asset = getAssetStore().get(selected.assetId, fileAccessForChat(chatId), selected.assetVersionId)
    const next = round({ taskId: first.taskId, operation: 'image.edit', sourceCandidateId: selected.candidateId }, [refPart(asset)])
    expect(JSON.stringify(drawingContinuation(next, config.file_services![serviceId]!))).toContain('opaque-signature')
    await run(next)
    const body = JSON.parse(fetcher.mock.calls[1]![1].body)
    expect(body.contents[1].parts[1].thoughtSignature).toBe('opaque-signature')
    fetcher.mockImplementationOnce(async () => json({ candidates: [{ finishReason: 'STOP', content: { parts: [
      { thoughtSignature: 'batch-private', inlineData: { mimeType: 'image/png', data: fixture('batch-one') } },
      { inlineData: { mimeType: 'image/png', data: fixture('batch-two') } },
    ] } }] }))
    const batch = round(); await run(batch)
    const batchChoice = getDrawingTask(batch.taskId, chatId, ownerId).rounds[0]!.candidates[0]!
    const batchPart = refPart(getAssetStore().get(batchChoice.assetId, fileAccessForChat(chatId), batchChoice.assetVersionId))
    const isolated = round({ taskId: batch.taskId, operation: 'image.edit', sourceCandidateId: batchChoice.candidateId }, [batchPart])
    expect(drawingContinuation(isolated, config.file_services![serviceId]!)).toBeUndefined()
    config.file_services![serviceId]!.connection.keyRef = 'changed-identity'
    expect(drawingContinuation(next, config.file_services![serviceId]!)).toBeUndefined()
  })
  it('非所有者不能查询或定稿，缺失候选不能替换原定稿', async () => {
    const drawing = round(); await run(drawing)
    expect(() => getDrawingTask(drawing.taskId, chatId, 'another-owner')).toThrow('无权')
    await expect(finalizeDrawing({ ownerId, chatId, taskId: drawing.taskId, candidateId: 'not-a-candidate', expectedSelectionRevision: 0, requestId: randomUUID() })).rejects.toThrow('候选图不存在')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('记录和能力 HTTP 查询不生成；外来身份拒绝；定稿冲突返回 409', async () => {
    const drawing = round(); await run(drawing)
    const task = getDrawingTask(drawing.taskId, chatId, ownerId)
    expect((await http('/api/file-services/drawings', { chatId })).status).toBe(200)
    expect((await http('/api/file-services/drawings', { chatId }, 'foreign-owner')).status).toBe(400)
    expect((await http('/api/file-services/image-output', { serviceId, chatId, operation: 'image.generate', desiredCount: 6, params: {} })).status).toBe(200)
    const choice = { chatId, taskId: drawing.taskId, candidateId: task.rounds[0]!.candidates[0]!.candidateId, expectedSelectionRevision: 0, requestId: randomUUID() }
    expect((await http('/api/file-services/drawing-finalize', choice)).status).toBe(200)
    expect((await http('/api/file-services/drawing-finalize', choice)).status).toBe(200)
    expect((await http('/api/file-services/drawing-finalize', { ...choice, requestId: randomUUID() })).status).toBe(409)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
