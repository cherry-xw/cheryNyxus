import { contextRecoveryAdapter } from './contextRecovery.js'
import { applyContextCheckpoint } from './contextCheckpoint.js'
import { updateChatMetadata } from '@/db/chat.js'
import { enrichMediaInputs } from './mediaEnrichment.js'
import { saveFileRequestPlan, patchFileRequestPlan } from '@/service/fileServices/inputObservations.js'

import { executeRequestTool } from './tool.js'
import { randomUUID } from 'node:crypto'
import { sourceStepReason } from './sourceStepReason.js'
import type {
  MiddlewareContext,
  MiddlewareChunk,
  StreamChunk,
  RuntimeConfig,
} from '@/core/middleware/types'
import type { SenseFunction, SenseCallData } from '@/core/sense/adapter'
import type { LLMOptions, ThinkingLevel } from '@/core/llm/adapter'
import {
  resolveCatalogReasoningHistory,
  resolveCatalogThinkingSelection,
  catalogToolCallsAllowed,
} from '@/utils/modelCatalog.js'
import { resolveLlmProviderDefaultUrl, ErrorId } from '@chery/protocol'
import { resolveBrainProtocol } from '@/core/llm/routing.js'
import { logger, LogLevel } from '@/utils/logger/index.js'
import type {
  LLMResponse,
  LLMAttachment,
  ServerToolCallDelta,
  ThinkingBlockDelta,
} from '@/core/message/adapter'
import { ThinkingBlockAssembler, completeThinkingBlockDeltas } from '@/agent/provider/thinkingBlockAssembler.js'
import config from '@/utils/config.js'
import { dispatch } from '@/agent/hooks/index.js'
import { functionHooks } from '@/agent/hooks/functions.js'
import { loadHookRegistry } from '@/agent/hooks/registry.js'
import { ClassifiedError, classifyError } from '@/utils/error.js'
import { reportWorkflow } from '@/core/middleware/workflowObservation.js'
import { createRequestObservation } from '@/agent/provider/requestObservation.js'
import { observeServerTools } from '@/agent/provider/serverToolObservation.js'
import { estimateTokens } from '@/utils/token.js'
import { describeFileReferences } from '@/service/workspace/handler.js'
import { ModelRequestTimeoutError } from './requestTimeout.js'
import { SenseCallAssembler } from './senseCallAssembler.js'
import { requestHookContext, requestSignal, refreshRequestCapabilities } from '@/agent/hooks/request.js'
import { prepareSourceHistory } from './sourceHistory.js'
import { sourceModelStep } from './sourceProjection.js'
import { failSourceCapacity, prepareSourceCapacity } from './sourceCapacity.js'

/**
 * Chat Middleware
 * 职责：API 调用、流式输出
 * yield StreamChunk（包含 senseDelta）
 * sense_end 逻辑交给 checkpoint 中间件处理
 */
