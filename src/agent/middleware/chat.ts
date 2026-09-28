import { enrichMediaInputs } from './mediaEnrichment.js'
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
import type { LLMResponse, LLMAttachment, ThinkingBlockDelta } from '@/core/message/adapter'
import { ThinkingBlockAssembler } from '@/agent/provider/thinkingBlockAssembler.js'
import config from '@/utils/config.js'
import { dispatch } from '@/agent/hooks/index.js'
import { ClassifiedError } from '@/utils/error.js'
import { reportWorkflow } from '@/core/middleware/workflowObservation.js'
import { createRequestObservation } from '@/agent/provider/requestObservation.js'
import { estimateTokens } from '@/utils/token.js'
import { describeFileReferences } from '@/service/workspace/handler.js'
import { ModelRequestTimeoutError } from './requestTimeout.js'

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
  // P5b：enrichMediaInputs 改为双轨——脑 input.image=true 时走多模态（marker 移除 + 临时 attachments），
  // 否则保留现有文本转写路径（marker 文本拼接）。attachments 不进 LLMResponse/DB，provider 调用后丢弃。
  // capabilitiesHint：有 [[media:]] marker 时生成 <self-capabilities> system message（运行时注入，不持久化）。
  const { historyForBuild, attachments } = await prepareModelHistory(ctx)

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
    signal: ctx.pipeline?.getAbortSignal(),
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
    if (ctx.global.stream) {
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
}

/** Prepare this request's media and temporary prompts without mutating stored history. */
async function prepareModelHistory(ctx: MiddlewareContext): Promise<{
  historyForBuild: LLMResponse[]
  attachments?: LLMAttachment[]
}> {
  const enriched = await enrichMediaInputs(ctx, ctx.soul.messages || [])

  // UserPromptSubmit hook：LLM 调用前验证/增强 prompt；decision:'block' 抛 ClassifiedError 终止本 chat
  await runHookFailOpen('UserPromptSubmit', async () => {
    const lastUser = [...enriched.history].reverse().find((m) => m.role === 'user')
    await dispatch(
      'UserPromptSubmit',
      {
        chatId: ctx.soul.chatId,
        prompt: lastUser?.content ?? '',
        role: (lastUser?.role ?? 'user') as 'user' | 'role' | 'subagent',
      },
      { brain: '' },
    )
  })

  // 运行时注入 <self-capabilities> system message（仅当有 [[media:]] marker 时生成）。
  // 浅拷贝 history 避免污染 soul（checkpoint 中间件不持久化此段）。
  let historyForBuild = enriched.history
  if (enriched.capabilitiesHint) {
    historyForBuild = [
      {
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

  return { historyForBuild, attachments: enriched.attachments }
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

  for await (const rawChunk of streamIterator) {
    options.observation?.response(rawChunk)
    chunkCount++

    // 提取增量
    const thinkingDelta = messageAdapter.extractStreamThinking?.(rawChunk) || ''
    const contentDelta = messageAdapter.extractStreamDelta?.(rawChunk) || ''
    const thinkingBlocksDelta: ThinkingBlockDelta[] =
      messageAdapter.extractStreamThinkingBlocks?.(rawChunk) ?? []

    // 提取 sense call 增量
    const senseDelta = senseAdapter.extractSenseCallDeltas(rawChunk)

    // 累积内容（用于完成时汇总事件）
    thinkingAccumulated += thinkingDelta
    contentAccumulated += contentDelta
    if (senseDelta.length > 0) {
      senseCallsAccumulated.push(...senseDelta)
    }
    for (const op of thinkingBlocksDelta) thinkingAssembler.push(op)

    // yield stream chunk（包含 senseDelta）
    if (thinkingDelta || contentDelta || senseDelta.length > 0 || thinkingBlocksDelta.length > 0) {
      yield {
        type: 'stream',
        thinkingDelta,
        contentDelta,
        senseDelta: senseDelta.length > 0 ? senseDelta : undefined,
        thinkingBlocksDelta: thinkingBlocksDelta.length > 0 ? thinkingBlocksDelta : undefined,
      }
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
  await dispatchStop({
    chatId: ctx.soul.chatId,
    message: contentAccumulated,
    stopReason: 'end_turn',
  })
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

  // 提取 sense calls（非流式为完整数据）
  const senseDelta = senseAdapter.senseCalls(response)

  // ========== 非流式响应汇总 ==========
  logger.event('llm.resp', {
    mode: 'non-stream',
    thinkingLen: thinking?.length ?? 0,
    contentLen: content?.length ?? 0,
    senseCalls: senseDelta.length,
  })

  // yield stream chunk（包含 senseDelta）
  if (content || thinking || senseDelta.length > 0) {
    yield {
      type: 'stream',
      thinkingDelta: thinking || '',
      contentDelta: content || '',
      senseDelta: senseDelta.length > 0 ? senseDelta : undefined,
    }
  }

  // PostLLMResponse + Stop hook（非流式末尾）
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
  await dispatchStop({
    chatId: ctx.soul.chatId,
    message: content,
    stopReason: 'end_turn',
  })
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
  await runHookFailOpen(
    'PostLLMResponse',
    async () => {
      await dispatch(
        'PostLLMResponse',
        {
          ...payload,
          model: ctx.runtime?.brain.model ?? '',
        },
        { brain: '' },
      )
    },
    (error) => {
      logger.event(
        'hook.blocked',
        { event: 'PostLLMResponse', reason: error.userMessage },
        LogLevel.error,
      )
    },
  )
}

/** Stop dispatch：LLM 响应结束后审计；decision:'block' 仅 log warn（本轮不阻断） */
async function dispatchStop(payload: {
  chatId: string
  message: string
  stopReason: string
}): Promise<void> {
  await runHookFailOpen(
    'Stop',
    async () => {
      const decision = await dispatch('Stop', payload, { brain: '' })
      if (decision?.decision === 'block') {
        // 本轮仅审计 log：真正的"强制继续"需 loop.ts 配合（后续扩展）
        logger.event('hook.stop.block', {
          chatId: payload.chatId,
          reason: decision.reason,
          note: '本轮仅审计，未阻断',
        })
      }
    },
    (error) => {
      logger.event('hook.dispatch.failed', { event: 'Stop', error: error.message })
    },
  )
}
