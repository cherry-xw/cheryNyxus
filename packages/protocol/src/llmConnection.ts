import { legacyProtocolForProvider, resolveLlmProviderDefaultUrl, type LlmProtocol } from './llm.js'

export interface LlmConnectionInput {
  provider: string
  protocol?: LlmProtocol
  url?: string
  fullUrl?: boolean
  key?: string
  model?: string
}
export function effectiveLlmProtocol(input: Pick<LlmConnectionInput, 'provider' | 'protocol'>): LlmProtocol | undefined {
  return input.protocol ?? legacyProtocolForProvider(input.provider)
}
export function llmRequiresKey(input: Pick<LlmConnectionInput, 'provider' | 'protocol'>): boolean {
  const protocol = effectiveLlmProtocol(input)
  return protocol !== 'mock' && protocol !== 'ollama-chat'
}
/** Explicit empty addresses are invalid; only absence can select the service default. */
export function effectiveLlmBaseUrl(input: LlmConnectionInput): string | undefined {
  return input.url ?? (input.fullUrl ? undefined : resolveLlmProviderDefaultUrl(input.provider, effectiveLlmProtocol(input)))
}
export function httpAddressError(value: string | undefined): string | undefined {
  if (!value?.trim()) return '请填写地址；当前分支没有可用默认地址'
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return '请填写有效的 HTTP(S) 地址'
  } catch { return '请填写有效的 HTTP(S) 地址' }
  return undefined
}
