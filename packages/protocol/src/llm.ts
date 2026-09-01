/**
 * LLM 服务入口与线协议的公共标识。
 *
 * provider 表示请求发往哪个服务；protocol 表示 HTTP 请求/响应形状。
 * 模型事实、推荐和 wire 映射由内部 model catalog 提供，不构成公共运行配置维度。
 */

export const LlmProtocol = {
  OPENAI_CHAT_COMPLETIONS: 'openai-chat-completions',
  OPENAI_RESPONSES: 'openai-responses',
  ANTHROPIC_MESSAGES: 'anthropic-messages',
  OLLAMA_CHAT: 'ollama-chat',
  MOCK: 'mock',
} as const

export type LlmProtocol = (typeof LlmProtocol)[keyof typeof LlmProtocol]

export const LLM_PROTOCOLS = Object.values(LlmProtocol) as LlmProtocol[]

export const LlmProvider = {
  OPENAI: 'openai',
  ANTHROPIC: 'anthropic',
  MINIMAX: 'minimax',
  DEEPSEEK: 'deepseek',
  BIGMODEL: 'bigmodel',
  OLLAMA: 'ollama',
  NEWAPI: 'newapi',
  CUSTOM: 'custom',
  MOCK: 'mock',
} as const

export type LlmProvider = (typeof LlmProvider)[keyof typeof LlmProvider]

export interface LlmProtocolDefinition {
  id: LlmProtocol
  label: string
  endpoint: string
}

export const LLM_PROTOCOL_CATALOG: readonly LlmProtocolDefinition[] = [
  {
    id: LlmProtocol.OPENAI_CHAT_COMPLETIONS,
    label: 'OpenAI Chat Completions',
    endpoint: '/chat/completions',
  },
  {
    id: LlmProtocol.OPENAI_RESPONSES,
    label: 'OpenAI Responses',
    endpoint: '/responses',
  },
  {
    id: LlmProtocol.ANTHROPIC_MESSAGES,
    label: 'Anthropic Messages',
    endpoint: '/messages',
  },
  { id: LlmProtocol.OLLAMA_CHAT, label: 'Ollama Chat', endpoint: '/api/chat' },
  { id: LlmProtocol.MOCK, label: '离线 Mock', endpoint: '' },
]

export interface LlmProviderDefinition {
  id: LlmProvider
  label: string
  official: boolean
  defaultProtocol: LlmProtocol
  protocols: readonly LlmProtocol[]
  defaultUrl?: string
  /** 同一服务在不同线协议下使用不同 base URL 时的覆盖值。 */
  protocolUrls?: Partial<Record<LlmProtocol, string>>
  customUrl?: boolean
}

