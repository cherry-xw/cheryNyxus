import { randomUUID } from 'node:crypto'
import type { FileCapabilityOperation, SenseFileOperationMapping } from '@chery/plugin-api'
import type { AssetRecord, MessageAssetPart } from '@chery/protocol'
import type { MiddlewareContext, SenseEntry } from '@/core/middleware/types.js'
import { SupervisionLevel } from '@/core/config.js'
import { executeSenseWithControl, isSafeSenseCall } from '@/core/sense/index.js'
import { authorizeToolCall, compileRoleSecurity } from '@/core/security/index.js'
import { getChatWorkspace } from '@/db/chat.js'
import { getSense, getSenseOrigin } from '@/core/sense/senseRegistry.js'
import { dispatch } from '@/agent/hooks/index.js'
import { requestHookContext, requestSignal } from '@/agent/hooks/request.js'
import { checkCheryGuard } from '@/utils/pathGuard.js'
import config from '@/utils/config.js'
import { ClassifiedError } from '@/utils/error.js'

export interface FileInputTool {
  name: string
  entry: SenseEntry
  mapping: SenseFileOperationMapping
}

export function fileInputError(code: string, message: string): Error {
  // 不让聊天请求重试重新执行付费文件操作；单项重试由文件操作入口负责。
  return Object.assign(new ClassifiedError({ message, userMessage: message, category: 'validation', source: 'chat' }), { code })
}

/** 声明操作并提供完整映射才可前置调用，旧 accepts/preprocess 不构成执行契约。 */
export function fileInputTools(ctx: MiddlewareContext, operation: FileCapabilityOperation): FileInputTool[] {
  const tools: FileInputTool[] = []
  for (const [name, entry] of ctx.runtime?.senseTable ?? []) {
    const origin = getSenseOrigin(name)
    if (origin && (!getSense(name) || origin.available?.() === false)) continue
    if (!entry.capabilities?.operations?.includes(operation)) continue
    const mappings = entry.capabilities.mappings?.filter((m) => m.operation === operation) ?? []
    if (mappings.length !== 1) continue
    const mapping = mappings[0]!
    if (!mapping.inputAssetField || !mapping.questionField || !mapping.transferMode) continue
    // 不向工具暴露仓库路径，也不把远程工具当作本地资产仓库。
    if (mapping.transferMode === 'local-path') continue
    if (name.startsWith('mcp__') && mapping.transferMode === 'asset-id') continue
    tools.push({ name, entry, mapping })
  }
  return tools
}

export interface FileToolInput {
  part: MessageAssetPart
  asset: AssetRecord
  data?: Buffer
}

export function mapFileToolInput(tool: FileInputTool, files: FileToolInput[], question: string): Record<string, unknown> {
  const { mapping } = tool
  const inputs = files.map(({ part, asset, data }) => {
    if (mapping.transferMode === 'asset-id') return {
      assetId: part.assetId, assetVersionId: part.assetVersionId,
    }
    if (!data) throw fileInputError('asset.unavailable', '文件内容尚未读取')
    return mapping.transferMode === 'data-url'
      ? `data:${asset.mimeType};base64,${data.toString('base64')}`
      : data.toString('base64')
  })
  return {
    ...mapping.constantParams,
    [mapping.inputAssetField!]: inputs,
    [mapping.questionField!]: question,
  }
}

