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
import {
  readMediaAsset,
  understandMediaReference,
  mediaKindForMime,
  type MediaKind,
} from '@/service/media/index.js'
import config, { isOrdinaryRole } from '@/utils/config.js'
import { dispatch } from '@/agent/hooks/index.js'
import { ClassifiedError } from '@/utils/error.js'
import { reportWorkflow } from '@/core/middleware/workflowObservation.js'
import { createRequestObservation } from '@/agent/provider/requestObservation.js'
import { estimateTokens } from '@/utils/token.js'
import { describeFileReferences } from '@/service/workspace/handler.js'

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
  const enriched = await enrichMediaInputs(ctx, ctx.soul.messages || [])

  // UserPromptSubmit hook：LLM 调用前验证/增强 prompt；decision:'block' 抛 ClassifiedError 终止本 chat
  try {
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
  } catch (err) {
    if (err instanceof ClassifiedError) throw err
    // 非 ClassifiedError（hook 异常）：log + 不阻断（fail-open）
    logger.event('hook.dispatch.failed', {
      event: 'UserPromptSubmit',
      error: (err as Error).message,
    })
  }

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
  if (fileReferences) historyForBuild = [...historyForBuild, {
    role: 'user', content: fileReferences, createdAt: Date.now(), updateAt: Date.now(),
  } as LLMResponse]

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

  const messages = messageAdapter.buildMessages(historyForBuild, enriched.attachments, {
    anthropicOfficial: options.anthropicOfficial,
    protocol: options.protocol,
    reasoningHistory: resolveCatalogReasoningHistory({
      model: options.model,
      provider: options.provider,
      protocol: options.protocol,
    }),
  })

  // ========== 空上下文守卫 ==========
  // 纪元切换后 loadHistory 可能只有 system 内容（frozen prompt / epoch handoff / carryover 重构失败时），
  // 纯 system 列表发往 LLM 会被上游拒绝（MiniMax 400 2013 / new-api `field messages is required`）。
  // 在此拦截（category=validation、source=chat，不进 retry；文案见 error-conventions.md / context-epochs.md）。
  // 有媒体附件（多模态旁路 content 被清空）不算空。
  const hasUserContent =
    (enriched.attachments?.length ?? 0) > 0 ||
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
      system: estimateTokens(historyForBuild.filter((m) => m.role === 'system').map((m) => m.content).join('\n')),
      tools: estimateTokens(JSON.stringify(senses)),
      conversation: estimateTokens(JSON.stringify(historyForBuild.filter((m) => m.role !== 'system'))),
      limit: ctx.runtime.brain.contextLimit ?? null,
    },
  })
  if (options.provider === 'mock' || options.protocol === 'mock') options.observation.start()
  let completed = false
  try {
  if (ctx.global.stream) {
    // 流式调用
    yield* handleStream(ctx, options, llmAdapter, messageAdapter, senseAdapter, messages, senses)
  } else {
    // 非流式调用
    yield* handleNonStream(ctx, options, llmAdapter, messageAdapter, senseAdapter, messages, senses)
  }
  completed = true
  } finally {
    options.observation.finish(completed ? 'completed' : options.signal?.aborted ? 'cancelled' : 'failed')
  }

  // 执行下游
  yield* next()
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

export default chatMiddleware

/**
 * 查找具备指定 input kind 能力的角色列表。
 * 遍历 config.roles，检查角色 brain 的 capabilities.input[kind]。
 * 用于 capabilitiesHint 生成（告知主 agent 可委派的目標角色）。
 */
function findCapableRoles(kind: MediaKind): string[] {
  const result: string[] = []
  for (const [roleName, roleCfg] of Object.entries(config.roles ?? {})) {
    if (!isOrdinaryRole(roleCfg)) continue
    if (config.llm.brain[roleCfg.brain]?.capabilities?.input?.[kind]) {
      result.push(roleName)
    }
  }
  return result
}

