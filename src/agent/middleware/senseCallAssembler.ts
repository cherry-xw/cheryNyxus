import type { SenseCallData } from '@/core/sense/adapter.js'

/**
 * Sense call delta 组装器。
 *
 * 统一两处 provider tool-call delta 合并语义：
 * - tool.ts senseMiddleware：流式累积，index 切换时触发已完成项的 sense_end。
 * - checkpointState.ts mergeSenseDeltas：批量合并所有 delta 构建 assistant.senseCalls 落库。
 *
 * 此前两套独立 Map 状态机（senseDeltaMap vs mergedMap）在 id/name 覆盖、index 切换处理上
 * 存在分叉风险——新 provider delta 格式稍有差异即可能导致前端 sense_end 与落库 senseCalls 不一致。
 * Assembler 收敛为单一累积逻辑：按 index 累积 arguments，id/name 取首个非空不覆盖。
 */
export class SenseCallAssembler {
  private readonly map = new Map<number, SenseCallData>()
  private lastIndex = -1

  /**
   * 检测 index 切换并返回被切换出的已完成项。
   * 流式场景（tool.ts）：下一个 delta 的 index 与上一个不同时，上一项 arguments 已完整，
   * 移除并返回（有 name 才视为有效 sense call）。无切换或首项返回 null。
   */
  flushCompletedOnIndexChange(delta: SenseCallData): SenseCallData | null {
    const index = delta.index ?? 0
    if (this.lastIndex === -1 || index === this.lastIndex) return null
    const prev = this.map.get(this.lastIndex)
    this.map.delete(this.lastIndex)
    return prev && prev.name ? prev : null
  }

  /**
   * 累积 delta 到对应 index。
   * id/name 取首个非空（OpenAI 首个 delta 带 id/name，后续仅 arguments 片段），arguments 拼接。
   */
  push(delta: SenseCallData): void {
    const index = delta.index ?? 0
    const existing = this.map.get(index)
    if (existing) {
      existing.arguments += delta.arguments
      if (delta.id && !existing.id) existing.id = delta.id
      if (delta.name && !existing.name) existing.name = delta.name
    } else {
      this.map.set(index, {
        index,
        id: delta.id,
        name: delta.name,
        arguments: delta.arguments,
      })
    }
    this.lastIndex = index
  }

  /**
   * 返回当前所有累积项（按 index 升序）。
   * 流式场景用于 flush 剩余；批量场景用于一次性合并查询。不清空内部状态。
   */
  toArray(): SenseCallData[] {
    return Array.from(this.map.entries())
      .sort(([a], [b]) => a - b)
      .map(([, sc]) => sc)
  }
}
