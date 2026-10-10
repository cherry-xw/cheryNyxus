import type { ExecutionGraph } from '../graph/executionGraph'
import { mainExecutionEndpoint } from '../graph/executionGraph'

/**
 * 节点树钢琴彩蛋触发状态机。
 *
 * 序列：start →（3 个不同特征节点，按 `PIANO_EASTER_EGG_KINDS` 特定顺序）→ 主流程最后一个节点。
 * - 每次成功推进刷新时间戳；整段须在 `PIANO_EASTER_EGG_WINDOW_MS` 内完成，超时/错步立即复位。
 * - 特征节点要求「未点过的新节点」（seenIds），防重复点同一节点刷序列。
 * - 尾节点比较取**渲染图**的 `mainExecutionEndpoint`（折叠投影下视觉尾节点仍可点）。
 * - `consume` 返回 true 表示彩蛋触发成功（调用方 emit('easter-egg') 并吞掉本次点击）。
 */

/** 彩蛋触发序列中段：3 个不同特征节点（按此特定顺序点击）。 */
export const PIANO_EASTER_EGG_KINDS = ['tool-batch', 'dispatch', 'fold'] as const

/** 整段触发流程的时间窗（毫秒）：开始 → 特征节点 → 尾节点必须在窗口内完成。 */
export const PIANO_EASTER_EGG_WINDOW_MS = 8000

type PianoEasterEggNode = { id: string; kind: string }

export function usePianoEasterEgg(options: {
  /** 渲染图（fold 投影后的 graph），尾节点判定用。 */
  graph: () => ExecutionGraph
  /** 是否启用（GenerationTreeDialog 等 staticView 二层不启用）。 */
  enabled: () => boolean
}): {
  consume: (node: PianoEasterEggNode) => boolean
  reset: () => void
} {
  let stepIndex = -1
  let lastAdvanceAt = 0
  const seenIds = new Set<string>()

  function reset(): void {
    stepIndex = -1
    lastAdvanceAt = 0
    seenIds.clear()
  }

  function advance(node: PianoEasterEggNode, now: number): void {
    seenIds.add(node.id)
    stepIndex += 1
    lastAdvanceAt = now
  }

  function consume(node: PianoEasterEggNode): boolean {
    if (!options.enabled()) return false
    const now = performance.now()
    // 超时复位：非首步必须在上次推进的窗口内完成整段。
    if (stepIndex >= 0 && now - lastAdvanceAt > PIANO_EASTER_EGG_WINDOW_MS) reset()
    // 首步：开始节点。
    if (stepIndex === -1) {
      if (node.kind === 'start') advance(node, now)
      return false
    }
    // 中段：依次命中 3 个不同特征节点（错步/重复即复位）。
    if (stepIndex < PIANO_EASTER_EGG_KINDS.length) {
      const expected = PIANO_EASTER_EGG_KINDS[stepIndex]!
      if (node.kind === expected && !seenIds.has(node.id)) advance(node, now)
      else reset()
      return false
    }
    // 尾步：主流程最后一个节点 → 触发。
    if (stepIndex === PIANO_EASTER_EGG_KINDS.length) {
      reset()
      return node.id === mainExecutionEndpoint(options.graph()).id
    }
    return false
  }

  return { consume, reset }
}