/**
 * 构建 <self-capabilities> 运行时提示。
 * 仅当有 [[media:]] marker 时调用（无媒体附件的普通对话不注入）。
 * 内容：声明自身输入能力 + 不可处理附件的委派建议。
 */
function buildCapabilitiesHint(
  brain: {
    model: string
    capabilities?: { input?: { image?: boolean; video?: boolean; audio?: boolean } }
  },
  unsupportedMedia: { filename: string; kind: MediaKind }[],
): string | undefined {
  const caps = brain.capabilities?.input ?? {}
  const kinds: MediaKind[] = ['image', 'video', 'audio']
  const capsLine = kinds.map((k) => `${k} ${caps[k] ? '✓' : '✗'}`).join(', ')

  let hint = `<self-capabilities>
当前大脑：${brain.model}
输入能力：${capsLine}`

  if (unsupportedMedia.length > 0) {
    hint += '\n不支持的媒体类型需通过 spawn_role 委派给具备对应输入能力的角色处理。'
    hint += '\n当前不可处理的附件：'

    // 按 kind 分组，找 capable roles
    const byKind = new Map<MediaKind, string[]>()
    for (const { filename, kind } of unsupportedMedia) {
      if (!byKind.has(kind)) byKind.set(kind, [])
      byKind.get(kind)!.push(filename)
    }

    for (const [kind, filenames] of byKind) {
      const roles = findCapableRoles(kind)
      const rolesStr = roles.length > 0 ? roles.join(', ') : '（无可用角色）'
      for (const filename of filenames) {
        hint += `\n- ${kind} [[media:${filename}]]：可委派角色 ${rolesStr}`
      }
    }

    hint +=
      '\n建议：使用 spawn_role(wait=true) 将媒体附件的处理任务委派给对应角色，prompt 中包含 [[media:filename]] 标记以便角色通过媒体网关理解内容。'
  }

  hint += '\n</self-capabilities>'
  return hint
}

/**
 * 上传资产在用户文本中以 [[media:filename]] 标记传递；不改写持久化原文。
 * P5b 双轨：
 *   - 脑 capabilities.input.image=true + 至少一个 marker → 走多模态：readMediaAsset 同步读 base64，
 *     按消息归属生成临时 attachments（messageId 指向原消息，provider 按 id 挂图），
 *     从对应消息 content 移除 marker（无论是否支持都移除，避免 LLM 看到无意义标记），
 *     不支持的 kind 收集到 unsupportedMedia 供 capabilitiesHint 用。
 *   - 否则保留旧行为：调媒体网关 understandMediaReference → 把理解文本追加到 last.content。
 * capabilitiesHint：有 [[media:]] marker 时生成 <self-capabilities> 段，声明自身能力 + 不支持附件的委派建议。
 *
 * 多模态旁路的多轮保留策略（P5c）：
 *   - 近 MEDIA_RETENTION_TURNS 轮（最后几条带 marker 的 user 消息）的图片全程重发（挂回原消息位置）；
 *   - 更早轮次的图片从上下文移除，原位替换为一行占位文本（模型不再直接看到图，消息历史仍完整可回溯）；
 *   - 上下文内重发图片总量 / 单轮新增数 / 累计字节分别受 MEDIA_MAX_TOTAL / MEDIA_MAX_PER_TURN /
 *     MEDIA_MAX_BYTES 约束，超限把最旧的转占位。
 *   - 图片字节按压缩后 base64 之前的二进制计（上传原图可能更大，压缩属于前端上传侧行为）。
 */
