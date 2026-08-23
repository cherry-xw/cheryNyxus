/**
 * lite profile 发送端投影（MCU 精简 API，Track 1）
 *
 * 契约：docs/multi-agent-canonical-timeline.md §3.6 + docs/mcu-lite-api.md（v3.1 定稿）。
 * 设计红线：
 * - 单一事件产生面（streamMapper 等）不改写；裁剪只发生在发送端三出口
 *   （prepareSessionEvent 主收口 / interaction.changed 广播旁路 / RPC Response 帧）。
 * - 非 lite 连接零影响：所有入口先判 profile，未命中原样返回。
 * - 归属语义只扁平化不改写；子 chat done 纯抑制；role_reply 抑制（D16）。
 */

/** 连接级 lite profile（URL ?profile=lite&v=1 声明）。 */
export interface LiteProfile {
  kind: 'lite'
  /** lite 字段集版本；v1 冻结只增不改（D14）。 */
  v: number
  /** 设备可承受单帧上限（字节）。缺省 4096。 */
  maxFrameBytes: number
  /** 打字机增量订阅开关；默认关（D4/G1）。 */
  turnDelta: boolean
}

import { truncateByBytes, utf8ByteLength } from '@/utils/boundedContent.js'
import { getRootChatId } from '@/db/chat.js'

/** 当前支持的 lite 字段集版本。升级字段集必须发布新 v（D14）。 */
export const SUPPORTED_LITE_VERSIONS = [1] as const

export function isLiteState(state: unknown): state is { profile: LiteProfile } {
  return (
    !!state &&
    typeof state === 'object' &&
    'profile' in state &&
    !!(state as { profile?: unknown }).profile &&
    typeof (state as { profile?: { kind?: unknown } }).profile?.kind === 'string' &&
    (state as { profile: { kind: string } }).profile.kind === 'lite'
  )
}

// ---------------------------------------------------------------------------
// 事件白名单（mcu-lite-api.md §3.2 矩阵；子 chat 规则见 applyLiteEvent）
// ---------------------------------------------------------------------------

/** 完全抑制的事件类型（lite 连接不下发）。 */
const SUPPRESSED_NOTIFICATION_TYPES = new Set([
  'loaded', // V1 历史路径专用（F12）
  'replaced', // lean patch upsert 已表达同义
  'role_reply', // D16：与 return 节点无对齐键；子完成只靠 timeline patch return 节点
])

// staged chunk（thinking_end/content_end/sense_end）全部抑制——见 applyLiteEvent 的
// kind==='chunk' 分支（最终回复由 done.finalMessage + patch 权威下发，F2/G1）。

/** 需要字段投影精简的事件类型。 */
const PROJECTED_NOTIFICATION_TYPES = new Set([
  'done',
  'consumed',
  'accept',
  'rejected',
  'sense_started',
  'role_created',
  'timeline.patch',
  'input.updated', // T7 修正③：ack 路径携 content 全文回显
  'interrupt', // G4 审批全量但剔 waitTime/createdAt（C5，deadlineAt 单源）
])

/** 原样透传（信封仍最小化）的状态事件。 */
const PASSTHROUGH_NOTIFICATION_TYPES = new Set([
  'run.updated',
  'interaction.changed',
  'turn.started',
  'turn.completed',
  'question_batch_completed',
  'role_destroyed',
  'child_abandoned',
  'auto_compacted',
  'question_batch_requested', // 全量（G4）；2KB 硬保证属 T16 有界负载
  'error', // message 含 [tracingId] 前缀原样（F11）
  'question_requested', // 兼容历史重放的轻量事件，透传
  'question_answered',
  'sense.approval', // 防御：旧类型名不在矩阵但轻量，透传
])

// ---------------------------------------------------------------------------
// LeanTimelineNode 投影（canonical §3.6.2；三处共用）
// ---------------------------------------------------------------------------

/** summary 字节预算（B1：字节定义 ≤180B ≈ 60 中文字符）。 */
const SUMMARY_BYTE_BUDGET = 180

/** LeanTimelineNode：TimelineNode 的设备投影（有损、归属语义只扁平化不改写）。 */
export interface LeanTimelineNode {
  id: string
  kind: 'message' | 'return' | 'dispatch' | 'system'
  actorKind: 'user' | 'agent' | 'system'
  actorRoleType?: string
  direction: string
  orderKey: number
  status: 'committed' | 'revoked'
  createdAt: number
  summary: string
  contentLength: number
  toolNames?: string[]
  termination?: Record<string, unknown>
}

