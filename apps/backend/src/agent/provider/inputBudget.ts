import { createHash } from 'node:crypto'

export interface ModelInputBudget {
  projectionId: string
  payloadBytes: number
  estimatedTextTokens: number
  mediaTokens: null
  measurementSource: 'local-text-estimate'
}

/** A request-size guard and an explicitly approximate text estimate are different units. */
export function measureModelInput(body: unknown): ModelInputBudget {
  const serialized = JSON.stringify(body) ?? ''
  const text = JSON.stringify(body, (key, value) => {
    if (['file_data', 'encrypted_content'].includes(key) ||
      (key === 'data' && typeof value === 'string') ||
      (typeof value === 'string' && value.startsWith('data:'))) return '[binary omitted]'
    return value
  }) ?? ''
  // Count non-ASCII code points separately: UTF-8 bytes and UTF-16 length are not tokens.
  let ascii = 0, other = 0
  for (const char of text) {
    if (char.codePointAt(0)! <= 0x7f) ascii++
    else other++
  }
  return {
    projectionId: createHash('sha256').update(serialized).digest('hex'),
    payloadBytes: Buffer.byteLength(serialized, 'utf8'),
    estimatedTextTokens: Math.ceil(ascii / 4) + other,
    mediaTokens: null,
    measurementSource: 'local-text-estimate',
  }
}