async function enrichMediaInputs(
  ctx: MiddlewareContext,
  history: LLMResponse[],
): Promise<{ history: LLMResponse[]; attachments?: LLMAttachment[]; capabilitiesHint?: string }> {
  const brain = ctx.runtime?.brain
  if (!brain) return { history }

  const hasMarker = history.some(
    (m) => isUserRole(m.role) && /\[\[media:([a-f0-9-]+\.[a-z0-9]+)\]\]/i.test(m.content),
  )
  if (!hasMarker) return { history }

  // 脑 input 下任一 kind 支持原生多模态 → 多模态旁路（旁路内按 kind 过滤）
  const inputCaps = brain.capabilities?.input
  if (inputCaps && (inputCaps.image || inputCaps.video || inputCaps.audio)) {
    return enrichMediaInputsMultimodal(brain, history)
  }

  // 非多模态模型：先尝试前置工具调度——扫描 [[media:]] 引用，把命中 accepts+preprocess
  // 工具的媒体类型交给工具执行，结果替换进消息（理解类媒体在无原生能力模型下的处理路径）。
  // 有工具命中的 kind 才介入；否则回退旧路径（媒体网关 understand 文本转写）。
  const preprocessed = await enrichMediaInputsPreprocess(ctx, history)
  if (preprocessed.handled) {
    return {
      history: preprocessed.history,
      ...(preprocessed.capabilitiesHint ? { capabilitiesHint: preprocessed.capabilitiesHint } : {}),
    }
  }

  // 旧路径：marker 文本转写（只处理最后一条 user 消息，保持既有行为）
  return enrichMediaInputsLegacy(ctx, history)
}

/**
 * 前置工具调度：非多模态模型下，把最后一条 user 消息里的 [[media:]] 引用交给
 * capabilities.preprocess=true 且 accepts 命中媒体类型的工具执行，结果替换进消息。
 *
 * - 输入契约：工具的 schema 必须接受 `{ text, media: [{filename,mimeType,kind,size}] }`；
 *   text = 剥离媒体标记后的描述文字，media = 媒体项数组（工具内部按 batchSize 分批处理）。
 * - 输出契约：工具返回 `SenseResult.content`，替换对应 marker（同 kind 的多个 marker 共享一次
 *   调用，合并为一个结果段；未命中的 kind 保留原 marker 并收集进 capabilitiesHint 供委派建议）。
 * - 失败语义：工具执行抛错 → marker 替换为「[媒体附件处理失败，已跳过]」，不阻断整轮发送。
 * - 不持久化：仅替换本轮内存 history，不改写 DB 原始消息。
 * - 前置默认自动执行：用户已明确上传文件，不进入 smart 审批流。
 * - 无任何命中返回 handled=false，供上层回退旧路径（媒体网关 understand）。
 */
