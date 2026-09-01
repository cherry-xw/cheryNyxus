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
import config, {
  type MockScriptChunk,
  type MockScriptError,
  type MockScriptResponse,
} from '@/utils/config'
import { logger } from '@/utils/logger/index.js'
import { LogLevel } from '@/utils/logger/types.js'
import { ClassifiedError } from '@/utils/error.js'
import { LlmProtocol } from '@chery/protocol'

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

export interface MockProviderTranscriptEntry {
  model: string
  chatId: string
  turn: number
  attempt: number
  outcome: 'response' | 'error'
  toolNames: string[]
}

const attemptCursor = new Map<string, number>()
const transcript: MockProviderTranscriptEntry[] = []

export function resetMockProviderState(): void {
  attemptCursor.clear()
  transcript.length = 0
}

export function getMockProviderTranscript(): readonly MockProviderTranscriptEntry[] {
  return transcript.map((entry) => ({ ...entry, toolNames: [...entry.toolNames] }))
}

/** .chery 目录（与 config.ts 同源） */
const cheryDir = process.env.CHERY_DIR || process.cwd()

function expandFixtureVariables(value: string): string {
  // Keep YAML fixtures portable across Windows/Linux workspaces while still
  // feeding absolute paths to real filesystem tools.
  return value.replaceAll('{{CHERY_DIR}}', cheryDir.replaceAll('\\', '/'))
}

/** Abort-aware delay so chat.abort can stop mock first-token/stream waits immediately. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('aborted'))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(signal?.reason ?? new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

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
 * 按 model 查找 mock brain 的全局延迟兜底（脚本项缺省时取此）。流式/刷新计时测试用。
 */
function findMockDelays(model: string): { chunkDelayMs?: number; preRespondMs?: number } {
  for (const b of Object.values(config.llm.brain)) {
    if (b.provider === 'mock' && b.model === model) return b.mock ?? {}
  }
  return {}
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
      arguments: expandFixtureVariables(sc.arguments),
    })),
  }
}

/**
 * 取当前轮脚本项。
 * 索引 = messages 中 role==="assistant" 的数量（每次 LLM 调用增一个 assistant 轮 = 已调用次数）。
 * 无状态、天然 per-chat；撤回 revoked 被过滤 → 索引自动回退。
 * 耗尽后 repeat:last 时重复最后一条，否则返回空。
 */
function pickScriptItem(options: LLMOptions | undefined, messages: LLMResponse[]): MockScriptResponse {
  const model = options?.model ?? ''
  const chatId = options?.chatId ?? 'unscoped'
  const file = findMockFile(model)
  const { repeat, script } = file
    ? loadScriptFile(file)
    : { repeat: undefined, script: [] as MockScriptResponse[] }
  const index = messages.filter((m) => m.role === 'assistant').length

  if (script.length === 0) {
    logger.event('mock.script.empty', { model, file }, LogLevel.warn)
    if (process.env.CHERY_MOCK_STRICT === 'true') {
      throw new Error(`Mock script is empty: ${model} (${file ?? 'no file'})`)
    }
    return { content: '' }
  }
  let selected: MockScriptResponse
  if (index < script.length) {
    logger.event('mock.turn', { model, file, turn: index })
    selected = script[index]!
  } else if (repeat === 'last') {
    logger.event('mock.exhausted.repeat', { model, turn: index })
    selected = script[script.length - 1]!
  } else {
    logger.event('mock.exhausted.empty', { model, turn: index }, LogLevel.warn)
    if (process.env.CHERY_MOCK_STRICT === 'true') {
      throw new Error(`Mock script exhausted: ${model} turn ${index}`)
    }
    selected = { content: '' }
  }

  const key = `${model}\u0000${chatId}\u0000${index}`
  const attempt = attemptCursor.get(key) ?? 0
  attemptCursor.set(key, attempt + 1)
  const scriptedAttempts = selected.attempts
  const attemptItem = scriptedAttempts?.length
    ? scriptedAttempts[Math.min(attempt, scriptedAttempts.length - 1)]!
    : undefined
  if (
    scriptedAttempts?.length &&
    attempt >= scriptedAttempts.length &&
    process.env.CHERY_MOCK_STRICT === 'true'
  ) {
    throw new Error(`Mock attempts exhausted: ${model} turn ${index} attempt ${attempt + 1}`)
  }
  const resolved = attemptItem ? { ...selected, ...attemptItem, attempts: undefined } : selected
  transcript.push({
    model,
    chatId,
    turn: index,
    attempt: attempt + 1,
    outcome: resolved.error || resolved.chunks?.some((chunk) => chunk.error) ? 'error' : 'response',
    toolNames: [
      ...(resolved.senseCalls?.map((call) => call.name) ?? []),
      ...(resolved.chunks?.flatMap((chunk) => chunk.senseCalls?.map((call) => call.name) ?? []) ?? []),
    ],
  })
  return resolved
}

