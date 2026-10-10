import type { ThinkingBlock, ThinkingBlockDelta } from '@/core/message/adapter.js'

/**
 * Thinking block delta 组装器（Anthropic 扩展思考流式累积）。
 *
 * 与 SenseCallAssembler 的差异：
 * - text 拼接进最新 block 的 thinking 字符串（累积而非覆盖）；
 * - signature 绑定到触发它的 index（一条 thinking block 一条 signature，末段到达；
 *   Anthropic 协议规定 signature_delta 跟在最后一个 thinking_delta 之后、stop 之前）；
 * - stop 是 no-op（按 index 切换推断完成 — 与 sense 累积器同源语义）。
 *
 * 使用方：chat.ts handleStream（局部）+ checkpointState（每 chat 一份）。
 */
export class ThinkingBlockAssembler {
  private readonly map = new Map<number, ThinkingBlock>()
  /** 记录每个 block 是否已绑定 signature（Anthropic 必返；缺则视为协议违规） */
  private readonly sigSet = new Set<number>()

  /**
   * 累积 delta。
   * - start：播种占位（text 空、signature 空）
   * - text：拼接进 block.thinking
   * - signature：绑定到 block（一次一条，不覆盖）
   * - stop：no-op
   */
  push(delta: ThinkingBlockDelta): void {
    const index = delta.index
    if (delta.kind === 'start') {
      const placeholder: ThinkingBlock =
        delta.type === 'redacted_thinking'
          ? { type: 'redacted_thinking', data: '' }
          : { type: 'thinking', thinking: '', signature: '' }
      this.map.set(index, placeholder)
      return
    }
    if (delta.kind === 'text') {
      const block = this.map.get(index)
      if (block && block.type === 'thinking') {
        block.thinking += delta.text
      } else if (block && block.type === 'redacted_thinking') {
        // redacted_thinking 的 data 是 opaque payload，delta 走 text 通道累积
        block.data += delta.text
      }
      return
    }
    if (delta.kind === 'signature') {
      const block = this.map.get(index)
      if (block && block.type === 'thinking' && !this.sigSet.has(index)) {
        block.signature = delta.signature
        this.sigSet.add(index)
      }
      return
    }
    // stop: 边界由 index 切换推断，无需动作
  }

  /**
   * 返回当前所有累积块（按 index 升序），过滤未绑定 signature 的 thinking 块
   * （缺 signature 等同于协议违规，回传给 API 必 400 — 调用方按需判断）。
   * 不清空内部状态。
   */
  toArray(): ThinkingBlock[] {
    return Array.from(this.map.entries())
      .sort(([a], [b]) => a - b)
      .map(([, block]) => block)
  }

  /** 清空（跨轮次复用同一实例时调用） */
  reset(): void {
    this.map.clear()
    this.sigSet.clear()
  }
}
