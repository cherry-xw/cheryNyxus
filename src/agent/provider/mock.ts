import fs from 'fs'
import path from 'path'
import yaml from 'js-yaml'
import { randomUUID } from 'crypto'
import { registerMessageAdapter, type LLMResponse } from '@/core/message/adapter'
import {
  registerSenseAdapter,
  type Sense,
  type SenseCallData,
  type SenseFunction,
} from '@/core/sense'
import type { ZodType } from 'zod'
import { registerLLMAdapter, type LLMAdapter, type LLMOptions } from '@/core/llm/adapter'
import { buildBaseSenseFunction } from '@/core/sense/compiler/utils.js'
import config, { type MockScriptResponse } from '@/utils/config'
import { logger } from '@/utils/logger/index.js'
import { LogLevel } from '@/utils/logger/types.js'

// ========== mock raw 格式（自定义，不接真实 API）==========

interface MockToolCall {
  index: number
  id: string
  name: string
  arguments: string
}

/** 流式 chunk：thinking / content / toolCalls 各自独立 delta */
interface MockStreamChunk {
  thinking?: string
  content?: string
  toolCalls?: MockToolCall[]
}

/** 非流式完整响应 */
interface MockResponse {
  thinking?: string
  content?: string
  toolCalls?: MockToolCall[]
}

// ========== 脚本回放核心 ==========

/** 脚本文件内容（独立 .yaml：repeat + script[]） */
interface MockScriptFile {
  repeat?: 'last'
  script: MockScriptResponse[]
}

/** .chery 目录（与 config.ts 同源） */
const cheryDir = process.env.CHERY_DIR || process.cwd()

/**
 * 按 model 查找 mock brain 的脚本文件配置（config.llm.brain 按 name 索引，遍历匹配 provider+model）
 */
function findMockFile(model: string): string | undefined {
  for (const b of Object.values(config.llm.brain)) {
    if (b.provider === 'mock' && b.model === model) return b.mock?.file
  }
  return undefined
}

/**
 * 加载脚本文件（.chery/<file>，不缓存——dev 改脚本免重启）
 */
function loadScriptFile(file: string): MockScriptFile {
  const filePath = path.join(cheryDir, '.chery', file)
  if (!fs.existsSync(filePath)) {
    logger.event('mock.script.missing', { filePath }, LogLevel.warn)
    return { script: [] }
  }
  const raw = fs.readFileSync(filePath, 'utf8')
  const parsed = (yaml.load(raw) as MockScriptFile | null) ?? { script: [] }
  if (!parsed.script) parsed.script = []
  return parsed
}

/**
 * 脚本项 → MockResponse（补 toolCall id/index，id 缺省 mock-${i}）
 */
function toResponse(item: MockScriptResponse): MockResponse {
  return {
    thinking: item.thinking,
    content: item.content,
    toolCalls: item.senseCalls?.map((sc, i) => ({
      index: i,
      // 缺省 id 注入运行时唯一值：真实 LLM 每次返回唯一 id（OpenAI call_xxx），
      // mock 缺省值需保证唯一，避免 resume/revoke 重放或跨 chat 同月份 messages 表冲突。
      // 脚本显式声明的 id 仅作可读标签，实际入库 id 由 adapter 保证唯一。
      id: sc.id ?? randomUUID(),
      name: sc.name,
      arguments: sc.arguments,
    })),
  }
}

/**
 * 取当前轮脚本项。
 * 索引 = messages 中 role==="assistant" 的数量（每次 LLM 调用增一个 assistant 轮 = 已调用次数）。
 * 无状态、天然 per-chat；撤回 revoked 被过滤 → 索引自动回退。
 * 耗尽后 repeat:last 时重复最后一条，否则返回空。
 */
function pickScriptItem(model: string, messages: LLMResponse[]): MockScriptResponse {
  const file = findMockFile(model)
  const { repeat, script } = file
    ? loadScriptFile(file)
    : { repeat: undefined, script: [] as MockScriptResponse[] }
  const index = messages.filter((m) => m.role === 'assistant').length

  if (script.length === 0) {
    logger.event('mock.script.empty', { model, file }, LogLevel.warn)
    return { content: '' }
  }
  if (index < script.length) {
    logger.event('mock.turn', { model, file, turn: index })
    return script[index]!
  }
  if (repeat === 'last') {
    logger.event('mock.exhausted.repeat', { model, turn: index })
    return script[script.length - 1]!
  }
  logger.event('mock.exhausted.empty', { model, turn: index })
  return { content: '' }
}

// ========== Message Adapter ==========

const mockMessageAdapterConfig = {
  content: (raw: MockResponse) => raw.content ?? '',
  thinking: (raw: MockResponse) => raw.thinking,
  extractStreamDelta: (chunk: MockStreamChunk) => chunk.content ?? '',
  extractStreamThinking: (chunk: MockStreamChunk) => chunk.thinking,
  buildMessages: (history: LLMResponse[]) => history.filter((m) => !m.revoked), // P5b：mock 不解析 attachments，签名对齐接口忽略参数
}

// ========== Sense Adapter ==========

const mockSenseAdapterConfig = {
  buildSenses(senses: Sense<ZodType>[]): SenseFunction[] {
    return senses.map((s) => ({ type: 'function', function: buildBaseSenseFunction(s) }))
  },
  senseCalls(response: MockResponse): SenseCallData[] {
    return (response.toolCalls ?? []).map((tc) => ({
      index: tc.index,
      id: tc.id,
      name: tc.name,
      arguments: tc.arguments,
    }))
  },
  extractSenseCallDeltas(chunk: unknown): SenseCallData[] {
    const c = chunk as MockStreamChunk
    return (c.toolCalls ?? []).map((tc) => ({
      index: tc.index,
      id: tc.id,
      name: tc.name,
      arguments: tc.arguments,
    }))
  },
}

// ========== LLM Adapter ==========

const mockLLMAdapter: LLMAdapter = {
  async chat(messages, _senses, options?: LLMOptions): Promise<unknown> {
    const model = options?.model ?? ''
    const item = pickScriptItem(model, messages as LLMResponse[])
    if (item.error) throw new Error(item.error)
    return toResponse(item)
  },
  async chatStream(messages, _senses, options?: LLMOptions): Promise<AsyncIterable<unknown>> {
    const model = options?.model ?? ''
    const item = pickScriptItem(model, messages as LLMResponse[])
    if (item.error) throw new Error(item.error)
    const resp = toResponse(item)

    // 拆 delta：thinking / content / toolCalls 各一 chunk（触发 checkpoint delta 状态机）
    async function* gen(): AsyncIterable<MockStreamChunk> {
      if (resp.thinking) yield { thinking: resp.thinking }
      if (resp.content) yield { content: resp.content }
      if (resp.toolCalls && resp.toolCalls.length > 0) yield { toolCalls: resp.toolCalls }
    }
    return gen()
  },
}

// ========== 注册函数 ==========

export function registerMockAdapter(): void {
  registerMessageAdapter<MockResponse, MockStreamChunk, LLMResponse>(
    'mock',
    mockMessageAdapterConfig,
  )
  registerSenseAdapter<MockResponse>('mock', mockSenseAdapterConfig)
  registerLLMAdapter('mock', mockLLMAdapter)
}
