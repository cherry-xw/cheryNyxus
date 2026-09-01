import {
  adapterKeyForProtocol,
  isLlmProtocol,
  legacyProtocolForProvider,
  type LlmProtocol,
} from '@chery/protocol'

export interface BrainRoutingInput {
  provider: string
  protocol?: string
}

/** 取得有效线协议；旧配置由 provider 推断。 */
export function resolveBrainProtocol(brain: BrainRoutingInput): LlmProtocol | undefined {
  if (isLlmProtocol(brain.protocol)) return brain.protocol
  return legacyProtocolForProvider(brain.provider)
}

/**
 * 显式 protocol 走协议 adapter；旧配置继续按 provider adapter 路由。
 * 这是迁移边界：旧 deepseek/bigmodel 的细分行为不会因升级立即改变。
 */
export function resolveBrainAdapterKey(brain: BrainRoutingInput): string {
  return isLlmProtocol(brain.protocol)
    ? adapterKeyForProtocol(brain.protocol)
    : brain.provider
}