type UnknownRecord = Record<string, unknown>

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined
}

function projectTimelineNode(node: UnknownRecord): LeanTimelineNode | undefined {
  const id = typeof node.id === 'string' ? node.id : undefined
  if (!id) return undefined
  const content = typeof node.content === 'string' ? node.content : ''
  const actor = asRecord(node.actor)
  const actorKindRaw = typeof actor?.kind === 'string' ? actor.kind : 'system'
  // Actor.kind='tool' 不产生独立 lean 归属（其工具名并入 toolNames）——按 system 兜底。
  const actorKind: LeanTimelineNode['actorKind'] =
    actorKindRaw === 'user' || actorKindRaw === 'agent' || actorKindRaw === 'system'
      ? (actorKindRaw as LeanTimelineNode['actorKind'])
      : 'system'
  const lean: LeanTimelineNode = {
    id,
    kind:
      node.kind === 'return' || node.kind === 'dispatch' || node.kind === 'system'
        ? node.kind
        : 'message', // tool-batch/spawn/tool-group 归并进所属 message 节点
    actorKind,
    ...(typeof actor?.roleType === 'string' ? { actorRoleType: actor.roleType } : {}),
    direction: typeof node.direction === 'string' ? node.direction : 'internal',
    orderKey: typeof node.orderKey === 'number' ? node.orderKey : 0,
    status: node.status === 'revoked' ? 'revoked' : 'committed',
    createdAt: typeof node.createdAt === 'number' ? node.createdAt : 0,
    ...(() => {
      const cut = truncateByBytes(content, SUMMARY_BYTE_BUDGET)
      return {
        summary: cut.text,
        // contentLength 保持字符数口径（与 web 端 TimelineNode 一致）；字节口径经 contentHash 引用拉取。
        contentLength: content.length,
        ...(cut.truncated ? { contentHash: cut.contentHash } : {}),
      }
    })(),
  }
  const toolCalls = Array.isArray(node.toolCalls) ? node.toolCalls : []
  const toolNames = toolCalls
    .map((call) => {
      const rec = asRecord(call)
      return typeof rec?.name === 'string' ? rec.name : undefined
    })
    .filter((name): name is string => !!name)
  if (toolNames.length > 0) lean.toolNames = toolNames
  const termination = asRecord(node.termination)
  if (termination) lean.termination = termination
  return lean
}

// ---------------------------------------------------------------------------
// 通知 data 投影（按 §3.2 矩阵逐事件）
// ---------------------------------------------------------------------------

function pick(source: UnknownRecord, keys: readonly string[]): UnknownRecord {
  const out: UnknownRecord = {}
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key]
  }
  return out
}

/** 常量帧开销预算：截断/投影按 maxFrameBytes − ENVELOPE_OVERHEAD 计算有效载荷（B4）。 */
const ENVELOPE_OVERHEAD = 256

/** turn.delta 单帧 delta 本体字节预算（§3.7 P1-1：≤512B/帧）。 */
const TURN_DELTA_BYTE_BUDGET = 512