export async function* chatMiddleware(
  ctx: MiddlewareContext,
  next: () => AsyncGenerator<MiddlewareChunk>,
): AsyncGenerator<MiddlewareChunk> {
  // P2-4：runtime 在 send 前 configureRuntime 注入；运行时守卫窄化，消除构造期 {} as 谎言
  if (!ctx.runtime)
    throw new Error('Runtime not configured. Call configureRuntime() before send().')
  const { messageAdapter, senseAdapter } = ctx.runtime.adapters
  reportWorkflow(ctx.soul.chatId, {
    activeNodeId: 'model',
    phaseLabel: '准备请求',
    status: 'running',
  })

  // 从 ctx.soul.messages 构建 provider 格式消息
  // 固定版本文件按本次能力和预算逐项规划；临时附件不改变持久历史。
  const fileRequestId = randomUUID()
  let requestWasSent = false
  try {
  if (ctx.soul.messages?.some(message => message.parts?.some(part => part.type === 'asset'))) saveFileRequestPlan(ctx.soul.chatId, { requestId: fileRequestId, phase: 'prepared', plan: [], usage: null, policy: config.files?.imageContext })
  const prepared = await prepareModelHistory(ctx, fileRequestId)
  let historyForBuild = prepared.historyForBuild
  const { attachments, fileProjection } = prepared

  // 使用预构建的 senses（runtime.builtSenses）
  const senses = ctx.runtime.builtSenses

  // 构建请求选项（P1-6：LLMOptions 显式类型，替代 Record<string, unknown>）
  // Preserve global off; conflicting vendor constraints must not increase effort.
  const thinkingLevel: ThinkingLevel = ctx.global.thinking
    ? (ctx.runtime.brain.thinking ?? 'off')
    : 'off'
  const protocol = resolveBrainProtocol(ctx.runtime.brain)
  const thinkingSelection = resolveCatalogThinkingSelection({
    model: ctx.runtime.brain.model,
    provider: ctx.runtime.brain.provider,
    protocol,
    display: thinkingLevel,
  })
  if (thinkingSelection.cannotDisable) {
    throw new ClassifiedError({ errorId: ErrorId.REQUEST_THINKING_UNSUPPORTED, message: 'Configured model cannot disable thinking', userMessage: '当前型号在此协议不能关闭思考，但全局思考已关闭。请确认开启全局思考并选择合法等级，或选择支持关闭的型号；本次未发送模型请求。', category: 'validation', source: 'chat' })
  }
  if (senses.length > 0 && !catalogToolCallsAllowed({ model: ctx.runtime.brain.model, provider: ctx.runtime.brain.provider, protocol, display: thinkingLevel })) {
    throw new ClassifiedError({ errorId: ErrorId.REQUEST_TOOLS_UNSUPPORTED, message: 'Configured protocol and reasoning level do not support function calling', userMessage: '当前型号、协议与思考等级不支持函数调用。请使用支持工具的协议或等级；本次未删除工具、未更换配置、未发送模型请求。', category: 'validation', source: 'chat' })
  }
  const options: LLMOptions = {
    model: ctx.runtime.brain.model,
    provider: ctx.runtime.brain.provider,
    ...(protocol ? { protocol } : {}),
    chatId: ctx.soul.chatId,
    url:
      ctx.runtime.brain.url ?? resolveLlmProviderDefaultUrl(ctx.runtime.brain.provider, protocol),
    key: ctx.runtime.brain.key,
    thinking: thinkingSelection.effective,
    thinkingParams: thinkingSelection.params,
    ...(ctx.runtime.brain.rpm && { rpm: ctx.runtime.brain.rpm }),
    // URL 完整性开关：true=url 已含版本段（/v1 等），provider 只拼 endpoint 不自动补全
    fullUrl: ctx.runtime.brain.fullUrl === true,
    // Anthropic 官方开关：brain.anthropicCompat.official=true 时保留 redacted_thinking 原样回传；
    // 默认 false → strip（兼容 3rd-party coding-plan 代理）。
    anthropicOfficial:
      ctx.runtime.brain.provider === 'deepseek'
        ? false
        : (ctx.runtime.brain.anthropicCompat?.official ??
          (ctx.runtime.brain.protocol === 'anthropic-messages' &&
            (ctx.runtime.brain.provider === 'anthropic' ||
              ctx.runtime.brain.provider === 'minimax'))),
    signal: requestSignal(ctx),
    brain: ctx.runtime.brainName,
    requestView: ctx.requestView,
    inputPreflight: {
      contextLimit: ctx.runtime.brain.contextLimit,
      safetyMargin: ctx.runtime.configSnapshot?.global.command?.safety_margin ?? config.global.command?.safety_margin,
      trigger: ctx.runtime.configSnapshot?.global.command?.auto ?? config.global.command?.auto,
      compactIfNeeded: (ctx.runtime.brain.contextLimit ?? 0) >= (ctx.runtime.configSnapshot?.global.command?.min_context_limit ?? config.global.command?.min_context_limit ?? 0),
      forcePreparation: historyForBuild.findLast(m => m.role === 'user')?.content.includes('[[command:/compact]]'),
      report: (result: import('@/core/llm/adapter.js').InputTokenPreflight) => {
        updateChatMetadata(ctx.soul.chatId, { modelInputBudget: { ...result, model: ctx.runtime!.brain.model, protocol, requestId: ctx.requestView?.requestId } })
        if (fileProjection.plan?.length) patchFileRequestPlan(ctx.soul.chatId, fileRequestId, result as unknown as Record<string, unknown>)
      },
    },
  }

  if (!prepared.source) historyForBuild = applyContextCheckpoint(ctx.soul.chatId, historyForBuild)
  const messages = messageAdapter.buildMessages(
    historyForBuild.filter((message) => !message.modelExcluded),
    attachments,
    {
      anthropicOfficial: options.anthropicOfficial,
      protocol: options.protocol,
      reasoningHistory: resolveCatalogReasoningHistory({
        model: options.model,
        provider: options.provider,
        protocol: options.protocol,
      }),
    },
  )
  const serializedBytes = Buffer.byteLength(JSON.stringify({ messages, tools: senses }))
  if (serializedBytes > 32 * 1024 * 1024) throw new ClassifiedError({ errorId: ErrorId.REQUEST_INPUT_TOO_LARGE, message: '序列化请求超过 32 MiB', userMessage: '本次请求内容过大，请减少文件内容输入', category: 'validation', source: 'chat' })

  // ========== 空上下文守卫 ==========
  // 纪元切换后 loadHistory 可能只有 system 内容（frozen prompt / epoch handoff / carryover 重构失败时），
  // 纯 system 列表发往 LLM 会被上游拒绝（MiniMax 400 2013 / new-api `field messages is required`）。
  // 在此拦截（category=validation、source=chat，不进 retry；文案见 error-conventions.md / context-epochs.md）。
  // 有媒体附件（多模态旁路 content 被清空）不算空。
  const hasUserContent =
    (attachments?.length ?? 0) > 0 ||
    historyForBuild.some(
      (m) =>
        (m.role === 'user' || m.role === 'role' || m.role === 'subagent') &&
        m.content.trim() !== '',
    )
  if (!hasUserContent) {
    logger.event(
      'llm.empty_context',
      { chatId: ctx.soul.chatId, msgCount: messages.length },
      LogLevel.error,
    )
    throw new ClassifiedError({
      message: `empty context: no user content for chat ${ctx.soul.chatId} (${messages.length} system-only messages)`,
      userMessage: '该会话当前纪元没有可延续的用户消息，请重新发送',
      category: 'validation',
      source: 'chat',
    })
  }

  // ========== AI 输入参数日志 ==========
  logger.event('llm.req', {
    chatId: ctx.soul.chatId,
    provider: ctx.runtime.brain.provider || 'unknown',
    protocol: options.protocol ?? 'legacy',
    modelRule: 'auto',
    model: options.model,
    thinking: options.thinking ?? 'off',
    requestedThinking: thinkingSelection.requested,
    cannotDisableThinking: thinkingSelection.cannotDisable,
    thinkingParams: Object.keys(options.thinkingParams ?? {}),
    stream: !!ctx.global.stream,
    senseCount: senses.length,
    senseNames: senses.map((s) => s.function?.name || 'unknown'),
    msgCount: messages.length,
  })

  options.observation = createRequestObservation({
    chatId: ctx.soul.chatId,
    inputMessageId: historyForBuild.findLast((message) => message.role === 'user')?.id,
    model: options.model,
    provider: options.provider ?? 'unknown',
    protocol: options.protocol ?? options.provider ?? 'unknown',
    context: {
      system: estimateTokens(
        historyForBuild
          .filter((m) => m.role === 'system')
          .map((m) => m.content)
          .join('\n'),
      ),
      tools: estimateTokens(JSON.stringify(senses)),
      conversation: estimateTokens(
        JSON.stringify(historyForBuild.filter((m) => m.role !== 'system')),
      ),
      limit: ctx.runtime.brain.contextLimit ?? null,
    },
  })
  const observation = observeServerTools(
    options.observation, ctx.runtime.serverToolScopeId, messageAdapter, !!ctx.global.stream,
    ctx.runtime.brain.model,
  )
  options.observation = {
    ...observation,
    start(model) {
      requestSignal(ctx)?.throwIfAborted()
      ctx.requestExecution?.validate()
       if (!prepared.source) fileProjection.commit?.()
      requestWasSent = true
      if (fileProjection.plan?.length) patchFileRequestPlan(ctx.soul.chatId, fileRequestId, { phase: 'sent' })
      observation.start(model)
    },
  }
   if (!prepared.source && (options.provider === 'mock' || options.protocol === 'mock')) options.observation.start()
  // Deadline starts at the provider boundary, not while preparing context or waiting for tools.
  const qqTask = ctx.requestView?.identity.source === 'plugin' && ctx.requestView.identity.channel === 'qq'
  const timeoutMs = qqTask ? 0 : config.global.llm_request_timeout_ms ?? DEFAULT_GLOBAL_OPTIONS.llm_request_timeout_ms
  const parentSignal = options.signal
  const controller = new AbortController()
  const abortFromParent = () => controller.abort()
  if (parentSignal?.aborted) controller.abort()
  else parentSignal?.addEventListener('abort', abortFromParent, { once: true })
  options.signal = controller.signal
  let timedOut = false
  let rejectDeadline: ((error: ModelRequestTimeoutError) => void) | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject
  })
  // Prevent a late deadline from becoming an unhandled rejection during cleanup.
  void deadline.catch(() => {})
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          if (parentSignal?.aborted) return
          timedOut = true
          controller.abort()
          rejectDeadline?.(new ModelRequestTimeoutError(timeoutMs))
        }, timeoutMs)
      : undefined
  const llmAdapter = contextRecoveryAdapter(ctx, () => historyForBuild, history => messageAdapter.buildMessages(history, attachments, { protocol: options.protocol, anthropicOfficial: options.anthropicOfficial, reasoningHistory: resolveCatalogReasoningHistory({ model: options.model, provider: options.provider, protocol: options.protocol }) }))
  let completed = false
  try {
    if (ctx.requestExecution?.execution?.toolHistory === 'request') {
      yield* withModelDeadline(
        handleRequestLocal(ctx, options, prepared, fileRequestId),
        deadline,
        timeoutMs > 0,
      )
    } else if (ctx.global.stream) {
      // 流式调用
      yield* withModelDeadline(
        handleStream(ctx, options, llmAdapter, messageAdapter, senseAdapter, messages, senses),
        deadline,
        timeoutMs > 0,
      )
    } else {
      // 非流式调用
      yield* withModelDeadline(
        handleNonStream(ctx, options, llmAdapter, messageAdapter, senseAdapter, messages, senses),
        deadline,
        timeoutMs > 0,
      )
    }
    if (timedOut) throw new ModelRequestTimeoutError(timeoutMs)
    completed = true
    if (fileProjection.plan?.length) patchFileRequestPlan(ctx.soul.chatId, fileRequestId, { phase: 'completed' })
  } catch (error) {
    if (timedOut && !parentSignal?.aborted) throw new ModelRequestTimeoutError(timeoutMs)
    throw error
  } finally {
    if (timer) clearTimeout(timer)
    parentSignal?.removeEventListener('abort', abortFromParent)
    options.observation.finish(
      completed ? 'completed' : options.signal?.aborted ? 'cancelled' : 'failed',
    )
  }

  // 执行下游
  yield* next()
  } catch (error) {
    // An old request must not rewrite a newer request's file detail record.
    try { patchFileRequestPlan(ctx.soul.chatId, fileRequestId, { phase: requestWasSent ? 'result_unknown' : 'failed_before_send' }) } catch { /* Original request failure takes precedence. */ }
    throw error
  }
}

