/**
 * Provider URL 模式注册表
 *
 * URL 自动补全是注册 provider 必须提供的能力之一：每个 provider 注册时声明
 * chat / models 两种 kind 的端点模式，统一入口 resolveProviderUrl（定义在
 * agent/provider/fetchBase.ts）查表完成拼接。本文件只持类型 + Map（零 import），
 * 解析逻辑放 agent 层——core 不反向依赖 agent。
 *
 * 语义与各 provider 注册值见 docs/agent/provider.md「URL 解析与端点拼接」。
 */

/** URL 用途种类：chat 会话请求 / models 模型列表拉取 */
export type ProviderUrlKind = 'chat' | 'models'

/**
 * Provider 的 URL 端点模式。
 * chatEndpoint / modelsEndpoint 三态：
 * - undefined → host 模式，不拼接（未注册或该 kind 不支持，URL 原样去尾斜杠）
 * - '' → 不拼端点，base 原样（端点由 openai SDK 自拼；版本段由用户填写）
 * - '/xxx' → 拼端点（如 /messages、/chat/completions）
 */
export interface ProviderUrlPattern {
  chatEndpoint?: string
  modelsEndpoint?: string
}

/**
 * Provider URL 模式注册表
 */
const providerUrlPatternRegistry = new Map<string, ProviderUrlPattern>()

/**
 * 注册 Provider URL 模式（provider 实现时与 registerLLMAdapter 并列调用）
 */
export function registerProviderUrlPattern(name: string, pattern: ProviderUrlPattern): void {
  providerUrlPatternRegistry.set(name, pattern)
}

/**
 * 获取 Provider URL 模式；未注册返回 undefined（host 模式）
 */
export function getProviderUrlPattern(name: string): ProviderUrlPattern | undefined {
  return providerUrlPatternRegistry.get(name)
}
