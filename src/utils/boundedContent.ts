import { createHash } from 'node:crypto'

/**
 * MCU lite profile 有界负载工具（docs/mcu-lite-api.md §3.7）。
 * 字节定义的截断 + 内容引用，供 node.get 分段、interaction.list payload 截断、
 * lite 事件投影共用。截断责任在服务端（先例：chat.list preview 40 字符、generations
 * summary 500 字符——db/chat.ts getChatPreviews、generations.ts）。
 */

/** UTF-8 字节数（Buffer 按需分配，避免对超大字符串整体转码两次）。 */
export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * 按 UTF-8 字节预算截断文本（不撕裂多字节字符）。
 * 返回 { text, truncated, contentLength(原文字节数), contentHash(原文 sha256 hex) }。
 * 截断不改变原文；引用字段供客户端经 chat.timeline.node.get 拉取全文。
 */
export function truncateByBytes(
  text: string,
  maxBytes: number,
): {
  text: string
  truncated: boolean
  contentLength: number
  contentHash: string
} {
  const contentLength = utf8ByteLength(text)
  const contentHash = createHash('sha256').update(text, 'utf8').digest('hex')
  if (contentLength <= maxBytes) {
    return { text, truncated: false, contentLength, contentHash }
  }
  // 逐字符累积直到超预算；丢弃最后一个可能撕裂多字节的累计。
  let acc = ''
  let accBytes = 0
  for (const ch of text) {
    const b = utf8ByteLength(ch)
    if (accBytes + b > maxBytes) break
    acc += ch
    accBytes += b
  }
  return { text: acc, truncated: true, contentLength, contentHash }
}

/** 内容引用：截断产物附带的按需拉取元数据（msgId 之外的通用形态）。 */
export interface ContentRef {
  field: string
  contentLength: number
  contentHash: string
}

/** 构造 ContentRef（字段级截断引用，T4-D3 方案）。 */
export function contentRef(field: string, original: string): ContentRef {
  return {
    field,
    contentLength: utf8ByteLength(original),
    contentHash: createHash('sha256').update(original, 'utf8').digest('hex'),
  }
}