export const LLM_PROVIDER_CATALOG: readonly LlmProviderDefinition[] = [
  {
    id: LlmProvider.OPENAI,
    label: 'OpenAI 官方',
    official: true,
    defaultProtocol: LlmProtocol.OPENAI_RESPONSES,
    protocols: [LlmProtocol.OPENAI_RESPONSES, LlmProtocol.OPENAI_CHAT_COMPLETIONS],
    defaultUrl: 'https://api.openai.com/v1',
  },
  {
    id: LlmProvider.ANTHROPIC,
    label: 'Anthropic 官方',
    official: true,
    defaultProtocol: LlmProtocol.ANTHROPIC_MESSAGES,
    protocols: [LlmProtocol.ANTHROPIC_MESSAGES],
    defaultUrl: 'https://api.anthropic.com/v1',
  },
  {
    id: LlmProvider.MINIMAX,
    label: 'MiniMax 官方',
    official: true,
    defaultProtocol: LlmProtocol.OPENAI_RESPONSES,
    protocols: [
      LlmProtocol.OPENAI_RESPONSES,
      LlmProtocol.OPENAI_CHAT_COMPLETIONS,
      LlmProtocol.ANTHROPIC_MESSAGES,
    ],
    defaultUrl: 'https://api.minimaxi.com/v1',
  },
  {
    id: LlmProvider.DEEPSEEK,
    label: 'DeepSeek 官方',
    official: true,
    defaultProtocol: LlmProtocol.OPENAI_CHAT_COMPLETIONS,
    protocols: [
      LlmProtocol.OPENAI_CHAT_COMPLETIONS,
      LlmProtocol.OPENAI_RESPONSES,
      LlmProtocol.ANTHROPIC_MESSAGES,
    ],
    defaultUrl: 'https://api.deepseek.com',
    protocolUrls: {
      [LlmProtocol.ANTHROPIC_MESSAGES]: 'https://api.deepseek.com/anthropic',
    },
  },
  {
    id: LlmProvider.BIGMODEL,
    label: '智谱官方',
    official: true,
    defaultProtocol: LlmProtocol.OPENAI_CHAT_COMPLETIONS,
    protocols: [LlmProtocol.OPENAI_CHAT_COMPLETIONS],
    defaultUrl: 'https://open.bigmodel.cn/api/paas/v4',
  },
  {
    id: LlmProvider.OLLAMA,
    label: 'Ollama',
    official: false,
    defaultProtocol: LlmProtocol.OLLAMA_CHAT,
    protocols: [LlmProtocol.OLLAMA_CHAT],
    defaultUrl: 'http://localhost:11434',
  },
  {
    id: LlmProvider.NEWAPI,
    label: 'New API 中转',
    official: false,
    defaultProtocol: LlmProtocol.OPENAI_CHAT_COMPLETIONS,
    protocols: [
      LlmProtocol.OPENAI_CHAT_COMPLETIONS,
      LlmProtocol.OPENAI_RESPONSES,
      LlmProtocol.ANTHROPIC_MESSAGES,
    ],
    customUrl: true,
  },
  {
    id: LlmProvider.CUSTOM,
    label: '自定义服务',
    official: false,
    defaultProtocol: LlmProtocol.OPENAI_CHAT_COMPLETIONS,
    protocols: [
      LlmProtocol.OPENAI_CHAT_COMPLETIONS,
      LlmProtocol.OPENAI_RESPONSES,
      LlmProtocol.ANTHROPIC_MESSAGES,
      LlmProtocol.OLLAMA_CHAT,
    ],
    customUrl: true,
  },
  {
    id: LlmProvider.MOCK,
    label: '离线 Mock',
    official: false,
    defaultProtocol: LlmProtocol.MOCK,
    protocols: [LlmProtocol.MOCK],
  },
]

export function findLlmProviderDefinition(
  provider: string | undefined,
): LlmProviderDefinition | undefined {
  return LLM_PROVIDER_CATALOG.find((entry) => entry.id === provider)
}

/** 解析服务在指定协议下的默认 base URL；协议专用值优先。 */
export function resolveLlmProviderDefaultUrl(
  provider: string | undefined,
  protocol?: LlmProtocol,
): string | undefined {
  const definition = findLlmProviderDefinition(provider)
  if (!definition) return undefined
  return (protocol ? definition.protocolUrls?.[protocol] : undefined) ?? definition.defaultUrl
}

export function isLlmProtocol(value: unknown): value is LlmProtocol {
  return typeof value === 'string' && (LLM_PROTOCOLS as string[]).includes(value)
}

/** 旧 provider 同时充当 adapter 名时的协议推断。 */
export function legacyProtocolForProvider(provider: string): LlmProtocol | undefined {
  switch (provider) {
    case 'openai':
    case 'deepseek':
    case 'bigmodel':
      return LlmProtocol.OPENAI_CHAT_COMPLETIONS
    case 'anthropic':
      return LlmProtocol.ANTHROPIC_MESSAGES
    case 'ollama':
      return LlmProtocol.OLLAMA_CHAT
    case 'mock':
      return LlmProtocol.MOCK
    default:
      return undefined
  }
}

/** protocol 对应的运行时 adapter 注册键。 */
export function adapterKeyForProtocol(protocol: LlmProtocol): string {
  return protocol
}