function projectNotificationData(
  type: string,
  data: UnknownRecord,
  profile: LiteProfile,
): UnknownRecord {
  switch (type) {
    case 'done': {
      // §3.4 DoneLeanData：去 contextBreakdown/used/total；finalMessage 截断。
      const projected: UnknownRecord = pick(data, ['canResume', 'finished'])
      // B-3（§3.9）：done.serverNow 每轮免费时钟校准——事件产生面（streamMapper）不改，
      // lite 投影层注入（wire 字段已在 DoneLeanData 契约与固件 model.c 消费，T28 补缺）。
      projected.serverNow = Date.now()
      const fm = asRecord(data.finalMessage)
      if (fm) {
        const content = typeof fm.content === 'string' ? fm.content : ''
        const budget = Math.max(0, profile.maxFrameBytes - ENVELOPE_OVERHEAD)
        const cut = truncateByBytes(content, budget)
        projected.finalMessage = {
          ...pick(fm, ['msgId', 'agentChatId']),
          content: cut.text,
          contentLength: content.length,
          ...(cut.truncated ? { contentHash: cut.contentHash } : {}),
        }
      }
      // done.contextUsage 线上形态是 0-1 number（types.ts DoneNotificationData），直接透传。
      if (typeof data.contextUsage === 'number') projected.contextUsage = data.contextUsage
      return projected
    }
    case 'consumed': {
      // D10：去 content，附 msgId。
      const projected = pick(data, ['count'])
      const messages = Array.isArray(data.messages) ? data.messages : []
      projected.messages = messages.map((m) => {
        const rec = asRecord(m) ?? {}
        return pick(rec, ['id', 'role', 'createdAt', 'msgId'])
      })
      return projected
    }
    case 'accept':
    case 'rejected': {
      // 去 result 全文（可达数十 KB），按需经 node.get。
      return pick(data, ['approvalId', 'senseName', 'ok'])
    }
    case 'sense_started': {
      // G3 工具名级：去 arguments。
      return pick(data, ['id', 'senseName'])
    }
    case 'role_created': {
      // 去 prompt/brain/senseGroup。
      return pick(data, ['taskId', 'childChatId', 'parentChatId', 'type', 'wake'])
    }
    case 'input.updated': {
      // T7 修正③：去 content（ack 路径全文回显 503B+；设备本地必有刚发送文本）。
      return pick(data, [
        'inputId',
        'clientMessageId',
        'messageId',
        'state',
        'queueSequence',
        'acceptedAt',
        'reason',
      ])
    }
    case 'interrupt': {
      // G4 审批决策依据全量（≤4KB 内）；C5：剔 waitTime/createdAt，倒计时统一 deadlineAt 单源。
      // 字段级智能截断（D3/A1）：保留全部键名与短字段全文，仅超长单字段截断并附引用——
      // write_file 类 {path 短, content 长} 的决策结构保持完整（头部截断=盲批，已否决）。
      const projected: UnknownRecord = { ...data }
      delete projected.waitTime
      delete projected.createdAt
      const budget = Math.max(0, profile.maxFrameBytes - ENVELOPE_OVERHEAD)
      const truncations = boundRecordFields(projected, budget)
      if (truncations.length > 0) projected.truncations = truncations
      return projected
    }
    case 'timeline.patch': {
      // §3.2：rootPatch.operations 的 upsert node → LeanTimelineNode；edges 不下发（D7）。
      const projected: UnknownRecord = pick(data, ['chatId', 'baseRevision', 'revision'])
      const rootPatch = asRecord(data.rootPatch)
      if (rootPatch) {
        projected.rootPatch = projectRootPatch(rootPatch)
      }
      const rootPatches = Array.isArray(data.rootPatches) ? data.rootPatches : []
      if (rootPatches.length > 0) {
        projected.rootPatches = rootPatches
          .map((rp) => asRecord(rp))
          .filter((rp): rp is UnknownRecord => !!rp)
          .map(projectRootPatch)
      }
      return projected
    }
    default:
      return data
  }
}

function projectRootPatch(rootPatch: UnknownRecord): UnknownRecord {
  const projected = pick(rootPatch, ['rootChatId', 'view', 'baseRevision', 'revision'])
  const operations = Array.isArray(rootPatch.operations) ? rootPatch.operations : []
  const leanOps: UnknownRecord[] = []
  for (const op of operations) {
    const rec = asRecord(op)
    if (!rec) continue
    if (rec.type === 'upsert') {
      const node = asRecord(rec.node)
      const lean = node ? projectTimelineNode(node) : undefined
      if (lean) leanOps.push({ type: 'upsert', node: lean })
      // 无法投影的 node（缺 id）直接丢弃——不发送无法解析的残缺节点
    } else if (rec.type === 'revoke' || rec.type === 'remove') {
      // 节点级删除/撤销保留（nodeId 引用）
      leanOps.push(pick(rec, ['type', 'nodeId']))
    } else if (rec.type === 'upsert-input' || rec.type === 'remove-input') {
      // input 状态保留（pendingInputs 恢复路径）
      leanOps.push(rec)
    }
    // edges（upsert-edge/remove-edge）、runs（upsert-run/remove-run）不下发：
    // MCU 无树视图（D7），run 态由 run.updated 事件权威表达。
  }
  projected.operations = leanOps
  return projected
}

