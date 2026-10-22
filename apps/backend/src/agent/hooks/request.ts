import { randomUUID } from 'node:crypto'
import type { MiddlewareContext, UserInputEntry } from '@/core/middleware/types.js'
import { immutableSnapshot, type IngressRequestContext } from '@/service/ingress/api.js'
import { getSense, getSenseOrigin, getSenseRegistryVersion } from '@/core/sense/senseRegistry.js'
import { ensureCurrentConfigRevision } from '@/service/config/revision.js'
import { getRequestPluginSkills } from '@/agent/prompt/loadSkill.js'
import { getChatSkillFilter, getChat, updateChatMetadata } from '@/db/chat.js'
import { managedToolDenied } from '@/core/security/managedRequest.js'
import { fileCapabilityContext } from '@/service/fileServices/runtime.js'
import { resolveFileCapabilities } from '@/service/fileServices/capabilityResolver.js'
import { drawingRoundForInput, drawingModelContext } from '@/service/fileServices/drawings.js'


import { dispatch } from './dispatch.js'
import type { HookDispatchContext } from './types.js'

export function requestHookContext(ctx: MiddlewareContext): HookDispatchContext {
  const view = ctx.requestView
  return {
    brain: ctx.runtime?.brainName ?? '',
    chatId: ctx.soul.chatId,
    requestId: view?.requestId,
    inputId: view?.inputId,
    requestView: view,
    signal: requestSignal(ctx),
  }
}
export function requestSignal(ctx: MiddlewareContext): AbortSignal | undefined {
  const parent = ctx.requestExecution?.signal
  const pipeline = ctx.pipeline?.getAbortSignal()
  return parent && pipeline ? AbortSignal.any([parent, pipeline]) : (parent ?? pipeline)
}
export async function prepareRequest(ctx: MiddlewareContext, input: UserInputEntry): Promise<void> {
  input.requestExecution?.validate()
  ctx.requestExecution = input.requestExecution
  ctx.refreshRequestRuntime?.()
  requestSignal(ctx)?.throwIfAborted()
  const runtime = ctx.runtime!
  const requestId = input.requestId ?? randomUUID()
  const inputId = input.inputId ?? input.messageId ?? randomUUID()
  const chat = getChat(ctx.soul.chatId)
  let current = chat
  let storedIdentity
  const visited = new Set<string>()
  while (current) {
    let metadata
    try { metadata = current.metadata ? JSON.parse(current.metadata) : {} }
    catch { throw new Error('APP_ACCESS_DENIED: 会话身份记录损坏') }
    const saved = metadata.managedRequestIdentity
    if (saved !== undefined) {
      if (saved?.source !== 'plugin' || typeof saved.ownerId !== 'string') {
        throw new Error('APP_ACCESS_DENIED: 受管身份记录无效')
      }
      storedIdentity = saved
      break
    }
    if (!current.parent_chat_id) break
    if (visited.has(current.parent_chat_id)) throw new Error('APP_ACCESS_DENIED: 会话父链无效')
    visited.add(current.parent_chat_id)
    current = getChat(current.parent_chat_id)
    if (!current) throw new Error('APP_ACCESS_DENIED: 无法恢复父会话身份')
  }
  const identity = storedIdentity ?? (chat?.parent_chat_id ? undefined : input.requestIdentity) ?? { source: 'web' as const }
  if (chat && !chat.parent_chat_id && input.requestIdentity?.source === 'plugin') {
    updateChatMetadata(ctx.soul.chatId, { managedRequestIdentity: identity })
  }
  const requestPluginSkills = getRequestPluginSkills(identity, getChatSkillFilter(ctx.soul.chatId))
  const unavailable = [...(runtime.unavailableTools ?? [])]
  runtime.builtSenses = runtime.builtSenses.filter((definition) => {
    const name = definition.function.name
    const origin = getSenseOrigin(name)
    if (managedToolDenied(name, identity)) {
      runtime.senseTable.delete(name)
      return false
    }
    if (
      origin?.pluginId &&
      origin.channels?.length &&
      (!identity.channel || !origin.channels.includes(identity.channel) || !identity.subject)
    ) {
      runtime.senseTable.delete(name)
      unavailable.push({
        name,
        source: 'plugin',
        pluginId: origin.pluginId,
        reason: 'identity_required',
      })
      return false
    }
    return true
  })
  const fileContext = runtime.configSnapshot ? fileCapabilityContext(ctx.soul.chatId, { config: runtime.configSnapshot, runtimeSelection: runtime.selectionSnapshot }) : undefined
  if (fileContext?.runtime) {
    const visible = new Set(runtime.builtSenses.map(tool => tool.function.name))
    if (fileContext.roleName) fileContext.runtime.executableTools = { [fileContext.roleName]: [...visible] }
    if (!visible.has('spawn_role') && fileContext.roleName && fileContext.runtime.dispatchRoster) fileContext.runtime.dispatchRoster[fileContext.roleName] = []
  }
  ctx.requestView = immutableSnapshot({
    requestId,
    inputId,
    chatId: ctx.soul.chatId,
    preparedAt: Date.now(),
    configRevision: ensureCurrentConfigRevision().revisionId,
    registryVersion: getSenseRegistryVersion(),
    identity,
    fileCapabilities: fileContext ? resolveFileCapabilities({ ...fileContext, explicit: undefined }) : undefined,
    tools: runtime.builtSenses.map((definition) => {
      const name = definition.function.name
      const origin = getSenseOrigin(name)
      return {
        name,
        source: origin?.source ?? 'builtin',
        pluginId: origin?.pluginId,
        pluginVersion: origin?.pluginVersion,
        definition,
        supervisionLevel: runtime.senseTable.get(name)!.supervisionLevel,
      }
    }),
    unavailableTools: unavailable,
    contexts: [],
  })
  const context = requestHookContext(ctx)
  const contexts: IngressRequestContext[] = []
  const drawing = drawingRoundForInput(ctx.soul.chatId, input)
  if (drawing) contexts.push({ ownerId: 'drawing', key: 'round', content: drawingModelContext(drawing), configRevision: 0 })
  for (const skill of requestPluginSkills) {
    contexts.push({
      ownerId: skill.plugin!,
      key: `skill:${skill.name}`,
      content: `<skill name="${skill.name}">\n${skill.description}\n</skill>`,
      configRevision: 0,
    })
  }
  if (!ctx.requestSessionStarted) {
    const result = await dispatch(
      'SessionStart',
      { chatId: ctx.soul.chatId, brain: context.brain },
      context,
    )
    ctx.requestSessionStarted = true
    if (result?.additionalContext)
      contexts.push({
        ownerId: 'command',
        key: 'session',
        content: result.additionalContext,
        configRevision: 0,
      })
  }
  const submitted = await dispatch(
    'UserPromptSubmit',
    { chatId: ctx.soul.chatId, prompt: input.content, role: input.role ?? 'user' },
    context,
  )
  if (submitted?.additionalContext)
    contexts.push({
      ownerId: 'command',
      key: 'prompt',
      content: submitted.additionalContext,
      configRevision: 0,
    })
  const prepared = await dispatch(
    'RequestPrepare',
    { requestId, inputId, chatId: ctx.soul.chatId },
    context,
  )
  for (const name of prepared?.excludedTools ?? []) {
    runtime.builtSenses = runtime.builtSenses.filter(s => s.function.name !== name)
    runtime.senseTable.delete(name)
  }
  ctx.requestToolPhase = prepared?.toolPhase
  for (const name of prepared?.tools ?? []) {
    const sense = getSense(name), origin = getSenseOrigin(name)
    if (!sense || !origin || origin.pluginId !== identity.ownerId || origin.available?.() === false || managedToolDenied(name, identity)) continue
    if (!runtime.builtSenses.some(s => s.function.name === name)) runtime.builtSenses.push(sense.definition)
    runtime.senseTable.set(name, { supervisionLevel: sense.supervisionLevel ?? 0,
      schema: sense.executor.schema, execute: (args, shared, context) => sense.executor.execute(args, shared, context) })
  }
  for (const item of prepared?.contexts ?? []) contexts.push({ ...item, ownerId: item.ownerId! })
  const keys = contexts.map((item) => `${item.ownerId}:${item.key}`)
  if (
    new Set(keys).size !== keys.length ||
    contexts.reduce((size, item) => size + Buffer.byteLength(item.content), 0) > 256 * 1024
  )
    throw new Error('INVALID_REQUEST_CONTEXT')
  ctx.requestView = immutableSnapshot({ ...ctx.requestView, contexts })
}
export async function finishRequest(
  ctx: MiddlewareContext,
  state: 'completed' | 'failed' | 'cancelled',
): Promise<void> {
  const view = ctx.requestView
  if (!view) return
  const context = requestHookContext(ctx)
  const base = { requestId: view.requestId, inputId: view.inputId, chatId: view.chatId }
  ctx.requestView = undefined
  if (state === 'completed')
    await dispatch('RequestCompleted', { ...base, completedAt: Date.now() }, context)
  else if (state === 'failed')
    await dispatch(
      'RequestFailed',
      { ...base, failedAt: Date.now(), errorCode: 'REQUEST_FAILED' },
      context,
    )
  else
    await dispatch(
      'RequestCancelled',
      { ...base, cancelledAt: Date.now(), reasonCode: 'REQUEST_CANCELLED' },
      context,
    )
}