async function enrichMediaInputsPreprocess(
  ctx: MiddlewareContext,
  history: LLMResponse[],
): Promise<{ handled: boolean; history: LLMResponse[]; capabilitiesHint?: string }> {
  const last = history[history.length - 1]
  if (!last || last.role !== 'user') return { handled: false, history }
  const matches = [...last.content.matchAll(/\[\[media:([a-f0-9-]+\.[a-z0-9]+)\]\]/gi)]
  if (!matches.length) return { handled: false, history }

  const senseTable = ctx.runtime?.senseTable
  const brain = ctx.runtime?.brain
  if (!senseTable || senseTable.size === 0 || !brain) return { handled: false, history }

  // 1) 解析每个 marker：读资产 → kind；按 kind 分组
  type MarkerRef = {
    marker: string
    filename: string
    kind: MediaKind
    mimeType: string
    size: number
  }
  const byKind = new Map<MediaKind, MarkerRef[]>()
  for (const match of matches) {
    const filename = match[1]!
    const asset = await readMediaAsset(filename)
    if (!asset) continue
    const kind = mediaKindForMime(asset.mimeType)
    if (!kind) continue
    const list = byKind.get(kind) ?? []
    list.push({
      marker: match[0],
      filename,
      kind,
      mimeType: asset.mimeType,
      size: asset.data.byteLength,
    })
    byKind.set(kind, list)
  }
  if (byKind.size === 0) return { handled: false, history }

  // 2) 每个 kind 找一个匹配的前置工具（preprocess=true && accepts 包含该 kind）
  type ToolRef = { name: string; entry: import('@/core/middleware/types.js').SenseEntry }
  const toolByKind = new Map<MediaKind, ToolRef>()
  for (const kind of byKind.keys()) {
    for (const [name, entry] of senseTable) {
      const caps = entry.capabilities
      if (caps?.preprocess && caps.accepts?.includes(kind)) {
        toolByKind.set(kind, { name, entry })
        break
      }
    }
  }
  if (toolByKind.size === 0) return { handled: false, history }

  // 3) 对每个有工具匹配的 kind 执行一次调用，产出替换该 kind 全部 marker
  const text = last.content.replace(/\[\[media:[a-f0-9-]+\.[a-z0-9]+\]\]/gi, '').trim()
  const unsupportedMedia: { filename: string; kind: MediaKind }[] = []
  let replaced = last.content
  for (const [kind, { entry }] of toolByKind) {
    const refs = byKind.get(kind) ?? []
    const media = refs.map((r) => ({
      filename: r.filename,
      mimeType: r.mimeType,
      kind: r.kind,
      size: r.size,
    }))
    try {
      const result = await entry.execute(
        { text, media },
        new Map<string, Map<string, unknown>>(),
        { chatId: ctx.soul.chatId },
      )
      const output = `[${kind} 附件前置处理结果]\n${result.content}`
      for (const r of refs) replaced = replaced.replace(r.marker, output)
    } catch {
      for (const r of refs) replaced = replaced.replace(r.marker, '[媒体附件处理失败，已跳过]')
    }
  }
  for (const [kind, refs] of byKind) {
    if (toolByKind.has(kind)) continue
    for (const r of refs) unsupportedMedia.push({ filename: r.filename, kind })
  }

  const capabilitiesHint = buildCapabilitiesHint(brain, unsupportedMedia)
  return {
    handled: true,
    history: [...history.slice(0, -1), { ...last, content: replaced }],
    ...(capabilitiesHint ? { capabilitiesHint } : {}),
  }
}

/** 近几轮带图 user 消息内的图片全程重发（其余转占位）。 */
const MEDIA_RETENTION_TURNS = 3
/** 上下文内最多同时重发多少张图片。 */
const MEDIA_MAX_TOTAL = 10
/** 单轮（当前发送消息）最多新增重发多少张图片。 */
const MEDIA_MAX_PER_TURN = 5
/** 上下文内重发图片累计二进制字节上限（给单请求 64MB 留裕量）。 */
const MEDIA_MAX_BYTES = 16 * 1024 * 1024
/** 超出保留窗口/上限的图片在上下文中的占位文本（不带内部 marker，避免泄露）。 */
const MEDIA_PLACEHOLDER = '[此前上传的图片已从当前上下文移除，如需再次查看请在历史消息中把它重新带入。]'

function isUserRole(role: LLMResponse['role']): boolean {
  return role === 'user' || role === 'role' || role === 'subagent'
}

interface MediaMarkerCandidate {
  /** 消息在传入 history 中的下标（仅用于本轮窗口判定，attachments 用 messageId 归属）。 */
  index: number
  msg: LLMResponse
  matches: RegExpMatchArray[]
}

