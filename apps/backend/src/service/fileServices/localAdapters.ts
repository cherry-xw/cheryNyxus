import { getLLMAdapter } from '@/core/llm/adapter.js'
import { getMessageAdapter } from '@/core/message/adapter.js'
import { resolveBrainAdapterKey, resolveBrainProtocol } from '@/core/llm/routing.js'
import { getSense, getSenseOrigin } from '@/core/sense/senseRegistry.js'
import { executeSenseWithControl, isSafeSenseCall, loadMergedRuleSet, type SenseRuntimeContext } from '@/core/sense/index.js'
import { SupervisionLevel } from '@/core/config.js'
import { authorizeToolCall, compileRoleSecurity } from '@/core/security/index.js'
import { getChatType, getChatWorkspace, getChatRuntimeSelection, getChatRule } from '@/db/chat.js'
import { dispatch } from '@/agent/hooks/index.js'
import { checkCheryGuard } from '@/utils/pathGuard.js'
import { buildFileServiceToolName } from '@chery/protocol'
import type { Config, FileServiceConfig } from '@chery/plugin-api'
import type { FileServiceAdapterInput, FileServiceAdapterOutput } from './adapters/types.js'
import { FileServiceAdapterError } from './adapters/types.js'
import { getAssetStore } from '../media/store.js'
import { fileAccessForChat } from '../media/access.js'
import { resolveEffectiveBrainCapabilities } from '@/utils/modelCatalog.js'

