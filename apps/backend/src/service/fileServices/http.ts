import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { FILE_CAPABILITY_OPERATIONS, SettingsFileServiceSchema } from '@chery/protocol'
import { prepareRuntimeConfig, restoreRedactedSecrets, readRawConfig, type ConfigRaw } from '@/utils/config.js'
import { readBoundedBody, jsonResponse } from '../media/http.js'
import { fileAccessForChat } from '../media/access.js'
import { runFileOperation, getFileOperation, listFileOperations, cancelFileOperation, retryFileOperationSave, listTrialFileOperations, deleteTrialFileOperation } from './operations.js'
import { resolveChatFileCapabilities } from './runtime.js'

export async function handleFileServiceHttp(req: IncomingMessage, res: ServerResponse, ownerId: string): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (!url.pathname.startsWith('/api/file-services/') && !url.pathname.startsWith('/api/file-operations/')) return false
  try {
    if (url.pathname === '/api/file-services/resolve' && req.method === 'POST') {
      const data = z.object({ roleId: z.string().optional(), roleName: z.string().optional(), preset: z.string().optional(), chatId: z.string().optional(), draft: z.record(z.string(), z.unknown()).optional() }).strict().parse(JSON.parse((await readBoundedBody(req, 2 * 1024 * 1024)).toString()))
      if (data.chatId) fileAccessForChat(data.chatId, ownerId)
      const draft = data.draft ? prepareRuntimeConfig(restoreRedactedSecrets(data.draft as unknown as ConfigRaw, readRawConfig())).config : undefined
      jsonResponse(res, 200, { capabilities: resolveChatFileCapabilities(data.chatId, { roleId: data.roleId, roleName: data.roleName, preset: data.preset, ...(draft ? { config: draft } : {}) }) })
      return true
    }
    if (url.pathname === '/api/file-services/try' && req.method === 'POST') {
      const data = z.object({ serviceId: z.string().min(1), operation: z.enum(FILE_CAPABILITY_OPERATIONS), params: z.record(z.string(), z.unknown()),
        assets: z.array(z.object({ assetId: z.string().min(1), assetVersionId: z.string().min(1) }).strict()).max(10), requestId: z.string().min(1), chatId: z.string().optional(), service: SettingsFileServiceSchema.optional() }).strict().parse(JSON.parse((await readBoundedBody(req, 128 * 1024)).toString()))
      if (data.chatId) fileAccessForChat(data.chatId, ownerId)
      const serviceOverride = data.service ? prepareRuntimeConfig(restoreRedactedSecrets({ ...readRawConfig(), file_services: { ...readRawConfig().file_services, [data.serviceId]: data.service } }, readRawConfig())).config.file_services?.[data.serviceId] : undefined
      const { service: _service, ...request } = data
      jsonResponse(res, 202, await runFileOperation({ ...request, ownerId, ...(serviceOverride ? { serviceOverride } : {}) }, false))
      return true
    }
    const match = /^\/api\/file-operations\/([^/]+)(\/(cancel|retry))?$/.exec(url.pathname)
    if (match) {
      const chatId = url.searchParams.get('chatId') ?? undefined
      if (req.method === 'GET' && !match[3]) { jsonResponse(res, 200, getFileOperation(match[1]!, ownerId, chatId)); return true }
      if (req.method === 'DELETE' && !match[3]) { await deleteTrialFileOperation(match[1]!, ownerId); jsonResponse(res, 200, { deleted: true }); return true }
      if (req.method === 'POST' && match[3] === 'cancel') { jsonResponse(res, 200, cancelFileOperation(match[1]!, ownerId, chatId)); return true }
      if (req.method === 'POST' && match[3] === 'retry') {
        const data = z.object({ requestId: z.string().min(1), step: z.enum(['save', 'execute']) }).strict().parse(JSON.parse((await readBoundedBody(req, 8192)).toString()))
        if (data.step !== 'save') throw new Error('重新执行可能重复计费，请从试跑入口明确发起新请求')
        jsonResponse(res, 200, await retryFileOperationSave(match[1]!, ownerId, chatId))
        return true
      }
    }
    if (url.pathname === '/api/file-operations/list' && req.method === 'POST') {
      const data = z.union([z.object({ chatId: z.string().min(1) }).strict(), z.object({ serviceId: z.string().min(1) }).strict()]).parse(JSON.parse((await readBoundedBody(req, 8192)).toString()))
      jsonResponse(res, 200, { operations: 'chatId' in data ? listFileOperations(data.chatId, ownerId) : listTrialFileOperations(ownerId, data.serviceId) })
      return true
    }
    jsonResponse(res, 404, { error: { code: 'file.operation_not_found', message: '文件操作入口不存在' } })
  } catch (error) { jsonResponse(res, 400, { error: { code: 'file.operation_rejected', message: (error as Error).message } }) }
  return true
}