/** 多模态旁路：全历史 marker 解析 + 近 N 轮保留 + 上限约束。 */
async function enrichMediaInputsMultimodal(
  brain: RuntimeConfig['brain'],
  history: LLMResponse[],
): Promise<{ history: LLMResponse[]; attachments?: LLMAttachment[]; capabilitiesHint?: string }> {
  // 1) 收集所有带 marker 的 user 类消息（按顺序）
  const candidates: MediaMarkerCandidate[] = []
  history.forEach((msg, index) => {
    if (!isUserRole(msg.role)) return
    const matches = [...msg.content.matchAll(/\[\[media:([a-f0-9-]+\.[a-z0-9]+)\]\]/gi)]
    if (matches.length) candidates.push({ index, msg, matches })
  })
  if (!candidates.length) return { history }

  // 2) 保留窗口：最后 MEDIA_RETENTION_TURNS 条带 marker 的 user 消息重发，更早转占位
  const windowStart = Math.max(0, candidates.length - MEDIA_RETENTION_TURNS)
  const retained = candidates.slice(windowStart)
  const toPlaceholder = candidates.slice(0, windowStart)

  // 3) 预先决定每个 marker 的动作：'send' | 'placeholder' | 'unsupported' | 'missing'
  type MarkerDecision = {
    msgIndex: number
    match: RegExpMatchArray
    kind: MediaKind
    data: Buffer
    mimeType: string
  }
  const sendCandidates: MarkerDecision[] = []
  const unsupportedMedia: { filename: string; kind: MediaKind }[] = []
  const placeholderMarkers = new Map<number, string[]>() // msgIndex -> marker 文本
  const currentTurnIndex = retained[retained.length - 1]?.index

  for (const c of retained) {
    for (const match of c.matches) {
      const filename = match[1]!
      const asset = await readMediaAsset(filename)
      if (!asset) {
        // 资产失效：仅移除 marker，不占位、不挂图
        const list = placeholderMarkers.get(c.index) ?? []
        list.push(match[0])
        placeholderMarkers.set(c.index, list)
        continue
      }
      const kind = mediaKindForMime(asset.mimeType)
      if (!kind) {
        const list = placeholderMarkers.get(c.index) ?? []
        list.push(match[0])
        placeholderMarkers.set(c.index, list)
        continue
      }
      if (!brain.capabilities?.input?.[kind]) {
        // 脑不支持该 kind：移除 marker，收集到 unsupportedMedia 供 hint
        unsupportedMedia.push({ filename, kind })
        const list = placeholderMarkers.get(c.index) ?? []
        list.push(match[0])
        placeholderMarkers.set(c.index, list)
        continue
      }
      sendCandidates.push({
        msgIndex: c.index,
        match,
        kind,
        data: asset.data,
        mimeType: asset.mimeType,
      })
    }
  }

  // 4) 对可发送池按 新→旧 保留最新图片：超出总数/单轮/字节的，把最旧的转占位
  const placeholdersFromCap: MarkerDecision[] = []
  let totalCount = 0
  let currentTurnCount = 0
  let totalBytes = 0
  const sendDecisions: MarkerDecision[] = []
  for (const item of [...sendCandidates].reverse()) {
    const inCurrentTurn = item.msgIndex === currentTurnIndex
    const wouldExceedTurn = inCurrentTurn && currentTurnCount >= MEDIA_MAX_PER_TURN
    const wouldExceedTotal = totalCount >= MEDIA_MAX_TOTAL
    const wouldExceedBytes = totalBytes + item.data.byteLength > MEDIA_MAX_BYTES
    if (wouldExceedTurn || wouldExceedTotal || wouldExceedBytes) {
      placeholdersFromCap.push(item)
      continue
    }
    totalBytes += item.data.byteLength
    totalCount += 1
    if (inCurrentTurn) currentTurnCount += 1
    sendDecisions.push(item)
  }

  // 5) 重建 history：send → 移除 marker；占位（窗口外或超限）→ 替换占位文本
  const cleanedHistory = [...history]
  const markToPlace = (index: number, marker: string) => {
    const msg = cleanedHistory[index]
    if (!msg) return
    cleanedHistory[index] = { ...msg, content: msg.content.replace(marker, MEDIA_PLACEHOLDER) }
  }
  const markToRemove = (index: number, marker: string) => {
    const msg = cleanedHistory[index]
    if (!msg) return
    cleanedHistory[index] = { ...msg, content: msg.content.replace(marker, '').trim() }
  }
  for (const c of toPlaceholder) {
    for (const match of c.matches) markToPlace(c.index, match[0])
  }
  for (const [index, markers] of placeholderMarkers) {
    for (const marker of markers) markToRemove(index, marker)
  }
  for (const item of placeholdersFromCap) {
    markToPlace(item.msgIndex, item.match[0])
  }
  for (const item of sendDecisions) {
    markToRemove(item.msgIndex, item.match[0])
  }

  // 6) 组装 attachments（messageId 归属原消息）
  const attachments: LLMAttachment[] = sendDecisions.map((item) => ({
    mimeType: item.mimeType,
    data: item.data,
    kind: item.kind,
    messageId: history[item.msgIndex]?.id,
  }))

  const capabilitiesHint = buildCapabilitiesHint(brain, unsupportedMedia)
  return {
    history: cleanedHistory,
    ...(attachments.length > 0 && { attachments }),
    ...(capabilitiesHint && { capabilitiesHint }),
  }
}

