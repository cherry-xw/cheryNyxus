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
    defaultProtocol: LlmProtocol.OPENAI_CHAT_COMPLETIONS,
    protocols: [
      LlmProtocol.OPENAI_CHAT_COMPLETIONS,
      LlmProtocol.OPENAI_RESPONSES,
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

// ── 模型原生能力与文件服务适配器公共契约（C01—C06 / D01—D03） ──

export const CapabilityState = {
  SUPPORTED: 'supported',
  UNSUPPORTED: 'unsupported',
  UNKNOWN: 'unknown',
} as const
export type CapabilityState = (typeof CapabilityState)[keyof typeof CapabilityState]
export const CAPABILITY_STATES = Object.values(CapabilityState) as CapabilityState[]

export type ServerToolCapability = 'webSearch' | 'webReader' | 'imageInspect'
export type CapabilitySource = 'user' | 'catalog' | 'adapter' | 'default'
export interface CapabilityField {
  state: CapabilityState
  source: CapabilitySource
}

/** 目录说明不是当前连接的执行证据，不包含推测的参数结构。 */
export interface ServerToolDefinition {
  name: string
  description?: string
  documentationUrl?: string
}

export interface ServerToolObservation {
  name: string
  status: 'started' | 'completed' | 'failed' | 'unknown'
  observedAt: number
}

/** 只读能力说明；观察到调用不会自动变成完整任务验证通过。 */
export interface BrainServiceCapabilities {
  nativeInput: Record<'image' | 'video' | 'audio' | 'pdf', CapabilityField>
  serverTools: Record<ServerToolCapability, CapabilityField>
  connectionIdentified: boolean
  verification: { status: 'not-verified' }
  catalogComplete: false
  observationsTruncated: boolean
  knownTools: Array<ServerToolDefinition & {
    sources: Array<'catalog' | 'observed'>
    observation?: ServerToolObservation
  }>
  /** 读取失败与没有观察记录不同。 */
  observationError?: string
}

export const FileCapabilityOperation = {
  IMAGE_INSPECT: 'image.inspect',
  IMAGE_GENERATE: 'image.generate',
  IMAGE_REFERENCE: 'image.reference',
  IMAGE_EDIT: 'image.edit',
  DOCUMENT_EXTRACT: 'document.extract',
  AUDIO_TRANSCRIBE: 'audio.transcribe',
  VIDEO_INSPECT: 'video.inspect',
} as const
export type FileCapabilityOperation =
  (typeof FileCapabilityOperation)[keyof typeof FileCapabilityOperation]
export const FILE_CAPABILITY_OPERATIONS = Object.values(
  FileCapabilityOperation,
) as FileCapabilityOperation[]

export const FileServiceAdapterId = {
  VISION_BRAIN: 'vision-brain',
  MINIMAX_IMAGES: 'minimax-images',
  OPENAI_IMAGES: 'openai-images',
  OPENAI_RESPONSES_IMAGE: 'openai-responses-image',
  GOOGLE_GEMINI_IMAGE: 'google-gemini-image',
  GOOGLE_IMAGEN: 'google-imagen',
  DOUBAO_SEEDREAM: 'doubao-seedream',
  CUSTOM_SENSE_MCP: 'custom-sense-mcp',
} as const
export type FileServiceAdapterId = (typeof FileServiceAdapterId)[keyof typeof FileServiceAdapterId]
export const FILE_SERVICE_ADAPTER_IDS = Object.values(
  FileServiceAdapterId,
) as FileServiceAdapterId[]

export interface FileServiceAdapterDefinition {
  id: FileServiceAdapterId
  label: string
  vendor?: string
  supportedOperations: readonly FileCapabilityOperation[]
  representativeModels?: readonly string[]
}

export const FILE_SERVICE_ADAPTER_CATALOG: readonly FileServiceAdapterDefinition[] = [
  {
    id: FileServiceAdapterId.VISION_BRAIN,
    label: '视觉对话模型（复用已有大脑）',
    supportedOperations: [FileCapabilityOperation.IMAGE_INSPECT],
  },
  {
    id: FileServiceAdapterId.MINIMAX_IMAGES,
    label: 'MiniMax 图像生成 API',
    vendor: 'minimax',
    supportedOperations: [
      FileCapabilityOperation.IMAGE_GENERATE,
      FileCapabilityOperation.IMAGE_REFERENCE,
    ],
    representativeModels: ['image-01', 'image-01-live'],
  },
  {
    id: FileServiceAdapterId.OPENAI_IMAGES,
    label: 'OpenAI Images 兼容 API',
    vendor: 'openai',
    supportedOperations: [
      FileCapabilityOperation.IMAGE_GENERATE,
      FileCapabilityOperation.IMAGE_REFERENCE,
      FileCapabilityOperation.IMAGE_EDIT,
    ],
    representativeModels: [
      'gpt-image-1',
      'gpt-image-1-mini',
      'gpt-image-1.5',
      'gpt-image-2',
      'gpt-image-2.5-sunburst',
      'gpt-image-2.5-flare',
    ],
  },
  {
    id: FileServiceAdapterId.OPENAI_RESPONSES_IMAGE,
    label: 'OpenAI Responses 图片生成工具',
    vendor: 'openai',
    supportedOperations: [
      FileCapabilityOperation.IMAGE_GENERATE,
      FileCapabilityOperation.IMAGE_REFERENCE,
      FileCapabilityOperation.IMAGE_EDIT,
    ],
    representativeModels: ['gpt-5.5'],
  },
  {
    id: FileServiceAdapterId.GOOGLE_GEMINI_IMAGE,
    label: 'Google Gemini 原生图像输出',
    vendor: 'google',
    supportedOperations: [
      FileCapabilityOperation.IMAGE_GENERATE,
      FileCapabilityOperation.IMAGE_REFERENCE,
      FileCapabilityOperation.IMAGE_EDIT,
    ],
    representativeModels: [
      'gemini-2.5-flash-image',
      'gemini-3-pro-image',
      'gemini-3.1-flash-image',
      'gemini-3.1-flash-lite-image',
    ],
  },
  {
    id: FileServiceAdapterId.GOOGLE_IMAGEN,
    label: 'Google Vertex AI Imagen（完整端点）',
    vendor: 'google',
    supportedOperations: [FileCapabilityOperation.IMAGE_GENERATE],
    representativeModels: [
      'imagen-4.0-generate-001',
      'imagen-4.0-fast-generate-001',
      'imagen-4.0-ultra-generate-001',
    ],
  },
  {
    id: FileServiceAdapterId.DOUBAO_SEEDREAM,
    label: '豆包 Seedream（火山方舟）',
    vendor: 'volcengine',
    supportedOperations: [
      FileCapabilityOperation.IMAGE_GENERATE,
      FileCapabilityOperation.IMAGE_REFERENCE,
      FileCapabilityOperation.IMAGE_EDIT,
    ],
    representativeModels: ['doubao-seedream-5-0-pro-260628', 'doubao-seedream-5-0-flash-260915'],
  },
  {
    id: FileServiceAdapterId.CUSTOM_SENSE_MCP,
    label: '自定义工具 / MCP 结构化映射',
    supportedOperations: [
      FileCapabilityOperation.IMAGE_INSPECT,
      FileCapabilityOperation.IMAGE_GENERATE,
      FileCapabilityOperation.IMAGE_REFERENCE,
      FileCapabilityOperation.IMAGE_EDIT,
      FileCapabilityOperation.DOCUMENT_EXTRACT,
      FileCapabilityOperation.AUDIO_TRANSCRIBE,
      FileCapabilityOperation.VIDEO_INSPECT,
    ],
  },
]

export function isCapabilityState(value: unknown): value is CapabilityState {
  return typeof value === 'string' && (CAPABILITY_STATES as string[]).includes(value)
}

export function isFileCapabilityOperation(value: unknown): value is FileCapabilityOperation {
  return typeof value === 'string' && (FILE_CAPABILITY_OPERATIONS as string[]).includes(value)
}

export function isFileServiceAdapterId(value: unknown): value is FileServiceAdapterId {
  return typeof value === 'string' && (FILE_SERVICE_ADAPTER_IDS as string[]).includes(value)
}

export function findFileServiceAdapterDefinition(
  adapter: string | undefined,
): FileServiceAdapterDefinition | undefined {
  return FILE_SERVICE_ADAPTER_CATALOG.find((entry) => entry.id === adapter)
}

/**
 * 生成文件服务操作对应的稳定工具标识（仅含字母、数字、下划线，避免点号在 LLM 工具协议中不合法）。
 */
export function buildFileServiceToolName(
  serviceId: string,
  operation: FileCapabilityOperation,
): string {
  const safeService = serviceId.replace(/[^a-zA-Z0-9_]/g, '_')
  const safeOp = operation.replace(/\./g, '_')
  return `file_${safeService}_${safeOp}`
}