/** Prepare this request's media and temporary prompts without mutating stored history. */
async function prepareModelHistory(ctx: MiddlewareContext, requestId: string, history = ctx.soul.messages || []): Promise<{
  historyForBuild: LLMResponse[]
  attachments?: LLMAttachment[]
  fileProjection: Awaited<ReturnType<typeof enrichMediaInputs>>
  source?: import('./sourceHistory.js').PreparedSourceHistory
}> {
  refreshRequestCapabilities(ctx)
  const sourceHistory = prepareSourceHistory(ctx, history)
  const enriched = await enrichMediaInputs(ctx, sourceHistory.history, sourceHistory.source)
  if (enriched.plan?.length) saveFileRequestPlan(ctx.soul.chatId, { requestId, phase: 'prepared', policy: config.files?.imageContext, plan: enriched.plan, usage: enriched.usage, officialPreflight: 'pending' })

  // 本次文件处理限制只用于请求，不写回历史。
  // 浅拷贝 history 避免污染 soul（checkpoint 中间件不持久化此段）。
  let historyForBuild = enriched.history
  if (enriched.capabilitiesHint) {
    historyForBuild = [
      {
        id: 'file-input-capabilities',
        role: 'system',
        content: enriched.capabilitiesHint,
        createdAt: Date.now(),
        updateAt: Date.now(),
      } as LLMResponse,
      ...enriched.history,
    ]
  }

  const latestUser = historyForBuild.findLast((message) => message.role === 'user')
  const fileReferences = latestUser?.content.includes('[[file:')
    ? await describeFileReferences(ctx.soul.chatId, latestUser.content)
    : undefined
  if (fileReferences)
    historyForBuild = [
      ...historyForBuild,
      {
        id: `file-references:${latestUser!.id}`,
        role: 'user',
        content: fileReferences,
        createdAt: Date.now(),
        updateAt: Date.now(),
      } as LLMResponse,
    ]

  const dynamic = ctx.requestView?.contexts ?? []
  if (dynamic.length)
    historyForBuild = [
      ...dynamic.map((item) => ({
        id: `request-context:${item.ownerId}:${item.key}`,
         role: item.kind === 'data' ? 'user' as const : 'system' as const,
        content: item.content,
        ...(item.kind === 'data' && sourceHistory.source ? { sourceData: {
          key: `${sourceHistory.source.input.requestId}:${item.key}`, kind: item.key === 'qq.executionNotice' ? 'execution_notice' as const : 'memory' as const,
          revision: 1,
        } } : {}),
        createdAt: Date.now(),
        updateAt: Date.now(),
      })),
      ...historyForBuild,
    ]
  return { historyForBuild, attachments: enriched.attachments, fileProjection: enriched, source: sourceHistory.source }
}