/** 旧路径：marker 文本转写（仅最后一条 user 消息），保持既有行为。 */
async function enrichMediaInputsLegacy(
  ctx: MiddlewareContext,
  history: LLMResponse[],
): Promise<{ history: LLMResponse[]; capabilitiesHint?: string }> {
  const brain = ctx.runtime?.brain
  if (!brain) return { history }
  const last = history[history.length - 1]
  if (!last || last.role !== 'user') return { history }
  const matches = [...last.content.matchAll(/\[\[media:([a-f0-9-]+\.[a-z0-9]+)\]\]/gi)]
  if (!matches.length) return { history }

  const additions: string[] = []
  const unsupportedMedia: { filename: string; kind: MediaKind }[] = []
  for (const match of matches) {
    const filename = match[1]!
    try {
      const understood = await understandMediaReference(filename)
      if (!brain?.capabilities?.input?.[understood.kind]) {
        // 网关转写是原生多模态以外的降级路径：模型不直接接收二进制，
        // 但必须接收网关已经产出的文本，否则“配置网关即可理解媒体”的
        // 契约形同虚设。此处不再把成功结果误标为未发送。
        additions.push(`[${understood.kind} 附件网关理解结果]\n${understood.text}`)
      } else {
        additions.push(`[${understood.kind} 附件理解结果]\n${understood.text}`)
      }
    } catch (error) {
      additions.push(`[媒体附件处理失败，已跳过]`)
    }
  }
  const capabilitiesHint = buildCapabilitiesHint(brain, unsupportedMedia)
  return {
    history: [
      ...history.slice(0, -1),
      { ...last, content: `${last.content}\n\n${additions.join('\n\n')}` },
    ],
    ...(capabilitiesHint && { capabilitiesHint }),
  }
}

// ========== Hooks dispatch helpers ==========

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
  try {
    await dispatch(
      'PostLLMResponse',
      {
        ...payload,
        model: ctx.runtime?.brain.model ?? '',
      },
      { brain: '' },
    )
  } catch (err) {
    if (err instanceof ClassifiedError) {
      logger.event(
        'hook.blocked',
        { event: 'PostLLMResponse', reason: err.userMessage },
        LogLevel.error,
      )
    } else {
      logger.event('hook.dispatch.failed', {
        event: 'PostLLMResponse',
        error: (err as Error).message,
      })
    }
  }
}

/** Stop dispatch：LLM 响应结束后审计；decision:'block' 仅 log warn（本轮不阻断） */
async function dispatchStop(payload: {
  chatId: string
  message: string
  stopReason: string
}): Promise<void> {
  try {
    const decision = await dispatch('Stop', payload, { brain: '' })
    if (decision?.decision === 'block') {
      // 本轮仅审计 log：真正的"强制继续"需 loop.ts 配合（后续扩展）
      logger.event('hook.stop.block', {
        chatId: payload.chatId,
        reason: decision.reason,
        note: '本轮仅审计，未阻断',
      })
    }
  } catch (err) {
    logger.event('hook.dispatch.failed', { event: 'Stop', error: (err as Error).message })
  }
}