// ---------------------------------------------------------------------------
// 信封最小化（§3.8/C 组：省 requestId/subscriptionId/eventSeq/rootEventSeq/sourceEventSeq）
// ---------------------------------------------------------------------------

const ENVELOPE_STRIP_KEYS = [
  'requestId',
  'subscriptionId',
  'eventSeq',
  'rootEventSeq',
  'sourceEventSeq',
] as const

function minimizeEnvelope(event: UnknownRecord): UnknownRecord {
  const out: UnknownRecord = { ...event }
  for (const key of ENVELOPE_STRIP_KEYS) delete out[key]
  // data.runId 与信封 runId 去重（T7 修正①的压缩）
  const runId = out.runId
  const data = asRecord(out.data)
  if (runId && data && data.runId === runId) {
    out.data = { ...data }
    delete (out.data as UnknownRecord).runId
  }
  return out
}

// ---------------------------------------------------------------------------
// 主入口：applyLiteEvent / applyLiteResponse
// ---------------------------------------------------------------------------

/**
 * 字段级智能截断（D3/A1，与 interaction/handler.ts boundApprovalPayload 同策略）：
 * 遍历 record 的顶层字符串字段，仅对超过 byteBudget 的字段按字节截断（不撕裂多字节），
 * 其余键名与短字段全文保留。返回截断引用列表（附在响应/事件的 truncations 字段）。
 */
function boundRecordFields(
  record: UnknownRecord,
  byteBudget: number,
): Array<{ field: string; contentLength: number; contentHash: string }> {
  const truncations: Array<{ field: string; contentLength: number; contentHash: string }> = []
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string') {
      const bytes = Buffer.byteLength(value, 'utf8')
      if (bytes <= byteBudget) continue
      const cut = truncateByBytes(value, byteBudget)
      record[key] = cut.text
      truncations.push({ field: key, contentLength: bytes, contentHash: cut.contentHash })
      continue
    }
    // 一层嵌套对象（如 arguments={path,content}）：逐字段截断，保键名结构（D3 决策结构完整）。
    const nested = asRecord(value)
    if (!nested) continue
    for (const [subKey, subValue] of Object.entries(nested)) {
      if (typeof subValue !== 'string') continue
      const bytes = Buffer.byteLength(subValue, 'utf8')
      if (bytes <= byteBudget) continue
      const cut = truncateByBytes(subValue, byteBudget)
      nested[subKey] = cut.text
      truncations.push({ field: key + '.' + subKey, contentLength: bytes, contentHash: cut.contentHash })
    }
  }
  return truncations
}

/**
 * 对 lite 连接应用事件投影（prepareSessionEvent 与 interaction.changed 旁路共用）。
 * @returns 投影后事件；undefined = 抑制不下发。非 lite 语义由调用方短路（本函数只处理 lite）。
 */