/** Only the final answer leaves this request-local model/tool history. */
async function* handleRequestLocal(
  ctx: MiddlewareContext,
  options: LLMOptions,
  initial: Awaited<ReturnType<typeof prepareModelHistory>>,
  fileRequestId?: string,
): AsyncGenerator<MiddlewareChunk> {
  const runtime = ctx.runtime!
  const { messageAdapter, senseAdapter } = runtime.adapters
  const history = [...(ctx.soul.messages ?? [])]
  const sourceRun = initial.source
  const runId = sourceRun ? sourceRun.repo.ensureRun(sourceRun.authority, sourceRun.input.scopeId, sourceRun.input.requestId, ctx.requestView!.requestId) : undefined
  if (sourceRun) {
    const anchor = history.findLastIndex(message => message.sourceInput?.requestId === sourceRun.input.requestId)
    if (anchor < 0) throw new Error('SOURCE_CONTEXT_UNAVAILABLE')
    const saved = sourceRun.repo.completedRunMessages(sourceRun.authority, sourceRun.input.scopeId, sourceRun.input.requestId)
    // The saved sequence is authoritative. Missing earlier tools must not be
    // inserted in front of an already checkpointed question call out of order.
    history.splice(0, history.length, ...history.slice(0, anchor).filter(message => message.role === 'system'),
      history[anchor]!, ...saved.map(item => item.body))
  }
  const parentObservation = options.observation
  const continuous = ctx.requestView?.identity.source === 'plugin' && ctx.requestView.identity.channel === 'qq'
  for (let turn = 0; continuous || turn < (ctx.global.maxLoopCount ?? DEFAULT_GLOBAL_OPTIONS.maxLoopCount); turn++) {
    if (options.signal?.aborted) throw new Error('Request cancelled')
    let prepared = turn > 0 || sourceRun ? await prepareModelHistory(ctx, fileRequestId!, history) : initial
    const enriched = prepared.fileProjection
    const attachments = enriched.attachments
    options.requestView = ctx.requestView
    if (!prepared.source) {
      if (enriched.plan?.length && fileRequestId) patchFileRequestPlan(ctx.soul.chatId, fileRequestId, { phase: 'prepared', plan: enriched.plan, usage: enriched.usage })
      options.observation = parentObservation ? { ...parentObservation, start(model) { enriched.commit?.(); parentObservation.start(model) } } : undefined
    }
    let projectedHistory = prepared.historyForBuild.filter(m => !m.modelExcluded && !m.revoked)
    const stepReason = sourceStepReason(ctx, turn)
    let sourceStep = prepared.source ? sourceModelStep(ctx, prepared.source, projectedHistory, enriched, options, parentObservation,
      stepReason) : undefined
    if (sourceStep) { options.sourceCall = sourceStep.boundary; options.observation = sourceStep.observation }
    const autoCompactEnabled = (runtime.brain.contextLimit ?? 0) >= (runtime.configSnapshot?.global.command?.min_context_limit ?? config.global.command?.min_context_limit ?? 0)
    if (options.inputPreflight) options.inputPreflight = { ...options.inputPreflight, compactIfNeeded: autoCompactEnabled, afterCompaction: false, accepted: undefined, forcePreparation: turn === 0 && options.inputPreflight.forcePreparation }
    const readyHistory = prepared.source ? projectedHistory : applyContextCheckpoint(ctx.soul.chatId, projectedHistory)
    const build = (current: LLMResponse[], media = attachments) => messageAdapter.buildMessages(current, media, {
      protocol: options.protocol, anthropicOfficial: options.anthropicOfficial,
      reasoningHistory: resolveCatalogReasoningHistory({ model: options.model, provider: options.provider, protocol: options.protocol }),
    })
    let capacityOperationId: string | undefined
    const recoverSources = prepared.source ? async (activeOptions: LLMOptions) => {
      sourceStep?.observation.finish('failed')
      const stepId = sourceStep!.modelStepId
      capacityOperationId = await prepareSourceCapacity(ctx, prepared.source!, activeOptions)
      prepared = await prepareModelHistory(ctx, fileRequestId!, history)
      projectedHistory = prepared.historyForBuild.filter(message => !message.modelExcluded && !message.revoked)
      sourceStep = sourceModelStep(ctx, prepared.source!, projectedHistory, prepared.fileProjection, activeOptions,
        parentObservation, stepReason, stepId)
      activeOptions.sourceCall = sourceStep.boundary; activeOptions.observation = sourceStep.observation
      return build(projectedHistory, prepared.attachments)
    } : undefined
    const llmAdapter = contextRecoveryAdapter(ctx, () => projectedHistory, build, recoverSources)
    const messages = messageAdapter.buildMessages(
      readyHistory,
      attachments,
      { anthropicOfficial: options.anthropicOfficial, protocol: options.protocol,
        reasoningHistory: resolveCatalogReasoningHistory({ model: options.model, provider: options.provider, protocol: options.protocol }),
      },
    )
    if (Buffer.byteLength(JSON.stringify({ messages, tools: runtime.builtSenses })) > 32 * 1024 * 1024) throw new ClassifiedError({ errorId: ErrorId.REQUEST_INPUT_TOO_LARGE, message: '序列化请求超过 32 MiB', userMessage: '本次请求内容过大，请减少文件内容输入', category: 'validation', source: 'chat' })
    let content = '',
      thinking = ''
    let calls: SenseCallData[]
    let stopReason: string | undefined
    let hasCompletedServerTool = false
    const blocks = new ThinkingBlockAssembler()
    let callCompleted = false
    try {
      if (ctx.global.stream) {
        const assembler = new SenseCallAssembler()
        const stream = await llmAdapter.chatStream(messages, ctx.requestToolPhase ? runtime.builtSenses.filter(t => ctx.requestToolPhase!.includes(t.function.name)) : runtime.builtSenses, options)
        for await (const raw of stream) {
          options.observation?.response(raw)
          content += messageAdapter.extractStreamDelta(raw) || ''
          thinking += messageAdapter.extractStreamThinking?.(raw) || ''
          for (const op of messageAdapter.extractStreamThinkingBlocks?.(raw) ?? []) blocks.push(op)
          for (const delta of senseAdapter.extractSenseCallDeltas(raw)) assembler.push(delta)
          const sr = messageAdapter.extractStreamStopReason?.(raw)
          if (sr) stopReason = sr
          for (const sd of messageAdapter.extractStreamServerToolDeltas?.(raw) ?? []) {
            if (sd.kind === 'result' && sd.status === 'completed') hasCompletedServerTool = true
          }
        }
        calls = assembler.toArray()
      } else {
        const response = await llmAdapter.chat(messages, ctx.requestToolPhase ? runtime.builtSenses.filter(t => ctx.requestToolPhase!.includes(t.function.name)) : runtime.builtSenses, options)
        options.observation?.response(response)
        content = messageAdapter.content(response) || ''
        thinking = messageAdapter.thinking?.(response) || ''
        for (const delta of completeThinkingBlockDeltas(messageAdapter.thinkingBlocks?.(response))) blocks.push(delta)
        calls = senseAdapter.senseCalls(response)
        stopReason = messageAdapter.stopReason?.(response)
        hasCompletedServerTool = (messageAdapter.serverToolCalls?.(response) ?? []).some(
          (c) => c.status === 'completed',
        )
      }
      callCompleted = true
      if (sourceStep) ctx.requestSourceStepStarted = true
    } catch (error) {
      if (options.signal?.aborted) throw error
      const status =
        typeof error === 'object' &&
        error !== null &&
        'status' in error &&
        Number.isInteger(error.status)
          ? Number(error.status)
          : undefined
      const diagnostic = error instanceof ClassifiedError ? error : undefined
      logger.event(
        'plugin.model.failed',
        {
          category: classifyError(error),
          ...(status ? { status } : {}),
          ...(diagnostic?.errorId ? { errorId: diagnostic.errorId } : {}),
        },
        LogLevel.error,
      )
      // Provider errors already carry a sanitized detail and stable identity.
      // Do not replace them with a generic error or log raw SDK bodies/requests.
      if (diagnostic) throw diagnostic
      throw new ClassifiedError({
        message: status ? `Plugin model request failed (HTTP ${status})` : 'Plugin model request failed',
        category: classifyError(error),
        source: 'brain',
        userMessage: '请求后端模型失败，请稍后再试。',
        ...(status ? { detail: `upstream HTTP ${status}` } : {}),
        cause: error,
      })
    } finally {
      if (capacityOperationId && prepared.source) failSourceCapacity(prepared.source, capacityOperationId, options.signal)
      sourceStep?.observation.finish(callCompleted ? 'completed' : options.signal?.aborted ? 'cancelled' : 'failed')
    }
    options.signal?.throwIfAborted()
    if (ctx.requestToolPhase?.length && (calls.length !== 1 || !ctx.requestToolPhase.includes(calls[0]!.name ?? ''))) {
      if (turn > 0) throw new Error('Required request decision was not returned')
      history.push({ id: randomUUID(), role: 'user', content: '本轮仅允许工具决策。请单独调用当前提供的决策工具，参数严格依据当前上下文；不要输出正文，不要调用其他工具。', createdAt: Date.now(), updateAt: Date.now(), ephemeral: true })
      continue
    }
    await dispatchPostLLMResponse(ctx, {
      provider: runtime.brain.provider,
      content,
      thinking: thinking || undefined,
      thinkingBlocks: blocks.toArray(),
      senseCalls: calls.map((call) => ({
        id: call.id,
        name: call.name ?? '',
        arguments: call.arguments,
      })),
    })
    options.signal?.throwIfAborted()
    if (!calls.length || (stopReason === 'end_turn' && hasCompletedServerTool)) {
      await dispatchStop(ctx, { chatId: ctx.soul.chatId, message: content, stopReason: stopReason ?? 'end_turn' })
      yield { type: 'stream', contentDelta: content, thinkingDelta: '' }
      return
    }
    const now = Date.now()
    const complete = calls.map((call) => ({
      id: call.id || randomUUID(),
      name: call.name || '',
      arguments: call.arguments,
    }))
    // Questions leave request-local history: the durable checkpoint must own
    // their assistant/tool placeholders so the existing batch answer contract
    // can replace them and resume without replaying any preceding tool.
    const questions = complete.filter(call => call.name === 'ask_user_question')
    if (questions.length) {
      yield { type: 'stream', contentDelta: content, thinkingDelta: thinking,
        thinkingBlocksDelta: completeThinkingBlockDeltas(blocks.toArray()), senseDelta: complete.map((call, index) => ({ ...call, index })) }
      // The normal tool middleware executes these calls once and checkpoint
      // persists their results; do not also execute them in this local loop.
      return
    }
    const assistantMessage: LLMResponse = {
      id: randomUUID(),
      role: 'assistant',
      content,
      thinking,
      thinkingBlocks: blocks.toArray(),
      senseCalls: complete,
      createdAt: now,
      updateAt: now,
    }
    if (sourceRun && runId) sourceRun.repo.saveRunMessage(sourceRun.authority, sourceRun.input.scopeId, runId, assistantMessage, 'completed')
    history.push(assistantMessage)
    const toolMessages = new Map(complete.map(call => {
      const message: LLMResponse = { id: call.id, role: 'sense', content: '', createdAt: now, updateAt: now }
      if (sourceRun && runId) sourceRun.repo.saveRunMessage(sourceRun.authority, sourceRun.input.scopeId, runId, message, 'planned')
      return [call.id, message] as const
    }))
    for (const call of complete) {
      if (options.signal?.aborted) throw new Error('Request cancelled')
      const toolMessage = toolMessages.get(call.id)!
      const execution = executeRequestTool(ctx, call.name, call.arguments, call.id, result => {
        if (sourceRun && runId) sourceRun.repo.saveToolObservation(sourceRun.authority, sourceRun.input.scopeId, runId, call.id, call.name, result)
      })
      let step = await execution.next()
      while (!step.done) {
        if (step.value.type === 'sense_started' && sourceRun && runId)
          sourceRun.repo.saveRunMessage(sourceRun.authority, sourceRun.input.scopeId, runId, toolMessage, 'started')
        yield step.value
        step = await execution.next()
      }
      toolMessage.content = step.value
      toolMessage.updateAt = Date.now()
      if (sourceRun && runId) sourceRun.repo.saveRunMessage(sourceRun.authority, sourceRun.input.scopeId, runId, toolMessage, 'completed')
      history.push(toolMessage)
      // A plugin may normally complete this request after its tool result is recorded.
      // Do not start another provider turn or execute remaining calls.
      if (ctx.requestComplete || ctx.soul.yieldTurn) return
    }
  }
  throw new Error('Request tool iteration limit reached')
}

