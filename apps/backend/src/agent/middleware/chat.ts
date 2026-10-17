import { enrichMediaInputs } from './mediaEnrichment.js'
import { saveFileRequestPlan, patchFileRequestPlan } from '@/service/fileServices/inputObservations.js'

import { executeRequestTool } from './tool.js'
import { randomUUID } from 'node:crypto'
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
  resolveCatalogThinkingParams,
} from '@/utils/modelCatalog.js'
import { resolveLlmProviderDefaultUrl } from '@chery/protocol'
import { resolveBrainProtocol } from '@/core/llm/routing.js'
import { logger, LogLevel } from '@/utils/logger/index.js'
import type {
  LLMResponse,
  LLMAttachment,
  ServerToolCallDelta,
  ThinkingBlockDelta,
} from '@/core/message/adapter'
import { ThinkingBlockAssembler } from '@/agent/provider/thinkingBlockAssembler.js'
import config from '@/utils/config.js'
import { dispatch } from '@/agent/hooks/index.js'
import { functionHooks } from '@/agent/hooks/functions.js'
import { loadHookRegistry } from '@/agent/hooks/registry.js'
import { ClassifiedError, classifyError } from '@/utils/error.js'
import { reportWorkflow } from '@/core/middleware/workflowObservation.js'
import { createRequestObservation } from '@/agent/provider/requestObservation.js'
import { estimateTokens } from '@/utils/token.js'
import { describeFileReferences } from '@/service/workspace/handler.js'
import { ModelRequestTimeoutError } from './requestTimeout.js'
import { SenseCallAssembler } from './senseCallAssembler.js'
import { requestHookContext, requestSignal } from '@/agent/hooks/request.js'

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
  const { llmAdapter, messageAdapter, senseAdapter } = ctx.runtime.adapters
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
  const { historyForBuild, attachments, fileProjection } = await prepareModelHistory(ctx, fileRequestId)

  // 使用预构建的 senses（runtime.builtSenses）
  const senses = ctx.runtime.builtSenses

  // 构建请求选项（P1-6：LLMOptions 显式类型，替代 Record<string, unknown>）
  // AND 闸：global.thinking 总闸关 → 强制 off；开 → 取 brain.thinking 显示词。
  // off 也过翻译：MiniMax/DeepSeek 等模型在 YAML 中为 off 声明了显式关闭片段（thinking:{type:disabled}）。
  const thinkingLevel: ThinkingLevel = ctx.global.thinking
    ? (ctx.runtime.brain.thinking ?? 'off')
    : 'off'
  const protocol = resolveBrainProtocol(ctx.runtime.brain)
  const options: LLMOptions = {
    model: ctx.runtime.brain.model,
    provider: ctx.runtime.brain.provider,
    ...(protocol ? { protocol } : {}),
    chatId: ctx.soul.chatId,
    url:
      ctx.runtime.brain.url ?? resolveLlmProviderDefaultUrl(ctx.runtime.brain.provider, protocol),
    key: ctx.runtime.brain.key,
    thinking: thinkingLevel,
    // 统一翻译点：显示词 → wire 参数片段；provider 只 spread 直传
    thinkingParams: resolveCatalogThinkingParams({
      model: ctx.runtime.brain.model,
      provider: ctx.runtime.brain.provider,
      protocol,
      display: thinkingLevel,
    }),
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
    ...(fileProjection.plan?.length ? { inputPreflight: {
      contextLimit: ctx.runtime.brain.contextLimit,
      report: (result: import('@/core/llm/adapter.js').InputTokenPreflight) => patchFileRequestPlan(ctx.soul.chatId, fileRequestId, result as unknown as Record<string, unknown>),
    } } : {}),
  }

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
  if (serializedBytes > 32 * 1024 * 1024) throw new ClassifiedError({ message: '序列化请求超过 32 MiB', userMessage: '本次请求内容过大，请减少文件内容输入', category: 'validation', source: 'chat' })
  const textChars = historyForBuild.filter(message => !message.modelExcluded && !message.revoked).reduce((total, message) => total + message.content.length + (message.thinking?.length ?? 0), 0)
  // 二进制大小不等于收费 token；未知的媒体计量不伪造为 0，也不套用某厂商公式。
  const conservativeTokens = Math.ceil(textChars / 2)
  const contextLimit = ctx.runtime.brain.contextLimit
  if (!options.inputPreflight && contextLimit && conservativeTokens > contextLimit) throw new ClassifiedError({ message: '保守文字上下文估算超过模型上限', userMessage: '本次文字内容可能超过模型上下文上限。请缩短历史后重试。图片等内容的收费 token 尚未确认，此值不是服务方收费量。', category: 'validation', source: 'chat' })

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
  const observation = options.observation
  options.observation = {
    ...observation,
    start(model) {
      requestSignal(ctx)?.throwIfAborted()
      ctx.requestExecution?.validate()
      fileProjection.commit?.()
      requestWasSent = true
      if (fileProjection.plan?.length) patchFileRequestPlan(ctx.soul.chatId, fileRequestId, { phase: 'sent' })
      observation.start(model)
    },
  }
  if (options.provider === 'mock' || options.protocol === 'mock') options.observation.start()
  // Deadline starts at the provider boundary, not while preparing context or waiting for tools.
  const timeoutMs = config.global.llm_request_timeout_ms ?? 10 * 60 * 1000
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
  let completed = false
  try {
    if (ctx.requestExecution?.execution?.toolHistory === 'request') {
      yield* withModelDeadline(
        handleRequestLocal(ctx, options, historyForBuild, attachments, fileRequestId),
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
async function prepareModelHistory(ctx: MiddlewareContext, requestId: string): Promise<{
  historyForBuild: LLMResponse[]
  attachments?: LLMAttachment[]
  fileProjection: Awaited<ReturnType<typeof enrichMediaInputs>>
}> {
  const enriched = await enrichMediaInputs(ctx, ctx.soul.messages || [])
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
        id: randomUUID(),
        role: 'system' as const,
        content: item.content,
        createdAt: Date.now(),
        updateAt: Date.now(),
      })),
      ...historyForBuild,
    ]
  return { historyForBuild, attachments: enriched.attachments, fileProjection: enriched }
}