export function applyLiteEvent(
  profile: LiteProfile,
  event: unknown,
): unknown | undefined {
  // 注：turn.delta 超预算时返回 unknown[]（分片多帧），由 projectLite 摊平；其余类型单值。
  const rec = asRecord(event)
  if (!rec) return event

  // Chunk：stream（0x01 逐 token 旧通道）与 staged（thinking/content/sense_end）全部抑制（G1/T2-C4）。
  if (rec.kind === 'chunk') return undefined

  if (rec.kind === 'notification') {
    const type = typeof rec.type === 'string' ? rec.type : ''
    // 子 chat done 抑制（B-1 路由规则 1，mcu-lite-api.md §3.2）：最终回复只认 root
    // 维度的 done；子 chat done（信封 chatId=子 chat）整帧抑制——否则 MCU 会把子 agent
    // 的 done.finalMessage 当作本轮最终回复（多 agent 场景必现错乱）。done 信封只携
    // {chatId, runId}，root 判定经 getRootChatId；chat 已删除等异常路径按 root 处理透传。
    if (type === 'done' && typeof rec.chatId === 'string') {
      let isRoot = true
      try {
        isRoot = getRootChatId(rec.chatId) === rec.chatId
      } catch {
        isRoot = true
      }
      if (!isRoot) return undefined
    }
    if (SUPPRESSED_NOTIFICATION_TYPES.has(type)) return undefined
    if (type === 'turn.delta') {
      // D4：默认关；turnDelta=1 才订阅（单通道替代 0x01）。
      if (!profile.turnDelta) return undefined
      // §3.7 P1-1：delta 本体 ≤512B/帧；offset 单调（设备按 offset 重组，丢帧自愈）；
      // 分片不撕裂多字节字符。裁剪：仅保留 channel/offset/delta/turnId/messageId。
      const data = asRecord(rec.data) ?? {}
      const delta = typeof data.delta === 'string' ? data.delta : ''
      const leanData = pick(data, ['turnId', 'messageId', 'channel', 'offset'])
      if (utf8ByteLength(delta) <= TURN_DELTA_BYTE_BUDGET) {
        return minimizeEnvelope({ ...rec, data: { ...leanData, delta } })
      }
      // 超预算：字节分片（多帧由 applyLiteEventMulti 展开，每帧独立信封+连续 offset）。
      const frames: unknown[] = []
      let offset = typeof data.offset === 'number' ? data.offset : 0
      let rest = delta
      while (rest.length > 0) {
        const cut = truncateByBytes(rest, TURN_DELTA_BYTE_BUDGET)
        frames.push(
          minimizeEnvelope({ ...rec, data: { ...leanData, offset, delta: cut.text } }),
        )
        offset += cut.text.length // offset 按字符数递增（streamMapper 现状口径，:117-127 state.content += length）
        rest = rest.slice(cut.text.length)
      }
      return frames.length > 0 ? frames : undefined
    }
    if (PROJECTED_NOTIFICATION_TYPES.has(type)) {
      const data = asRecord(rec.data) ?? {}
      return minimizeEnvelope({ ...rec, data: projectNotificationData(type, data, profile) })
    }
    if (PASSTHROUGH_NOTIFICATION_TYPES.has(type)) {
      return minimizeEnvelope(rec)
    }
    // 未知类型：保守透传（v1 冻结集外的未来新增事件默认可达，字段只增不改语义下安全）。
    return minimizeEnvelope(rec)
  }

  return event
}

/**
 * 对 lite 连接应用 RPC Response 帧投影（timeline.get/open 的 LeanTimelineNode 投影，三处共用）。
 * 只做传输层裁剪，不改 handler 响应结构（serverNow/maxItems/node.get 等增强归 T16）。
 * @returns 投影后 Response；非 lite 或非目标方法原样返回。
 */
