/**
 * Hooks 模块类型定义：事件枚举 + 各事件的 payload/decision 类型。
 *
 * 仿 Claude Code hooks 的事件驱动扩展点。事件载荷喂给 handler（stdin JSON），
 * handler 返回的决策（stdout JSON）由 dispatcher 解析并应用到运行时。
 *
 * 详见 [docs/agent/hooks.md](../../../../docs/agent/hooks.md)。
 */

import type { ThinkingBlock } from '@/core/message/adapter.js'
import type { ThinkingLevel } from '@/core/llm/adapter.js'

/** 所有 hooks 事件名（dispatcher 入口穷举）*/
export type HookEvent =
  | 'SessionStart'
  | 'SessionEnd'
  | 'UserPromptSubmit'
  | 'PreLLMRequest'
  | 'PostLLMResponse'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'Stop'
  | 'PreCompact'
  | 'PostCompact'

/** 上下文：当前 brain 名 + 路径解析基础 */
export interface HookDispatchContext {
  /** brain name（如 'anthropic-main'）；用于 brain 级 hooks 合并 */
  brain: string
}

// ============ 各事件 payload 类型 ============

/** SessionStart：chat 第一轮前 */
export interface SessionStartPayload {
  chatId: string
  brain: string
  capabilities?: { input?: { image?: boolean; video?: boolean; audio?: boolean } }
}

/** SessionEnd：chat 终止 */
export interface SessionEndPayload {
  chatId: string
  reason: 'user_stop' | 'error' | 'close' | 'unknown'
}

/** UserPromptSubmit：用户消息到、LLM 调用前 */
export interface UserPromptSubmitPayload {
  chatId: string
  prompt: string
  role: 'user' | 'role' | 'subagent'
}

/** PreLLMRequest：provider 构造 body 后、fetch 前 */
export interface PreLLMRequestPayload {
  provider: string
  model: string
  url: string
  /** 思考档位：含 YAML 自定义值（如 DeepSeek 的 `max`），对齐 ThinkingLevel */
  thinking: ThinkingLevel | undefined
  stream: boolean
  /** provider 构造的完整请求体（Anthropic/OpenAI/... 不同） */
  body: Record<string, unknown>
}

/** PostLLMResponse：LLM 响应解析后 */
export interface PostLLMResponsePayload {
  provider: string
  model: string
  content: string
  thinking?: string
  /** Anthropic 扩展：完整 thinking blocks（含 signature）。其它 provider 不传。 */
  thinkingBlocks?: ThinkingBlock[]
  senseCalls?: { id: string; name: string; arguments: string }[]
}

/** PreToolUse：tool middleware doExecuteSense 前 */
export interface PreToolUsePayload {
  name: string
  args: Record<string, unknown>
  chatId: string
}

/** PostToolUse：感官执行成功后 */
export interface PostToolUsePayload {
  name: string
  args: Record<string, unknown>
  result: { content: string; hash?: string; replaced?: boolean }
  hash?: string
  chatId: string
}

/** Stop：LLM 返回 stop_reason=end_turn 后、yield 前 */
export interface StopPayload {
  chatId: string
  message: string
  stopReason: string
}

/** PreCompact：context compaction 前 */
export interface PreCompactPayload {
  chatId: string
  tokenCount: number
}

/** PostCompact：context compaction 后 */
export interface PostCompactPayload {
  chatId: string
  summary: string
  tokenCount: number
}

/** 事件 → payload 映射（dispatcher 强类型查表）*/
export interface HookPayloadMap {
  SessionStart: SessionStartPayload
  SessionEnd: SessionEndPayload
  UserPromptSubmit: UserPromptSubmitPayload
  PreLLMRequest: PreLLMRequestPayload
  PostLLMResponse: PostLLMResponsePayload
  PreToolUse: PreToolUsePayload
  PostToolUse: PostToolUsePayload
  Stop: StopPayload
  PreCompact: PreCompactPayload
  PostCompact: PostCompactPayload
}

// ============ 各事件 decision 类型 ============

/** PreLLMRequest decision：改 body / 阻断 */
export interface PreLLMRequestDecision {
  body?: Record<string, unknown>
  decision?: 'block' | 'allow'
  reason?: string
  metadata?: Record<string, unknown>
}

/** PreToolUse decision：allow/deny/ask + 修改 input */
export interface PreToolUseDecision {
  decision?: 'allow' | 'deny' | 'ask'
  updatedInput?: Record<string, unknown>
  reason?: string
}

/** Stop decision：阻断继续 */
export interface StopDecision {
  decision?: 'block'
  reason?: string
  additionalContext?: string
}

/** 通用 decision：block + reason + additionalContext（UserPromptSubmit/PostToolUse/PreCompact/PostCompact 等共用）*/
export interface CommonDecision {
  decision?: 'block'
  reason?: string
  additionalContext?: string
  /** PostLLMResponse 专用：改写响应字段 */
  content?: string
  thinking?: string
  /** Anthropic 扩展：handler 可改写 / 阻断重写 thinking blocks。 */
  thinkingBlocks?: ThinkingBlock[]
  senseCalls?: { id: string; name: string; arguments: string }[]
}

/** SessionStart decision */
export interface SessionStartDecision {
  additionalContext?: string
}

/** SessionEnd decision：无决策字段（hook 仅副作用）*/
export type SessionEndDecision = Record<string, never>

/** PostCompact decision：无决策字段 */
export type PostCompactDecision = Record<string, never>

/** 事件 → decision 映射 */
export interface HookDecisionMap {
  SessionStart: SessionStartDecision
  SessionEnd: SessionEndDecision
  UserPromptSubmit: CommonDecision
  PreLLMRequest: PreLLMRequestDecision
  PostLLMResponse: CommonDecision
  PreToolUse: PreToolUseDecision
  PostToolUse: CommonDecision
  Stop: StopDecision
  PreCompact: CommonDecision
  PostCompact: PostCompactDecision
}
