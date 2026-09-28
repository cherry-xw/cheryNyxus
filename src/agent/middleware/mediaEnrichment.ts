import type { MiddlewareContext, RuntimeConfig } from '@/core/middleware/types'
import type { LLMResponse, LLMAttachment } from '@/core/message/adapter'
import { readMediaAsset, mediaKindForMime, type MediaKind } from '@/service/media/index.js'
import config, { isOrdinaryRole } from '@/utils/config.js'

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
 * 输入处理双轨（旧媒体网关 understand 转写已随破坏性收尾移除）：
 *   - 脑 capabilities.input.image=true + 至少一个 marker → 走多模态：readMediaAsset 同步读 base64，
 *     按消息归属生成临时 attachments（messageId 指向原消息，provider 按 id 挂图），
 *     从对应消息 content 移除 marker（无论是否支持都移除，避免 LLM 看到无意义标记），
 *     不支持的 kind 收集到 unsupportedMedia 供 capabilitiesHint 用。
 *   - 否则走前置工具调度（enrichMediaInputsPreprocess）：命中 accepts+preprocess 的工具
 *     执行并把结果替换进消息；无命中则保持原消息（marker 原样保留）。
 * capabilitiesHint：有 [[media:]] marker 时生成 <self-capabilities> 段，声明自身能力 + 不支持附件的委派建议。
 *
 * 多模态旁路的多轮保留策略（P5c）：
 *   - 近 MEDIA_RETENTION_TURNS 轮（最后几条带 marker 的 user 消息）的图片全程重发（挂回原消息位置）；
 *   - 更早轮次的图片从上下文移除，原位替换为一行占位文本（模型不再直接看到图，消息历史仍完整可回溯）；
 *   - 上下文内重发图片总量 / 单轮新增数 / 累计字节分别受 MEDIA_MAX_TOTAL / MEDIA_MAX_PER_TURN /
 *     MEDIA_MAX_BYTES 约束，超限把最旧的转占位。
 *   - 图片字节按压缩后 base64 之前的二进制计（上传原图可能更大，压缩属于前端上传侧行为）。
 */
export async function enrichMediaInputs(
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

  // 非多模态模型：尝试前置工具调度——扫描 [[media:]] 引用，把命中 accepts+preprocess
  // 工具的媒体类型交给工具执行，结果替换进消息（理解类媒体在无原生能力模型下的处理路径）。
  // 有工具命中的 kind 才介入；无命中则保持原消息（不再回退旧媒体网关 understand 转写，
  // 旧网关链路已随破坏性收尾移除）。
  const preprocessed = await enrichMediaInputsPreprocess(ctx, history)
  if (preprocessed.handled) {
    return {
      history: preprocessed.history,
      ...(preprocessed.capabilitiesHint ? { capabilitiesHint: preprocessed.capabilitiesHint } : {}),
    }
  }

  return { history }
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
      const result = await entry.execute({ text, media }, new Map<string, Map<string, unknown>>(), {
        chatId: ctx.soul.chatId,
      })
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
const MEDIA_PLACEHOLDER =
  '[此前上传的图片已从当前上下文移除，如需再次查看请在历史消息中把它重新带入。]'

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
