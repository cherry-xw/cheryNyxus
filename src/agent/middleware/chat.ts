import type {
  MiddlewareContext,
  MiddlewareChunk,
  StreamChunk,
  RuntimeConfig,
} from '@/core/middleware/types'
import type { SenseFunction, SenseCallData } from '@/core/sense/adapter'
import type { LLMOptions } from '@/core/llm/adapter'
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

  // 使用预构建的 senses（runtime.builtSenses）
  const senses = ctx.runtime.builtSenses

  // 构建请求选项（P1-6：LLMOptions 显式类型，替代 Record<string, unknown>）
  const options: LLMOptions = {
    model: ctx.runtime.brain.model,
    chatId: ctx.soul.chatId,
    url: ctx.runtime.brain.url,
    key: ctx.runtime.brain.key,
    // AND 闸：global.thinking 总闸关 → 强制 off；开 → 取 brain.thinking 档位（ThinkingLevel，off/on/low/medium/high/xhigh）
    thinking: ctx.global.thinking ? (ctx.runtime.brain.thinking ?? 'off') : 'off',
    ...(ctx.runtime.brain.rpm && { rpm: ctx.runtime.brain.rpm }),
    // URL 完整性开关：true=url 已含版本段（/v1 等），provider 只拼 endpoint 不自动补全
    fullUrl: ctx.runtime.brain.fullUrl === true,
    // Anthropic 官方开关：brain.anthropicCompat.official=true 时保留 redacted_thinking 原样回传；
    // 默认 false → strip（兼容 3rd-party coding-plan 代理）。
    anthropicOfficial: ctx.runtime.brain.anthropicCompat?.official === true,
    signal: ctx.pipeline?.getAbortSignal(),
  }

  const messages = messageAdapter.buildMessages(historyForBuild, enriched.attachments, {
    anthropicOfficial: options.anthropicOfficial,
  })

  // ========== AI 输入参数日志 ==========
  logger.event('llm.req', {
    chatId: ctx.soul.chatId,
    provider: ctx.runtime.brain.provider || 'unknown',
    model: options.model,
    thinking: options.thinking ?? 'off',
    stream: !!ctx.global.stream,
    senseCount: senses.length,
    senseNames: senses.map((s) => s.function?.name || 'unknown'),
    msgCount: messages.length,
  })

  if (ctx.global.stream) {
    // 流式调用
    yield* handleStream(ctx, options, llmAdapter, messageAdapter, senseAdapter, messages, senses)
  } else {
    // 非流式调用
    yield* handleNonStream(ctx, options, llmAdapter, messageAdapter, senseAdapter, messages, senses)
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
  const streamIterator = await llmAdapter.chatStream(messages, senses, options)

  let chunkCount = 0
  let thinkingAccumulated = ''
  let contentAccumulated = ''
  const senseCallsAccumulated: SenseCallData[] = []
  // Anthropic 扩展：累积 thinking blocks（含 signature）；仅当 provider 实现 extractStreamThinkingBlocks 时填充。
  const thinkingAssembler = new ThinkingBlockAssembler()

  for await (const rawChunk of streamIterator) {
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
  const response = await llmAdapter.chat(messages, senses, options)

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
 *     从 last.content 移除 marker（无论是否支持都移除，避免 LLM 看到无意义标记），
 *     支持的 kind 进 attachments 数组，不支持的收集到 unsupportedMedia 供 capabilitiesHint 用。
 *   - 否则保留旧行为：调媒体网关 understandMediaReference → 把理解文本追加到 last.content。
 * capabilitiesHint：有 [[media:]] marker 时生成 <self-capabilities> 段，声明自身能力 + 不支持附件的委派建议。
 */
async function enrichMediaInputs(
  ctx: MiddlewareContext,
  history: LLMResponse[],
): Promise<{ history: LLMResponse[]; attachments?: LLMAttachment[]; capabilitiesHint?: string }> {
  const brain = ctx.runtime?.brain
  if (!brain) return { history }
  const last = history[history.length - 1]
  if (!last || last.role !== 'user') return { history }
  const matches = [...last.content.matchAll(/\[\[media:([a-f0-9-]+\.[a-z0-9]+)\]\]/gi)]
  if (!matches.length) return { history }

  // 脑 input 下任一 kind 支持原生多模态 → 多模态旁路（旁路内 :285 按 kind 过滤）
  const inputCaps = brain.capabilities?.input
  if (inputCaps && (inputCaps.image || inputCaps.video || inputCaps.audio)) {
    const attachments: LLMAttachment[] = []
    const unsupportedMedia: { filename: string; kind: MediaKind }[] = []
    let cleanedContent = last.content
    for (const match of matches) {
      const filename = match[1]!
      // 先从文本移除 marker（无论是否支持，避免 LLM 看到无意义 [[media:xxx]] 标记）
      cleanedContent = cleanedContent.replace(match[0], '').trim()

      const asset = await readMediaAsset(filename)
      if (!asset) continue
      const kind = mediaKindForMime(asset.mimeType)
      if (!kind) continue

      if (brain.capabilities?.input?.[kind]) {
        // 支持 → 多模态附件
        attachments.push({ mimeType: asset.mimeType, data: asset.data, kind })
      } else {
        // 不支持 → 收集到 unsupportedMedia（给 capabilitiesHint 用）
        unsupportedMedia.push({ filename, kind })
      }
    }
    // 即使 attachments 为空也返回（可能有 unsupportedMedia 需要生成 hint）
    if (attachments.length === 0 && unsupportedMedia.length === 0) return { history }
    const capabilitiesHint = buildCapabilitiesHint(brain, unsupportedMedia)
    return {
      history: [...history.slice(0, -1), { ...last, content: cleanedContent }],
      ...(attachments.length > 0 && { attachments }),
      ...(capabilitiesHint && { capabilitiesHint }),
    }
  }

  // 旧路径：marker 文本转写
  const additions: string[] = []
  const unsupportedMedia: { filename: string; kind: MediaKind }[] = []
  for (const match of matches) {
    const filename = match[1]!
    try {
      const understood = await understandMediaReference(filename)
      if (!brain.capabilities?.input?.[understood.kind]) {
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