/** Stop waiting even if an upstream adapter fails to settle after its signal is aborted. */
async function* withModelDeadline<T>(
  source: AsyncGenerator<T>,
  deadline: Promise<never>,
  enabled: boolean,
): AsyncGenerator<T> {
  if (!enabled) {
    yield* source
    return
  }
  let finished = false
  try {
    while (true) {
      const result = await Promise.race([source.next(), deadline])
      if (result.done) {
        finished = true
        return
      }
      yield result.value
    }
  } finally {
    if (!finished) void source.return(undefined).catch(() => {})
  }
}

/**
 * 处理流式调用
 */
async function* handleStream(
  ctx: MiddlewareContext,
  options: LLMOptions,
  llmAdapter: RuntimeConfig['adapters']['llmAdapter'],
  messageAdapter: RuntimeConfig['adapters']['messageAdapter'],
  senseAdapter: RuntimeConfig['adapters']['senseAdapter'],
  messages: unknown[],
  senses: SenseFunction[],
): AsyncGenerator<StreamChunk> {
  reportWorkflow(ctx.soul.chatId, {
    activeNodeId: 'model',
    phaseLabel: '调用中',
    waitReason: 'model',
  })
  const streamIterator = await llmAdapter.chatStream(messages, senses, options)
  reportWorkflow(ctx.soul.chatId, { activeNodeId: 'model', phaseLabel: '处理响应' })

  let chunkCount = 0
  let thinkingAccumulated = ''
  let contentAccumulated = ''
  const senseCallsAccumulated: SenseCallData[] = []
  // Anthropic 扩展：累积 thinking blocks（含 signature）；仅当 provider 实现 extractStreamThinkingBlocks 时填充。
  const thinkingAssembler = new ThinkingBlockAssembler()
  const pending: StreamChunk[] = []
  // Response policies hold output until approval; streams without a policy stay live.
  const holdOutput =
    functionHooks('PostLLMResponse').length > 0 ||
    (loadHookRegistry().PostLLMResponse ?? []).some(
      (hook) => !hook.brain || hook.brain === options.brain,
    )

  for await (const rawChunk of streamIterator) {
    options.observation?.response(rawChunk)
    chunkCount++

    // 提取增量
    const thinkingDelta = messageAdapter.extractStreamThinking?.(rawChunk) || ''
    const contentDelta = messageAdapter.extractStreamDelta?.(rawChunk) || ''
    const thinkingBlocksDelta: ThinkingBlockDelta[] =
      messageAdapter.extractStreamThinkingBlocks?.(rawChunk) ?? []
    const serverToolDeltas: ServerToolCallDelta[] =
      messageAdapter.extractStreamServerToolDeltas?.(rawChunk) ?? []
    const stopReason = messageAdapter.extractStreamStopReason?.(rawChunk)

    // 提取 sense call 增量
    const senseDelta = senseAdapter.extractSenseCallDeltas(rawChunk)

    // 累积内容（用于完成时汇总事件）
    thinkingAccumulated += thinkingDelta
    contentAccumulated += contentDelta
    if (senseDelta.length > 0) {
      senseCallsAccumulated.push(...senseDelta)
    }
    for (const op of thinkingBlocksDelta) thinkingAssembler.push(op)

    // yield stream chunk（包含 senseDelta / serverToolDeltas / stopReason）
    if (
      thinkingDelta ||
      contentDelta ||
      senseDelta.length > 0 ||
      thinkingBlocksDelta.length > 0 ||
      serverToolDeltas.length > 0 ||
      stopReason
    ) {
      const chunk: StreamChunk = {
        type: 'stream',
        thinkingDelta,
        contentDelta,
        senseDelta: senseDelta.length > 0 ? senseDelta : undefined,
        thinkingBlocksDelta: thinkingBlocksDelta.length > 0 ? thinkingBlocksDelta : undefined,
        serverToolDeltas: serverToolDeltas.length > 0 ? serverToolDeltas : undefined,
        ...(stopReason ? { stopReason } : {}),
      }
      if (holdOutput) pending.push(chunk)
      else yield chunk
    }
  }

  // ========== 流式响应完成 ==========
  logger.event('llm.resp', {
    mode: 'stream',
    chunks: chunkCount,
    thinkingLen: thinkingAccumulated.length,
    contentLen: contentAccumulated.length,
    senseCalls: senseCallsAccumulated.length,
    thinkingBlocks: thinkingAssembler.toArray().length,
  })

  // PostLLMResponse + Stop hook（流式末尾）
  options.signal?.throwIfAborted()
  await dispatchPostLLMResponse(ctx, {
    provider: ctx.runtime?.brain.provider ?? '',
    content: contentAccumulated,
    thinking: thinkingAccumulated || undefined,
    thinkingBlocks:
      thinkingAssembler.toArray().length > 0 ? thinkingAssembler.toArray() : undefined,
    senseCalls: senseCallsAccumulated.map((sc) => ({
      id: sc.id,
      name: sc.name ?? '',
      arguments: sc.arguments,
    })),
  })
  options.signal?.throwIfAborted()
  if (!senseCallsAccumulated.length)
    await dispatchStop(ctx, {
      chatId: ctx.soul.chatId,
      message: contentAccumulated,
      stopReason: 'end_turn',
    })
  for (const chunk of pending) yield chunk
}

