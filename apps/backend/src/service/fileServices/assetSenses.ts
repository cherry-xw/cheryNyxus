import { z } from 'zod'
import { sense } from '@/core/sense'
import { SupervisionLevel } from '@/core/config'
import { getSoulDb } from '@/db/index.js'
import { getAssetStore } from '../media/store.js'
import { fileAccessForChat } from '../media/access.js'
import { getFileOperation, listFileOperations, retryFileOperationSave, cancelFileOperation, recordFileInspection, publicFileOperation } from './operations.js'
import { resolveChatFileCapabilities, resolveChatFileCapability } from './runtime.js'
import { listImageDescriptions, requestImageRead } from './imageContext.js'
import { reportWorkflow } from '@/core/middleware/workflowObservation.js'

export const assetListSense = sense('file_assets_list', '列出当前会话已授权文件的固定版本与可用状态；不读取文件内容。可用于重新引用较早的文件。', z.object({ offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(30) }).strict(), async (input, _shared, ctx) => {
  if (!ctx) throw new Error('文件列表需要会话')
  const access = fileAccessForChat(ctx.chatId)
  const refs = getSoulDb().prepare(`SELECT v.asset_id, v.id FROM asset_versions v JOIN assets a ON a.id = v.asset_id
    JOIN asset_chat_grants g ON g.asset_id = a.id WHERE g.chat_id = ? AND a.owner_id = ? ORDER BY v.created_at DESC LIMIT ? OFFSET ?`).all(ctx.chatId, access.ownerId, input.limit, input.offset) as { asset_id: string; id: string }[]
  return { content: JSON.stringify({ assets: refs.map(ref => getAssetStore().get(ref.asset_id, access, ref.id)), offset: input.offset, count: refs.length }) }
}, SupervisionLevel.auto)

export const assetReadSense = sense('file_asset_read', '按固定版本读取普通 UTF-8 文本的一段。不执行文件，不读取仅附文件内容；需要读取图片或文档时使用对应理解工具。', z.object({ assetId: z.string().min(1), assetVersionId: z.string().min(1), start: z.number().int().nonnegative().default(0), length: z.number().int().min(1).max(20000).default(20000) }).strict(), async (input, _shared, ctx) => {
  if (!ctx) throw new Error('读取文件需要会话')
  const { asset, data } = await getAssetStore().read(input.assetId, fileAccessForChat(ctx.chatId), input.assetVersionId)
  if (!asset.mimeType.startsWith('text/') && !['application/json', 'application/xml', 'application/javascript'].includes(asset.mimeType)) throw new Error('此入口只读取普通文本；其他格式需要对应理解工具')
  if (data.includes(0)) throw new Error('文件含有二进制内容，不能作为文本读取')
  const text = new TextDecoder('utf-8', { fatal: true }).decode(data)
  return { content: JSON.stringify({ assetId: asset.id, assetVersionId: asset.versionId, start: input.start, nextStart: Math.min(text.length, input.start + input.length), totalChars: text.length, untrustedContent: text.slice(input.start, input.start + input.length) }) }
}, SupervisionLevel.smart)

