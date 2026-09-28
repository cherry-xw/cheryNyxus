import { isTimedNodeKind, type LiteRunNode } from './executionMonitor'

/** 执行块宽下限（px）：保证可点击命中（10s 节点 ≥ 10px，即 1px/秒 的下限）。 */
const MIN_BAR_PX = 10
/** 正常档执行块宽上限（px）：空间足够时 1s=1px，超过 180s 封顶 180px。 */
const MAX_BAR_PX = 180
/** 压缩档执行块宽上限（px）：一行放不下时整体挤压，块宽 clamp 到 [MIN_BAR_PX, 30]。 */
const COMPRESSED_MAX_BAR_PX = 30
/** 执行节点线性比例（px/秒）：1 秒 = 1 像素。 */
const MODEL_PX_PER_SEC = 1
/** 相邻节点等待间隔上限（px）：真实空闲 > 此值按此封顶，剔除大段等待（等审批/隔几天）。 */
const MAX_GAP_PX = 24
/** 事件节点固定宽度（px）：结果返回 / 委派 / 协作 / 系统。 */
const EVENT_FIXED_PX = 12
/** 用户提问固定宽度（px）：比普通事件稍宽，突出每轮发起。 */
const USER_FIXED_PX = 16
/** 行头角色名 gutter 宽度（px）：块从此偏移开始排布，避开行头角色名标签；与 CSS .lite-trajectory-lane-label 宽度保持一致。 */
const LABEL_GUTTER_PX = 76
export interface TrajectoryBar {
  node: LiteRunNode
  left: number
  width: number
}
export interface TrajectoryTrack {
  chatId: string
  label: string
  isRootLane: boolean
  firstStartedAt: number
  bars: TrajectoryBar[]
}
export interface TrajectoryLayout {
  tracks: TrajectoryTrack[]
  trackWidth: number
}
/** 执行节点宽 = 真实执行耗时线性映射并 clamp（maxPx 为当前档上限）；事件节点固定宽度。 */
function barWidthFor(node: LiteRunNode, zoom: number, maxPx = MAX_BAR_PX): number {
  if (isTimedNodeKind(node.kind)) {
    const seconds = Math.max(0, node.elapsedMs) / 1000
    const base = seconds * MODEL_PX_PER_SEC
    return Math.max(MIN_BAR_PX, Math.min(maxPx, base * zoom))
  }
  const fixed = node.kind === 'user' ? USER_FIXED_PX : EVENT_FIXED_PX
  // 事件节点固定宽 × zoom 同样 clamp 下限 10（缩放 0.4x 时不窄于 10px，保证可点击命中）。
  return Math.max(MIN_BAR_PX, fixed * zoom)
}
/** 相邻节点时间间隔（px）：真实空闲 × 1px，封顶 MAX_GAP_PX，剔除大段等待。 */
function gapPxBetweenTimes(prevStartedAt: number, nextStartedAt: number, zoom: number): number {
  const gapMs = Math.max(0, nextStartedAt - prevStartedAt)
  return Math.min((gapMs / 1000) * MODEL_PX_PER_SEC, MAX_GAP_PX) * zoom
}
export function computeTrajectoryLayout(
  nodes: LiteRunNode[],
  width: number,
  zoom: number,
  rootChatId: string,
): TrajectoryLayout {
  // 需求 5：用户消息并入主 Agent 链路（用户消息发给主 Agent）；其余按归属 Agent（sourceChatId）分链路。
  const laneIdOf = (node: LiteRunNode): string =>
    node.kind === 'user' ? rootChatId : node.sourceChatId

  // 需求 3/6：全局共享压缩时间轴——所有节点按 startedAt 绝对定位，而非每条链路从头画起。
  // 逐个全局事件累加压缩间隔，得到每个节点在时间轴上的 X 坐标（大段等待被封顶剔除）。
  const sorted = [...nodes].sort(
    (a, b) => a.startedAt - b.startedAt || a.key.localeCompare(b.key),
  )
  const xByKey = new Map<string, number>()
  let cursor = LABEL_GUTTER_PX
  let prevStartedAt: number | null = null
  for (const node of sorted) {
    if (prevStartedAt !== null) cursor += gapPxBetweenTimes(prevStartedAt, node.startedAt, zoom)
    xByKey.set(node.key, cursor)
    prevStartedAt = node.startedAt
  }

  const byLane = new Map<string, LiteRunNode[]>()
  for (const node of nodes) {
    const laneId = laneIdOf(node)
    const list = byLane.get(laneId)
    if (list) list.push(node)
    else byLane.set(laneId, [node])
  }

  // 按给定上限档位排布各链路块，并返回整条时间轴的右边界（决定是否溢出）。
  const buildTracks = (
    maxPx: number,
  ): { tracks: TrajectoryTrack[]; contentWidth: number; compactWidth: number } => {
    const tracks: TrajectoryTrack[] = []
    let contentWidth = 0
    let compactWidth = 0
    for (const [laneId, list] of byLane) {
      const laneSorted = [...list].sort(
        (a, b) => a.startedAt - b.startedAt || a.key.localeCompare(b.key),
      )
      // v0.5.2：序列化推进——left 取「时间 gap 位置」与「前一块右缘 + 1px」的较大者，
      // 线性流程同一轨道内块间最低 1px 间隔、绝不互相遮挡（gap 增量上限 24px 远小于
      // 块宽上限 180px，纯时间定位下长耗时块必然压住后续块）；时间 gap 在块不挤时仍占位。
      const bars: TrajectoryBar[] = []
      let laneRight = LABEL_GUTTER_PX - 1
      for (const node of laneSorted) {
        const timeX = xByKey.get(node.key) ?? LABEL_GUTTER_PX
        const width = barWidthFor(node, zoom, maxPx)
        const left = Math.max(timeX, laneRight + 1)
        bars.push({ node, left, width })
        laneRight = left + width
      }
      const label = laneSorted[0]?.agentLabel || (laneId === rootChatId ? '主 Agent' : '子 Agent')
      const firstStartedAt = laneSorted[0]?.startedAt ?? 0
      // 实际内容宽（含时间 gap 占位）：决定容器宽（超视口配横向滚动条），不参与挤压判定。
      const laneWidth = bars.reduce((max, bar) => Math.max(max, bar.left + bar.width), 0)
      contentWidth = Math.max(contentWidth, laneWidth)
      // 紧凑口径宽（块固有宽之和 + 1px 间隙，排除时间 gap 占位）：决定是否切换挤压档——
      // 挤压只由「块排不排得下」触发（挤压后执行节点封顶 30px），时间空隙不撑爆宽度、
      // 不误伤空间足够的 180px 正常档。
      const laneCompact =
        LABEL_GUTTER_PX +
        bars.reduce((sum, bar) => sum + bar.width, 0) +
        Math.max(0, bars.length - 1)
      compactWidth = Math.max(compactWidth, laneCompact)
      tracks.push({
        chatId: laneId,
        label,
        isRootLane: laneId === rootChatId,
        firstStartedAt,
        bars,
      })
    }
    // 需求 2：上下链路之间按发起时间线性排序（最早发起自然靠上）。
    tracks.sort((a, b) => a.firstStartedAt - b.firstStartedAt || a.chatId.localeCompare(b.chatId))
    return { tracks, contentWidth, compactWidth }
  }

  // 需求（本次）：空间足够 → 1s=1px（封顶 180px）；一行放不下 → 整体挤压到 [10, 30]。
  // 先用正常档排布，若紧凑口径内容宽度超出视口（width），改用压缩档重排。
  let { tracks, contentWidth, compactWidth } = buildTracks(MAX_BAR_PX)
  if (compactWidth > width) {
    ;({ tracks, contentWidth, compactWidth } = buildTracks(COMPRESSED_MAX_BAR_PX))
  }
  return { tracks, trackWidth: Math.max(width, contentWidth) }
}