export function applyLiteResponse(
  profile: LiteProfile,
  response: unknown,
  requestParams?: unknown,
): unknown {
  const rec = asRecord(response)
  if (!rec || rec.success === false) return response
  const data = asRecord(rec.data)
  if (!data) return response

  // chat.timeline.get / chat.open 的 rootTimeline 节点投影。
  const timeline = asRecord(data.rootTimeline)
  if (timeline && Array.isArray(timeline.nodes)) {
    let projectedNodes = timeline.nodes
      .map((n) => asRecord(n))
      .map((n) => (n ? projectTimelineNode(n) : undefined))
      .filter((n): n is LeanTimelineNode => !!n)
    // D6 双做（lite 连接）：默认 limit=20 分页 + nodeCount 预告（超大会话首刷防超预算）。
    // 取 orderKey 最大的 20 条（最新窗口）；hasMore + total 供设备按需再拉更早页。
    const DEFAULT_PAGE = 20
    // P1-② 游标分页：before（orderKey 排他下界）+ limit（1..100，缺省 20）→ nextCursor 续拉。
    const params = asRecord(requestParams)
    const before = typeof params?.before === 'number' ? params.before : undefined
    const cursorLimit =
      typeof params?.limit === 'number' && Number.isInteger(params.limit) && params.limit >= 1 && params.limit <= 100
        ? params.limit
        : DEFAULT_PAGE
    if (before !== undefined) {
      projectedNodes = projectedNodes.filter((n) => n.orderKey < before)
    }
    const total = projectedNodes.length
    let page = projectedNodes
    if (total > cursorLimit) {
      page = projectedNodes
        .slice()
        .sort((a, b) => a.orderKey - b.orderKey)
        .slice(total - cursorLimit)
    }
    // T30（§3.7 有界负载）：lite 连接按 maxFrameBytes 自动收缩 limit——chat.open 首页
    // 与 timeline.get 在 lite 上天然 ≤maxFrameBytes。从最新端（orderKey 大者）逐节点
    // 按 lean 实际序列化字节数装箱（JSON.stringify 精确口径，非估算），超预算即止；
    // 至少保留 1 节点（进度可见），hasMore/nextCursor 续拉补齐。请求 limit 仍有效（作为上界约束前的页大小）。
    const BUDGET_FIXED_OVERHEAD = 512 // 信封/固定字段（nodeCount/state 快照等）保守预算
    const byteBudget = Math.max(1024, profile.maxFrameBytes) - BUDGET_FIXED_OVERHEAD
    const sortedAsc = [...page].sort((a, b) => a.orderKey - b.orderKey)
    let used = 0
    let fitFromNewest = 0
    for (let i = sortedAsc.length - 1; i >= 0; i--) {
      const nodeBytes = Buffer.byteLength(JSON.stringify(sortedAsc[i]), 'utf8')
      if (used + nodeBytes > byteBudget) break
      used += nodeBytes
      fitFromNewest++
    }
    const effectiveFit = Math.max(1, fitFromNewest)
    if (effectiveFit < sortedAsc.length) {
      page = sortedAsc.slice(sortedAsc.length - effectiveFit)
    }
    // P1-②：hasMore 时附 nextCursor（本页最小 orderKey），客户端以它作为下页 before。
    const oldest = [...page].sort((a, b) => a.orderKey - b.orderKey)[0]
    const nextCursor =
      page.length < total && oldest ? { nextCursor: oldest.orderKey } : {}
    // state 快照 lean 投影（B-11）：activeTurns 不带累计文本、questionBatches/roles 不带题干/全量字段。
    const state = asRecord(data.state)
    return {
      ...rec,
      data: {
        ...data,
        rootTimeline: {
          ...timeline,
          nodes: page,
          // T30：hasMore 判定用实际下发页 vs total（含字节收缩场景：total ≤ limit 但超 maxFrameBytes）。
          ...(total > page.length ? { nodeCount: total, hasMore: true } : { nodeCount: total }),
          ...nextCursor,
          edges: [], // D7：edges 不投影
          // activeRuns/pendingInputs/generations 等保留（低频快照，有界负载归 T16）
        },
        ...(state ? { state: projectStateSnapshot(state) } : {}),
      },
    }
  }
  return response
}

/** chat.open state 快照的 lean 字段集（mcu-lite-api.md §3.6 表，B-11）。 */
function projectStateSnapshot(state: UnknownRecord): UnknownRecord {
  const projected: UnknownRecord = { ...state }
  // activeTurns：{chatId, turnId, messageId, createdAt}——不带累计文本（thinking/content 等 CRT 字段剔除）。
  if (Array.isArray(projected.activeTurns)) {
    projected.activeTurns = (projected.activeTurns as unknown[])
      .map((t) => asRecord(t))
      .filter((t): t is UnknownRecord => !!t)
      .map((t) => pick(t, ['chatId', 'turnId', 'messageId', 'createdAt']))
  }
  // questionBatches：{batchId, interactionId}——不带题干（详情走 interaction.list 收件箱）。
  if (Array.isArray(projected.questionBatches)) {
    projected.questionBatches = (projected.questionBatches as unknown[])
      .map((q) => asRecord(q))
      .filter((q): q is UnknownRecord => !!q)
      .map((q) => pick(q, ['batchId', 'interactionId']))
  }
  // runningTools：工具名级（G3）。
  if (Array.isArray(projected.runningTools)) {
    projected.runningTools = (projected.runningTools as unknown[])
      .map((t) => asRecord(t))
      .filter((t): t is UnknownRecord => !!t)
      .map((t) => pick(t, ['id', 'senseName']))
  }
  // roles：{taskId, chatId, parentChatId, type, state}（去 prompt 等长字段）。
  if (Array.isArray(projected.roles)) {
    projected.roles = (projected.roles as unknown[])
      .map((t) => asRecord(t))
      .filter((t): t is UnknownRecord => !!t)
      .map((t) => pick(t, ['taskId', 'chatId', 'parentChatId', 'type', 'state']))
  }
  // pendingInputs：content 保留（冷启动恢复路径，计入响应帧预算——恢复用户输入属必要数据）。
  return projected
}