/**
 * 处理非流式调用
 */
async function* handleNonStream(
  ctx: MiddlewareContext,
  options: LLMOptions,
  llmAdapter: RuntimeConfig['adapters']['llmAdapter'],
  messageAdapter: RuntimeConfig['adapters']['messageAdapter'],
  senseAdapter: RuntimeConfig['adapters']['senseAdapter'],
  messages: unknown[],
  senses: SenseFunction[],
): AsyncGenerator<StreamChunk> {
  reportWorkflow(ctx.soul.chatId, {
    activeNodeId: 'model',
    phaseLabel: '调用中',
    waitReason: 'model',
  })
  const response = await llmAdapter.chat(messages, senses, options)
  options.observation?.response(response)
  reportWorkflow(ctx.soul.chatId, { activeNodeId: 'model', phaseLabel: '处理响应' })

  // 提取内容和思考
  const content = messageAdapter.content(response)
  const thinking = messageAdapter.thinking?.(response)
  const thinkingBlocks = messageAdapter.thinkingBlocks?.(response)
  const stopReason = messageAdapter.stopReason?.(response)
  const serverToolCalls = messageAdapter.serverToolCalls?.(response) ?? []
  const serverToolDeltas: ServerToolCallDelta[] = serverToolCalls.flatMap((c): ServerToolCallDelta[] => [
    {
      kind: 'start',
      index: c.index ?? 0,
      id: c.id,
      name: c.name,
      arguments: c.arguments,
      status: c.status,
      ...(c.protocol ? { protocol: c.protocol } : {}),
      ...(c.responseId ? { responseId: c.responseId } : {}),
    },
    ...(c.result !== undefined || c.error !== undefined || c.sources
      ? [
          {
            kind: 'result' as const,
            index: c.index ?? 0,
            callId: c.id,
            name: c.name,
            result: c.result,
            ...(c.error ? { error: c.error } : {}),
            status: c.status === 'failed' ? ('failed' as const) : ('completed' as const),
            ...(c.sources ? { sources: c.sources } : {}),
          },
        ]
      : []),
  ])

  // 提取 sense calls（非流式为完整数据）
  const senseDelta = senseAdapter.senseCalls(response)

  // ========== 非流式响应汇总 ==========
  logger.event('llm.resp', {
    mode: 'non-stream',
    thinkingLen: thinking?.length ?? 0,
    contentLen: content?.length ?? 0,
    senseCalls: senseDelta.length,
    serverToolCalls: serverToolCalls.length,
  })

  // PostLLMResponse + Stop hook（非流式末尾）
  options.signal?.throwIfAborted()
  await dispatchPostLLMResponse(ctx, {
    provider: ctx.runtime?.brain.provider ?? '',
    content,
    thinking,
    thinkingBlocks,
    senseCalls: senseDelta.map((sc) => ({
      id: sc.id,
      name: sc.name ?? '',
      arguments: sc.arguments,
    })),
  })
  options.signal?.throwIfAborted()
  if (!senseDelta.length)
    await dispatchStop(ctx, {
      chatId: ctx.soul.chatId,
      message: content,
      stopReason: stopReason ?? 'end_turn',
    })
  if (content || thinking || senseDelta.length > 0 || serverToolDeltas.length > 0 || stopReason)
    yield {
      type: 'stream',
      thinkingDelta: thinking || '',
      thinkingBlocksDelta: completeThinkingBlockDeltas(thinkingBlocks),
      contentDelta: content || '',
      senseDelta: senseDelta.length > 0 ? senseDelta : undefined,
      serverToolDeltas: serverToolDeltas.length > 0 ? serverToolDeltas : undefined,
      ...(stopReason ? { stopReason } : {}),
    }
}