function throwScriptError(error: MockScriptError): never {
  if (typeof error === 'string') throw new Error(error)
  throw new ClassifiedError({
    message: error.message,
    userMessage: error.userMessage ?? error.message,
    category: error.category ?? 'unknown',
    source: error.source ?? 'brain',
  })
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
    const item = pickScriptItem(options, messages as LLMResponse[])
    if (item.error) throwScriptError(item.error)
    const preRespond = item.preRespondMs ?? findMockDelays(model).preRespondMs ?? 0
    if (preRespond > 0) await sleep(preRespond, options?.signal)
    return toResponse(item)
  },
  async chatStream(messages, _senses, options?: LLMOptions): Promise<AsyncIterable<unknown>> {
    const model = options?.model ?? ''
    const item = pickScriptItem(options, messages as LLMResponse[])
    if (item.error) throwScriptError(item.error)
    const resp = toResponse(item)
    const delays = findMockDelays(model)
    const chunkDelay = item.chunkDelayMs ?? delays.chunkDelayMs ?? 0
    const preRespond = item.preRespondMs ?? delays.preRespondMs ?? 0
    if (preRespond > 0) await sleep(preRespond, options?.signal)

    // 拆 delta：thinking / content / toolCalls 各一 chunk（触发 checkpoint delta 状态机）。
    // chunkDelay>0 时每个 delta 前 sleep，模拟流式节奏（刷新/重连测试可靠落在流式窗口内）。
    async function* gen(): AsyncIterable<MockStreamChunk> {
      if (item.chunks) {
        for (const scripted of item.chunks) {
          const delayMs = scripted.delayMs ?? chunkDelay
          if (delayMs > 0) await sleep(delayMs, options?.signal)
          const chunk = toStreamChunk(scripted)
          if (chunk.thinking || chunk.content || chunk.toolCalls?.length) yield chunk
          if (scripted.error) throwScriptError(scripted.error)
        }
        return
      }
      if (resp.thinking) {
        if (chunkDelay > 0) await sleep(chunkDelay, options?.signal)
        yield { thinking: resp.thinking }
      }
      if (resp.content) {
        if (chunkDelay > 0) await sleep(chunkDelay, options?.signal)
        yield { content: resp.content }
      }
      if (resp.toolCalls && resp.toolCalls.length > 0) {
        if (chunkDelay > 0) await sleep(chunkDelay, options?.signal)
        yield { toolCalls: resp.toolCalls }
      }
    }
    return gen()
  },
}

function toStreamChunk(item: MockScriptChunk): MockStreamChunk {
  return {
    thinking: item.thinking,
    content: item.content,
    toolCalls: item.senseCalls?.map((call, index) => ({
      index,
      id: call.id ?? randomUUID(),
      name: call.name,
      arguments: expandFixtureVariables(call.arguments),
    })),
  }
}

// ========== 注册函数 ==========

export function registerMockAdapter(): void {
  for (const key of ['mock', LlmProtocol.MOCK]) {
    registerMessageAdapter<MockResponse, MockStreamChunk, LLMResponse>(
      key,
      mockMessageAdapterConfig,
    )
    registerSenseAdapter<MockResponse>(key, mockSenseAdapterConfig)
    registerLLMAdapter(key, mockLLMAdapter)
  }
}
