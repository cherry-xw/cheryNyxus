import { effectiveLlmBaseUrl, effectiveLlmProtocol, httpAddressError, llmRequiresKey, type LlmConnectionInput } from '@chery/protocol'

export function requiredEnvironmentValue(value: string | undefined, environment: Readonly<Record<string, string | undefined>>): string | undefined {
  if (value === undefined) return undefined
  const match = /^\$([A-Z_][A-Z0-9_]*)$/.exec(value)
  return match ? environment[match[1]!] : value
}
/** Pure validation against one caller-owned environment snapshot; never returns secrets in errors. */
export function resolveConfiguredLlmConnection(input: LlmConnectionInput, environment: Readonly<Record<string, string | undefined>>, prefix = 'connection', requireModel = true) {
  const errors: string[] = []
  const protocol = effectiveLlmProtocol(input)
  if (!protocol) errors.push(`${prefix}.protocol 请明确选择协议`)
  const resolved = { ...input, protocol,
    url: requiredEnvironmentValue(input.url, environment),
    key: requiredEnvironmentValue(input.key, environment),
    model: requiredEnvironmentValue(input.model, environment),
  }
  // A missing environment value is not the same as an omitted URL.
  const url = input.url === undefined ? effectiveLlmBaseUrl(resolved) : resolved.url
  if (protocol !== 'mock') {
    const addressError = httpAddressError(url)
    if (addressError) errors.push(`${prefix}.url ${addressError}`)
    if (llmRequiresKey(input) && (!resolved.key?.trim() || resolved.key.startsWith('$') || resolved.key === '[REDACTED]'))
      errors.push(`${prefix}.key 请填写密钥或配置引用的环境变量`)
  }
  if (requireModel && (!resolved.model?.trim() || resolved.model.startsWith('$') || /^<[^>]*>$/.test(resolved.model.trim())))
    errors.push(`${prefix}.model 请填写型号或配置引用的环境变量`)
  if (input.fullUrl && url && !httpAddressError(url)) {
    const endpointProtocol = Object.entries({ '/chat/completions': 'openai-chat-completions', '/responses': 'openai-responses', '/messages': 'anthropic-messages', '/api/chat': 'ollama-chat' }).find(([suffix]) => new URL(url).pathname.replace(/\/+$/, '').endsWith(suffix))?.[1]
    if (requireModel && endpointProtocol && endpointProtocol !== protocol) errors.push(`${prefix}.url 完整请求地址与所选协议不符`)
  }
  return { ...resolved, url, errors }
}