// ========== Hooks dispatch helpers ==========

/** Hook transport failures are logged; each hook still owns its block decision. */
async function runHookFailOpen(
  event: string,
  action: () => Promise<void>,
  onBlock?: (error: ClassifiedError) => void,
): Promise<void> {
  try {
    await action()
  } catch (error) {
    if (error instanceof ClassifiedError) {
      if (onBlock) onBlock(error)
      else throw error
      return
    }
    logger.event('hook.dispatch.failed', { event, error: (error as Error).message })
  }
}

/** PostLLMResponse dispatch：响应侧审计；decision:'block' 抛 ClassifiedError；异常 fail-open */
async function dispatchPostLLMResponse(
  ctx: MiddlewareContext,
  payload: {
    provider: string
    content: string
    thinking?: string
    thinkingBlocks?: import('@/core/message/adapter.js').ThinkingBlock[]
    senseCalls?: { id: string; name: string; arguments: string }[]
  },
): Promise<void> {
  await runHookFailOpen('PostLLMResponse', async () => {
    await dispatch(
      'PostLLMResponse',
      {
        ...payload,
        model: ctx.runtime?.brain.model ?? '',
      },
      requestHookContext(ctx),
    )
  })
}

/** Stop dispatch：LLM 响应结束后审计；decision:'block' 仅 log warn（本轮不阻断） */
async function dispatchStop(
  ctx: MiddlewareContext,
  payload: {
    chatId: string
    message: string
    stopReason: string
  },
): Promise<void> {
  await runHookFailOpen(
    'Stop',
    async () => {
      await dispatch('Stop', payload, requestHookContext(ctx))
    },
    (error) => {
      logger.event('hook.dispatch.failed', { event: 'Stop', error: error.message })
    },
  )
}
import { DEFAULT_GLOBAL_OPTIONS } from '@chery/protocol'
