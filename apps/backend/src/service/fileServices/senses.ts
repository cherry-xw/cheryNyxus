import { z } from 'zod'
import { buildFileServiceToolName } from '@chery/protocol'
import { sense } from '@/core/sense'
import { SupervisionLevel } from '@/core/config'
import { captureRuntimeConfig } from '@/utils/config.js'
import { fileAccessForChat } from '../media/access.js'
import { runFileOperation, fileOperationText, getFileOperation } from './operations.js'
import { resolveChatFileCapability } from './runtime.js'
import { imageRevision } from '../config/impact.js'

export function buildFileServiceSenses(config = captureRuntimeConfig()) {
  return Object.entries(config.file_services ?? {}).flatMap(([id, service]) => service.enabled === false ? [] : service.operations.map(operation => {
    const name = buildFileServiceToolName(id, operation)
    return sense(name, `${service.name}：${operation}。输入与输出使用固定版本的文件引用；调用可能产生服务费用。`, z.object({
      prompt: z.string().min(1), params: z.record(z.string(), z.unknown()).optional(),
      assets: z.array(z.object({ assetId: z.string().min(1), assetVersionId: z.string().min(1) }).strict()).default([]),
      requestId: z.string().min(1).optional(),
      previousOperationId: z.string().min(1).optional(),
      requireInspection: z.boolean().optional().describe('用户明确要求检查生成结果时设为 true；保存成功不等于检查通过'),
    }).strict(), async (input, _shared, ctx) => {
      if (!ctx?.chatId) throw new Error('文件工具需要会话上下文')
      const access = fileAccessForChat(ctx.chatId)
      const resolution = resolveChatFileCapability(ctx.chatId, operation)
      if (resolution.mode === 'disabled' || resolution.reasonCode === 'capability.disabled') throw new Error('角色已禁用此文件操作')
      const previous = input.previousOperationId ? getFileOperation(input.previousOperationId, access.ownerId, ctx.chatId) : undefined
      // 供应商续接信息只用于原工具及同一配置；换模型后由显式文件输入重建请求。
      const continuation = previous && previous.targetId === buildFileServiceToolName(id, previous.operation) && previous.configRevision === imageRevision(captureRuntimeConfig())
        ? previous.providerContinuation : undefined
      const record = await runFileOperation({ ownerId: access.ownerId, chatId: ctx.chatId, serviceId: id, operation,
        params: { ...input.params, prompt: input.prompt }, assets: input.assets, requireInspection: input.requireInspection, requestId: input.requestId ?? ctx.operationId ?? ctx.messageId ?? '', signal: ctx.signal, requestView: ctx.requestView, sourceCallId: ctx.messageId, enforceRolePolicy: true,
        ...(continuation ? { providerContinuation: continuation } : {}) })
      return { content: fileOperationText(record), parts: record.outputParts, outputAssetIds: record.outputAssetIds, fileOperations: [record], operationId: record.operationId,
          ...(record.executionStatus !== 'succeeded' || record.deliveryStatus !== 'saved' ? { status: 'provider_error' as const } : {}) }
    }, SupervisionLevel.smart, { operations: [operation], mappings: [{ operation, transferMode: 'asset-id', inputAssetField: 'assets', questionField: 'prompt' }] })
  }))
}