/** 与普通工具使用同一授权和受控执行入口；前置入口不能偷偷批准 smart/manual。 */
export async function prepareFileInputTool(ctx: MiddlewareContext, tool: FileInputTool, input: Record<string, unknown>) {
  const runtime = ctx.runtime!
  const signal = requestSignal(ctx)
  const workspace = runtime.acceptance?.workspaceRoot ?? getChatWorkspace(ctx.soul.chatId)
  const authorize = (args: Record<string, unknown>) => {
    const roleType = runtime.roleSecurity?.roleType
    return authorizeToolCall({
      security: compileRoleSecurity(roleType, roleType ? config.roles?.[roleType] : undefined),
      name: tool.name, args, workspace,
      configuredLevel: tool.entry.supervisionLevel,
      legacySafe: tool.entry.supervisionLevel === SupervisionLevel.smart
        ? isSafeSenseCall(runtime.sensitivityRules, tool.name, args) : undefined,
      acceptance: runtime.acceptance, requestIdentity: ctx.requestView?.identity,
    })
  }
  const check = (args: Record<string, unknown>) => {
    signal?.throwIfAborted()
    ctx.requestExecution?.validate()
    if (runtime.senseTable.get(tool.name) !== tool.entry)
      throw fileInputError('capability.unavailable', '文件工具配置已改变')
    const origin = getSenseOrigin(tool.name)
    if (origin && (!getSense(tool.name) || origin.available?.() === false))
      throw fileInputError('capability.unavailable', '文件工具已停用')
    if (checkCheryGuard(tool.name, args)) throw fileInputError('capability.unavailable', '文件工具参数未通过路径检查')
    if (tool.entry.schema && !tool.entry.schema.safeParse(args).success)
      throw fileInputError('file_service.invalid_config', '文件工具映射与参数要求不一致')
    if (tool.entry.supervisionLevel === SupervisionLevel.smart &&
      (!Object.hasOwn(runtime.sensitivityRules, tool.name) || isSafeSenseCall(runtime.sensitivityRules, tool.name, args) !== true))
      throw fileInputError('capability.requires_approval', '文件工具的 smart 规则没有明确允许本次调用')
    const authorization = authorize(args)
    if (authorization.decision !== 'allow')
      throw fileInputError('capability.requires_approval', '文件工具需要审批或已被角色权限禁止；前置处理不会自动批准')
    return authorization
  }
  check(input)
  const decision = await dispatch('PreToolUse', { name: tool.name, args: input, chatId: ctx.soul.chatId }, requestHookContext(ctx))
  if (decision?.decision === 'deny')
    throw fileInputError('capability.unavailable', '文件工具被执行前检查禁止')
  if (decision?.decision === 'ask')
    throw fileInputError('capability.requires_approval', '文件工具需要人工审批，不能自动执行')
  const args = { ...input, ...decision?.updatedInput }
  const security = check(args)
  const operationId = randomUUID()
  return async () => {
    const currentSecurity = check(args)
    if (currentSecurity.policyHash !== security.policyHash || currentSecurity.assessmentHash !== security.assessmentHash)
      throw fileInputError('capability.unavailable', '文件工具授权已经改变')
    const result = await executeSenseWithControl(tool.entry.execute, args, ctx.soul.senseSharedData, {
      chatId: ctx.soul.chatId, signal, requestView: ctx.requestView,
      operationId, messageId: operationId, security, workspaceRoot: workspace,
      budget: { timeoutMs: 120_000, maxOutputChars: 80_000, maxBytes: 400_000, maxConcurrent: 8 },
      deadlineAt: ctx.requestView?.identity.source === 'plugin' && ctx.requestView.identity.channel === 'qq' ? undefined : Date.now() + 120_000,
    })
    if (result.status && result.status !== 'ok')
      throw fileInputError('file_operation.failed', result.content || '文件理解失败')
    let output: unknown = result.content
    if (tool.mapping.resultPath) {
      try { output = JSON.parse(result.content) } catch {
        throw fileInputError('file_service.invalid_config', '文件工具结果不是可按路径读取的 JSON')
      }
      for (const key of tool.mapping.resultPath.split('.')) {
        if (['__proto__', 'prototype', 'constructor'].includes(key) || !output || typeof output !== 'object' || !Object.hasOwn(output, key))
          throw fileInputError('file_service.invalid_config', '文件工具结果中没有配置的文本路径')
        output = (output as Record<string, unknown>)[key]
      }
    }
    if (typeof output !== 'string' || !output.trim())
      throw fileInputError('file_operation.failed', '文件工具没有返回有效文字，不能视为已读取')
    return { text: output, operationId: result.operationId ?? operationId, observation: result.observation }
  }
}
