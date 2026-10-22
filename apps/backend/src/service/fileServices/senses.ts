import { z } from 'zod'
import { buildFileServiceToolName, isImageOutputOperation } from '@chery/protocol'
import { sense } from '@/core/sense'
import { SupervisionLevel } from '@/core/config'
import { captureRuntimeConfig } from '@/utils/config.js'
import { fileAccessForChat } from '../media/access.js'
import { runFileOperation, fileOperationText, getFileOperation, publicFileOperation } from './operations.js'
import { resolveChatFileCapability } from './runtime.js'
import { imageRevision } from '../config/impact.js'
import { drawingRoundFromView } from './drawings.js'

export function buildFileServiceSenses(config = captureRuntimeConfig()) {
  return Object.entries(config.file_services ?? {}).flatMap(([id, service]) => service.enabled === false ? [] : service.operations.map(operation => {
    const name = buildFileServiceToolName(id, operation)
    return sense(name, `${service.name}：${operation}。输入与输出使用固定版本的文件引用；调用可能产生服务费用。`, z.object({
      prompt: z.string().min(1), params: z.record(z.string(), z.unknown()).optional(),
      desiredCount: z.number().int().positive().safe().optional().describe('本次期望张数；使用同一次原生生成，不可拆成多次凑数。省略使用全局默认。'),
      assets: z.array(z.object({ assetId: z.string().min(1), assetVersionId: z.string().min(1) }).strict()).default([]),
      requestId: z.string().min(1).optional(),
      previousOperationId: z.string().min(1).optional(),
      drawingSourceCandidateId: z.string().min(1).optional().describe('根据用户文字明确选中的历史候选身份；不能自行按最后一张推断。与 assets 中固定版本对应。'),
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
        drawingRoundId: isImageOutputOperation(operation) ? drawingRoundFromView(ctx.requestView)?.roundId : undefined,
        desiredCount: input.desiredCount,
        drawingSourceCandidateId: input.drawingSourceCandidateId,
        params: { ...input.params, prompt: input.prompt }, assets: input.assets, requireInspection: input.requireInspection, requestId: input.requestId ?? ctx.operationId ?? ctx.messageId ?? '', signal: ctx.signal, requestView: ctx.requestView, sourceCallId: ctx.messageId, enforceRolePolicy: true,
        ...(continuation ? { providerContinuation: continuation } : {}) })
      return { content: fileOperationText(record), parts: record.outputParts, outputAssetIds: record.outputAssetIds, fileOperations: [publicFileOperation(record)], operationId: record.operationId,
          ...(record.executionStatus !== 'succeeded' || record.deliveryStatus !== 'saved' ? { status: 'provider_error' as const } : {}) }
    }, SupervisionLevel.smart, { operations: [operation], mappings: [{ operation, transferMode: 'asset-id', inputAssetField: 'assets', questionField: 'prompt' }] })
  }))
}