export const fileOperationSense = sense('file_operation', '查询、停止、重新保存或记录文件检查。重新保存不重新生成。record-inspection 需要读取全部输出固定版本的理解操作作为依据，不能用文字声明代替实际读取。', z.object({ action: z.enum(['list', 'get', 'cancel', 'retry-save', 'record-inspection']), operationId: z.string().optional(), inspectionOperationId: z.string().optional(), passed: z.boolean().optional(), summary: z.string().min(1).max(20000).optional() }).strict(), async (input, _shared, ctx) => {
  if (!ctx) throw new Error('文件操作需要会话')
  const access = fileAccessForChat(ctx.chatId)
  if (input.action === 'list') return { content: JSON.stringify(listFileOperations(ctx.chatId, access.ownerId).map(publicFileOperation)) }
  if (!input.operationId) throw new Error('此操作需要 operationId')
  if (input.action === 'record-inspection') {
    if (!input.inspectionOperationId || input.passed === undefined || !input.summary) throw new Error('记录检查需要 inspectionOperationId、passed 和 summary')
    const record = publicFileOperation(recordFileInspection(input.operationId, input.inspectionOperationId, input.passed, input.summary, access.ownerId, ctx.chatId))
    return { content: JSON.stringify(record), fileOperations: [record] }
  }
  const record = publicFileOperation(input.action === 'get' ? getFileOperation(input.operationId, access.ownerId, ctx.chatId) : input.action === 'cancel' ? cancelFileOperation(input.operationId, access.ownerId, ctx.chatId) : await retryFileOperationSave(input.operationId, access.ownerId, ctx.chatId))
  return { content: JSON.stringify(record), parts: record.outputParts, outputAssetIds: record.outputAssetIds, fileOperations: [record] }
}, SupervisionLevel.smart)

export const fileCapabilitiesSense = sense('file_capabilities', '检查指定角色或当前会话的文件操作能力、限制与缺失原因。不发起模型请求，不把配置检查当作真实调用验证。', z.object({ roleId: z.string().optional(), roleName: z.string().optional(), preset: z.string().optional() }).strict(), async (input, _shared, ctx) => ({ content: JSON.stringify(resolveChatFileCapabilities(ctx?.chatId, input)) }), SupervisionLevel.auto)

export const imageFindSense = sense('file_images_find', '查找当前会话有权访问的图片描述和固定版本。描述是先前信息，不代表本次看过图片。需要视觉细节时调用 file_image_read；不能凭描述猜细节。', z.object({ query: z.string().max(200).default(''), limit: z.number().int().min(1).max(50).default(20) }).strict(), async (input, _shared, ctx) => {
  if (!ctx) throw new Error('图片查询需要会话')
  reportWorkflow(ctx.chatId, { activeNodeId: 'tools', phaseLabel: '查找历史图片' })
  return { content: JSON.stringify({ descriptions: listImageDescriptions(ctx.chatId, input.query, input.limit), hint: '没有描述时可用 file_assets_list 查找图片；多个候选不明确时请用户选择。' }) }
}, SupervisionLevel.auto)

export const imageReadSense = sense('file_image_read', '明确重新读取当前会话图片。必须提供确切资产 ID 和固定版本；可联合读取多图。工具成功只表示已安排，随后模型请求才实际采用图片或理解观察。返回失败时不得假装已经看图。', z.object({ assets: z.array(z.object({ assetId: z.string().min(1), assetVersionId: z.string().min(1) }).strict()).min(1).max(10) }).strict(), async (input, _shared, ctx) => {
  if (!ctx?.messageId) throw new Error('图片读取需要会话与工具调用标识')
  const capability = resolveChatFileCapability(ctx.chatId, 'image.inspect')
  if (!['available', 'requires_approval'].includes(capability.availability) || capability.mode === 'role') throw new Error(`此角色不能直接重新读图：${capability.reason}`)
  ctx.signal?.throwIfAborted()
  reportWorkflow(ctx.chatId, { activeNodeId: 'tools', phaseLabel: '重新读取图片' })
  requestImageRead(ctx.chatId, ctx.messageId, input.assets)
  return { content: JSON.stringify({ status: 'image_read_prepared', assets: input.assets, message: '重新读图请求已登记，系统会在本轮后续模型请求中检查权限、格式和大小，并附上原图或提供理解工具的文字观察。请以当前请求的文件输入状态和实际图片/观察为准继续回答；若已附图，直接查看，不要因本条准备状态要求用户再发一轮。只有本条文字而没有图片或观察时，不得声称已看图。' }) }
}, SupervisionLevel.smart)

export const fileAssetSenses = [assetListSense, assetReadSense, fileOperationSense, fileCapabilitiesSense, imageFindSense, imageReadSense]