export async function executeLocalFileAdapter(input: FileServiceAdapterInput, service: FileServiceConfig, config: Config, chatId?: string, requestView?: SenseRuntimeContext['requestView'], operationId?: string, onStart?: () => void): Promise<FileServiceAdapterOutput> {
  if (service.adapter === 'vision-brain') {
    const brain = config.llm.brain[service.connection.brainRef ?? '']
    if (!brain || input.operation !== 'image.inspect') throw new Error('理解服务需要明确的视觉大脑连接')
    const protocol = resolveBrainProtocol(brain)
    const effective = resolveEffectiveBrainCapabilities({ ...brain, protocol, userCapabilities: brain.capabilities })
    if (effective.input.image.state !== 'supported') throw new Error('目标大脑尚未声明支持图片输入')
    if (!protocol || !['openai-chat-completions', 'openai-responses', 'anthropic-messages'].includes(protocol)) throw new Error('此接口尚未实现视觉输入')
    if (!input.assets.length || input.assets.some(asset => !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(asset.mimeType))) throw new Error('视觉理解服务需要受支持的图片输入')
    const adapterKey = resolveBrainAdapterKey(brain)
    const messages = getMessageAdapter(adapterKey)
    const llm = getLLMAdapter(adapterKey)
    if (!messages || !llm) throw new Error('目标模型接口尚未加载')
    const now = Date.now()
    const history = [{ id: 'file-question', role: 'user' as const, content: String(input.params.prompt ?? input.params.question ?? '请理解这些文件。'), createdAt: now, updateAt: now }]
    input.signal?.throwIfAborted()
    onStart?.()
    const raw = await llm.chat(messages.buildMessages(history, input.assets.map(asset => ({ ...asset, kind: 'image' as const, messageId: 'file-question' }))), [], {
      model: brain.model, provider: brain.provider, protocol, url: brain.url, key: brain.key, fullUrl: brain.fullUrl, brain: service.connection.brainRef, signal: input.signal, thinking: 'off',
    })
    const text = messages.content(raw)
    if (!text?.trim()) throw new Error('理解服务没有返回有效文字')
    return { parts: [{ type: 'text', text }] }
  }
  const mapping = service.toolMapping
  if (!mapping || !chatId) throw new Error('自定义文件服务需要完整的工具映射和会话')
  if (Object.entries(config.file_services ?? {}).some(([id, entry]) => entry.operations.some(operation => buildFileServiceToolName(id, operation) === mapping.toolName))) throw new Error('文件服务映射不能再次调用文件服务，避免循环')
  const roleName = getChatType(chatId)
  const role = roleName ? config.roles?.[roleName] : undefined
  if (!role) throw new Error('自定义文件工具需要明确的角色')
  const selection = getChatRuntimeSelection(chatId)
  const entries = config.sense_groups?.[selection?.senseGroup ?? role.senseGroup] ?? []
  const entry = entries.find(entry => entry.split(':')[0]?.trim() === mapping.toolName)
  const allowedMcp = mapping.toolName.startsWith('mcp__') && (selection?.mcpServers ?? role.mcpServers)?.some(server => mapping.toolName.startsWith(`mcp__${server}__`))
  if (!entry && !allowedMcp) throw new Error('映射工具不在角色授权的工具组或 MCP 中')
  if (mapping.toolName.startsWith('mcp__') && mapping.transferMode === 'asset-id') throw new Error('远程 MCP 不能凭本地文件 ID 读取内容，请选择 base64 或 data-url')
  const tool = getSense(mapping.toolName)
  if (!tool || getSenseOrigin(mapping.toolName)?.available?.() === false) throw new Error('映射工具不可用')
  let args: Record<string, unknown> = { ...mapping.constantParams, ...input.params, [mapping.questionField]: String(input.params.prompt ?? input.params.question ?? ''),
    [mapping.inputAssetField]: input.assets.map(asset => mapping.transferMode === 'asset-id' ? { assetId: asset.assetId, assetVersionId: asset.assetVersionId } : mapping.transferMode === 'data-url' ? `data:${asset.mimeType};base64,${asset.data.toString('base64')}` : asset.data.toString('base64')) }
  if (mapping.questionField !== 'prompt') delete args.prompt
  const levels: Record<string, SupervisionLevel> = { auto: SupervisionLevel.auto, smart: SupervisionLevel.smart, manual: SupervisionLevel.manual }
  const configuredLevel = (entry ? levels[entry.split(':')[1]?.trim() ?? ''] : undefined) ?? tool.supervisionLevel ?? config.global.supervision
  const workspace = getChatWorkspace(chatId)
  const authorize = () => {
    input.signal?.throwIfAborted()
    if (getSense(mapping.toolName) !== tool || getSenseOrigin(mapping.toolName)?.available?.() === false) throw new Error('映射工具在执行前已改变或关闭')
    if (checkCheryGuard(mapping.toolName, args)) throw new Error('映射工具参数未通过路径检查')
    const parsed = tool.executor.schema.parse(args)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('映射工具参数必须是对象')
    args = parsed as Record<string, unknown>
    const safe = configuredLevel === SupervisionLevel.smart ? isSafeSenseCall(loadMergedRuleSet(getChatRule(chatId)), mapping.toolName, args) : undefined
    return authorizeToolCall({ security: compileRoleSecurity(roleName, role), name: mapping.toolName, args, workspace, configuredLevel, legacySafe: safe, requestIdentity: requestView?.identity })
  }
  if (authorize().decision !== 'allow') throw new Error('底层工具需要审批或已被禁止，文件服务不能绕过')
  const hook = await dispatch('PreToolUse', { name: mapping.toolName, args, chatId }, { brain: service.connection.brainRef ?? '', chatId, requestId: requestView?.requestId, inputId: requestView?.inputId, requestView, signal: input.signal })
  if (hook?.decision === 'deny' || hook?.decision === 'ask') throw new Error('执行前检查未允许映射工具直接执行')
  args = { ...args, ...hook?.updatedInput }
  const security = authorize()
  if (security.decision !== 'allow') throw new Error('底层工具未获直接执行许可，请检查其角色权限和监管规则；不会借文件服务绕过审批')
  const result = await executeSenseWithControl((args, shared, ctx) => { onStart?.(); return tool.executor.execute(args, shared, ctx) }, args, new Map(), { chatId, operationId, signal: input.signal, requestView, security, workspaceRoot: workspace, budget: { timeoutMs: service.timeoutMs ?? 600_000 } })
  if (result.status && result.status !== 'ok') {
    if (result.status === 'provider_error') {
      const error = new FileServiceAdapterError('file_service.provider_error', result.content || '自定义文件工具执行失败')
      if (result.parts?.length && operationId) {
        const access = fileAccessForChat(chatId)
        // 自定义工具声明的文件仍需重新授权；失败结果也不能夹带其他会话的文件。
        getAssetStore().reference(result.parts, access, 'operation', operationId)
        error.outputParts = result.parts
      }
      throw error
    }
    throw new Error(result.content || '自定义文件工具执行失败')
  }
  const parts: FileServiceAdapterOutput['parts'] = []
  let mappedText: string | undefined
  if (mapping.resultPath) {
    let value: unknown = JSON.parse(result.content)
    for (const key of mapping.resultPath.split('.')) {
      if (['__proto__', 'constructor', 'prototype'].includes(key) || !value || typeof value !== 'object' || !Object.hasOwn(value, key)) throw new Error('结果映射路径不存在')
      value = (value as Record<string, unknown>)[key]
    }
    if (typeof value !== 'string') throw new Error('结果映射必须指向文字；文件必须通过结构化 parts 返回')
    mappedText = value
    parts.push({ type: 'text', text: mappedText })
  }
  if (result.parts?.length) {
    for (const part of result.parts) {
      if (part.type === 'text' && mappedText === undefined) parts.push({ type: 'text', text: part.text })
      if (part.type === 'asset') {
        const { asset, data } = await getAssetStore().read(part.assetId, fileAccessForChat(chatId), part.assetVersionId)
        parts.push({ type: 'file', data, mimeType: asset.mimeType, originalName: asset.originalName })
      }
    }
  } else if (result.content && mappedText === undefined) parts.push({ type: 'text', text: result.content })
  return { parts }
}
