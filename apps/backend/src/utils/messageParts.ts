import { randomUUID } from 'node:crypto'
import {
  MessagePartSchema,
  FileOperationRecordSchema,
  deriveTextContentFromParts,
  type MessagePart,
  type FileOperationRecord,
} from '@chery/protocol'

/** 所有持久化入口使用同一投影规则；显式 parts 优先于调用方传来的文字。 */
export function normalizeMessageParts(content?: string, parts?: readonly MessagePart[]) {
  const normalized = parts === undefined
    ? content === undefined ? [] : [{ partId: randomUUID(), type: 'text' as const, text: content }]
    : parts.map((part) => MessagePartSchema.parse(part))
  const ids = new Set(normalized.map((part) => part.partId))
  if (ids.size !== normalized.length) throw new Error('消息部分的 partId 不能重复')
  return { parts: normalized, content: deriveTextContentFromParts(normalized) }
}

export function parseStoredParts(value: string | null | undefined): MessagePart[] | undefined {
  if (value == null) return undefined
  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed)) throw new Error('消息 parts 必须为数组')
  return normalizeMessageParts(undefined, parsed as MessagePart[]).parts
}

export function normalizeFileOperations(operations: readonly FileOperationRecord[]) {
  return operations.map((operation) => FileOperationRecordSchema.parse(operation))
}

export function parseStoredFileOperations(value: string | null | undefined) {
  if (value == null) return undefined
  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed)) throw new Error('文件处理记录必须为数组')
  return normalizeFileOperations(parsed as FileOperationRecord[])
}