/** Only the final answer leaves this request-local model/tool history. */
async function* handleRequestLocal(
  ctx: MiddlewareContext,
  options: LLMOptions,
  initial: LLMResponse[],
  attachments?: LLMAttachment[],
  fileRequestId?: string,
): AsyncGenerator<MiddlewareChunk> {
  const runtime = ctx.runtime!
  const { llmAdapter, messageAdapter, senseAdapter } = runtime.adapters
  const history = [...(ctx.soul.messages ?? [])]
  const temporaryPrompts = initial.filter(message => message.id !== 'file-input-capabilities' && !history.some(original => original.id === message.id) && message.role === 'system')
  const parentObservation = options.observation
  for (let turn = 0; turn < (ctx.global.maxLoopCount ?? 30); turn++) {
    if (options.signal?.aborted) throw new Error('Request cancelled')
    const enriched = turn > 0 ? await enrichMediaInputs(ctx, history) : undefined
    if (enriched) {
      attachments = enriched.attachments
      if (enriched.plan?.length && fileRequestId) patchFileRequestPlan(ctx.soul.chatId, fileRequestId, { phase: 'prepared', plan: enriched.plan, usage: enriched.usage })
      options.observation = parentObservation ? { ...parentObservation, start(model) { enriched.commit?.(); parentObservation.start(model) } } : undefined
    }
    const messages = messageAdapter.buildMessages(
      (enriched ? [
        ...temporaryPrompts,
        ...(enriched.capabilitiesHint ? [{ id: 'file-input-capabilities', role: 'system' as const, content: enriched.capabilitiesHint, createdAt: Date.now(), updateAt: Date.now() }] : []),
        ...enriched.history,
      ] : initial).filter((m) => !m.modelExcluded && !m.revoked),
      attachments,
      { anthropicOfficial: options.anthropicOfficial, protocol: options.protocol },
    )
    if (Buffer.byteLength(JSON.stringify({ messages, tools: runtime.builtSenses })) > 32 * 1024 * 1024) throw new ClassifiedError({ message: '序列化请求超过 32 MiB', userMessage: '本次请求内容过大，请减少文件内容输入', category: 'validation', source: 'chat' })
    let content = '',
      thinking = ''
    let calls: SenseCallData[]
    let stopReason: string | undefined
    let hasCompletedServerTool = false
    const blocks = new ThinkingBlockAssembler()
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
        calls = senseAdapter.senseCalls(response)
        stopReason = messageAdapter.stopReason?.(response)
        hasCompletedServerTool = (messageAdapter.serverToolCalls?.(response) ?? []).some(
          (c) => c.status === 'completed',
        )
      }
    } catch (error) {
      if (options.signal?.aborted) throw error
      const status =
        typeof error === 'object' &&
        error !== null &&
        'status' in error &&
        Number.isInteger(error.status)
          ? Number(error.status)
          : undefined
      logger.event(
        'plugin.model.failed',
        { category: classifyError(error), ...(status ? { status } : {}) },
        LogLevel.error,
      )
      throw new ClassifiedError({
        message: 'Plugin model request failed',
        category: classifyError(error),
        source: 'brain',
        userMessage: '请求后端模型失败，请稍后再试。',
      })
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
    history.push({
      id: randomUUID(),
      role: 'assistant',
      content,
      thinking,
      thinkingBlocks: blocks.toArray(),
      senseCalls: complete,
      createdAt: now,
      updateAt: now,
    })
    for (const call of complete) {
      if (options.signal?.aborted) throw new Error('Request cancelled')
      const result = yield* executeRequestTool(ctx, call.name, call.arguments, call.id)
      history.push({
        id: call.id,
        role: 'sense',
        content: result,
        createdAt: now,
        updateAt: Date.now(),
      })
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
