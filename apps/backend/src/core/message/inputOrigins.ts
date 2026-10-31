import type { LLMAttachment, LLMResponse } from './adapter.js'

export interface InputOrigin {
  messageId: string
  partId?: string
  range?: { unit: 'utf16'; start: number; end: number }
  attachment?: LLMAttachment
}

// These associations stay in memory; no extra fields enter a vendor request.
const origins = new WeakMap<object, InputOrigin[]>()
export function trackInput<T extends object>(value: T, message: LLMResponse, partId?: string, attachment?: LLMAttachment): T {
  origins.set(value, [{ messageId: message.id, ...(partId ? { partId } : {}), ...(attachment ? { attachment } : {}) }])
  return value
}
export function trackTextInput<T extends object>(value: T, message: LLMResponse): T {
  const entries: InputOrigin[] = []
  let offset = 0
  const texts = message.parts?.flatMap(part => part.type === 'text' && part.text ? [part] : [])
  const separator = texts?.map(part => part.text).join('') === message.content ? '' : '\n'
  if (texts?.length && texts.map(part => part.text).join(separator) === message.content) {
    for (const part of texts) {
      entries.push({ messageId: message.id, partId: part.partId, range: { unit: 'utf16', start: offset, end: offset + part.text.length } })
      offset += part.text.length + separator.length
    }
  }
  origins.set(value, entries.length ? entries : [{ messageId: message.id }])
  return value
}
export function inputOrigins(value: unknown): readonly InputOrigin[] {
  return value && typeof value === 'object' ? origins.get(value) ?? [] : []
}
