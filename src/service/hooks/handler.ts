import type { RpcRouter, HandlerContext } from '../message/router.js'
import {
  Method,
  ErrorCode,
  createResponse,
  createError,
  type Response,
  type HooksGetResponseData,
  type HooksSaveRequestData,
  type HooksSaveResponseData,
  type HooksEventsResponseData,
  type HooksHandlerDTO,
} from '../message/types.js'
import { readGlobalHooks, readBrainHooksMap, writeGlobalHooks } from '@/agent/hooks/registry.js'
import { describePosixShell } from '@/core/security/sandbox.js'
import type { HookEvent } from '@/agent/hooks/types.js'
import type { HookHandlerConfig } from '@/agent/hooks/matcher.js'
import { logger } from '@/utils/logger/index.js'

/**
 * Hooks 设置 RPC handler。
 *
 * hooks.get：读 .chery/hooks/hooks.json + brain 级 hooks，供设置面板编辑。
 * hooks.save：校验 + 写回 hooks.json，清缓存（dispatcher 下次 dispatch 重新加载）。
 * hooks.events：返回 10 事件的静态元数据（名称/描述/实现状态）。
 */

/** 合法事件名集合（与 agent/hooks/types.ts HookEvent 同步）*/
const VALID_EVENTS = new Set<string>([
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreLLMRequest',
  'PostLLMResponse',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'PreCompact',
  'PostCompact',
])

/**
 * 事件能力标签：前端用 chip 展示该事件 handler 能改什么。
 * - '改body'：handler 返回 {body} 替换请求体（仅 PreLLMRequest）
 * - '改args'：handler 返回 {updatedInput} 合并到感官 args（仅 PreToolUse）
 * - '阻断'：decision:'block' → 抛 ClassifiedError 终止对应动作
 * - 'ask'：PreToolUse decision:'ask' → 触发审批弹窗
 * - '改content'：改写 LLM 响应 content（PostLLMResponse）
 * - '改senseCalls'：改写 LLM 返回的感官调用列表（PostLLMResponse）
 * - '注入上下文'：additionalContext 注入 chat 上下文（SessionStart/PostToolUse/...）
 * - '只读'：dispatcher 仅 logger.event，未真调 handler（stub 事件）
 */
type HookCapability =
  '改body' | '改args' | '阻断' | 'ask' | '改content' | '改senseCalls' | '注入上下文' | '只读'

/** 事件元数据：capabilities 决定前端 chip；matcherField 提示 matcher 比对字段 */
interface EventMetaEntry {
  name: HookEvent
  label: string
  description: string
  capabilities: HookCapability[]
  /** matcher 比对的 payload 字段名（提示用户 matcher 匹配什么）*/
  matcherField?: string
}

/** 事件元数据（静态表；capabilities 反映 dispatcher 真实行为）*/
const EVENT_META: EventMetaEntry[] = [
  {
    name: 'PreLLMRequest',
    label: 'LLM 调用前',
    description: 'Provider 构造 body 后、fetch 前；改 body 适配怪异端点',
    capabilities: ['改body', '阻断'],
    matcherField: 'provider',
  },
  {
    name: 'PreToolUse',
    label: '工具执行前',
    description: '感官执行前；改 args / 拒绝 / 触发审批',
    capabilities: ['改args', '阻断', 'ask'],
    matcherField: 'name',
  },
  {
    name: 'PostToolUse',
    label: '工具执行后',
    description: '感官执行成功后；阻断时 result 替换为 reason',
    capabilities: ['阻断', '注入上下文'],
    matcherField: 'name',
  },
  {
    name: 'UserPromptSubmit',
    label: '用户提交消息',
    description: '用户消息到达、LLM 调用前；阻断终止本轮',
    capabilities: ['阻断', '注入上下文'],
    matcherField: 'role',
  },
  {
    name: 'PostLLMResponse',
    label: 'LLM 响应后',
    description: 'LLM 响应解析后；可改写 content / 感官调用列表',
    capabilities: ['改content', '改senseCalls', '注入上下文'],
    matcherField: 'provider',
  },
  {
    name: 'Stop',
    label: '对话停止',
    description: 'LLM 返回 end_turn 后、yield 前；block 仅记录',
    capabilities: ['阻断', '注入上下文'],
  },
  {
    name: 'SessionStart',
    label: '会话开始',
    description: 'Chat 第一轮前；注入上下文',
    capabilities: ['注入上下文'],
  },
  {
    name: 'SessionEnd',
    label: '会话结束',
    description: 'Chat 终止；当前仅副作用',
    capabilities: ['只读'],
  },
  { name: 'PreCompact', label: '压缩前', description: '上下文压缩前', capabilities: ['只读'] },
  { name: 'PostCompact', label: '压缩后', description: '上下文压缩后', capabilities: ['只读'] },
]

/** HookHandlerConfig → HooksHandlerDTO（结构相同，类型桥接）*/
function toDTO(h: HookHandlerConfig): HooksHandlerDTO {
  return {
    matcher: h.matcher,
    if: h.if,
    command: h.command,
    timeout: h.timeout,
  }
}

/** HooksHandlerDTO → HookHandlerConfig */
function fromDTO(d: HooksHandlerDTO): HookHandlerConfig {
  return {
    matcher: d.matcher,
    if: d.if,
    command: d.command,
    timeout: d.timeout,
  }
}

/** hooks.get：读全局 + brain 级 hooks */
async function handleHooksGet(_ctx: HandlerContext): Promise<HooksGetResponseData> {
  const global = readGlobalHooks()
  const brainMap = readBrainHooksMap()

  const handlers: Record<string, HooksHandlerDTO[]> = {}
  for (const [event, list] of Object.entries(global)) {
    if (list) handlers[event] = list.map(toDTO)
  }

  const brainHooks: Record<string, Record<string, HooksHandlerDTO[]>> = {}
  for (const [brainName, brainHooks_] of Object.entries(brainMap)) {
    const mapped: Record<string, HooksHandlerDTO[]> = {}
    for (const [event, list] of Object.entries(brainHooks_)) {
      if (list) mapped[event] = list.map(toDTO)
    }
    brainHooks[brainName] = mapped
  }

  logger.event('hooks.get', {
    eventCount: Object.keys(handlers).length,
    brainCount: Object.keys(brainHooks).length,
  })
  // handler 执行器平台状态（HooksTab 页头展示；describe 不抛，失败转 available:false + 指引）
  const shell = describePosixShell()
  const shellInfo = {
    platform: process.platform,
    ...(shell.available
      ? { available: true as const, executable: shell.executable }
      : { available: false as const, hint: shell.hint }),
  }
  return { handlers, brainHooks, shellInfo }
}

/** hooks.save：校验 + 写回 */
async function handleHooksSave(
  ctx: HandlerContext,
  data: HooksSaveRequestData,
): Promise<HooksSaveResponseData | Response> {
  const rid = ctx.requestId ?? ''

  // 校验事件名
  const invalidEvents = Object.keys(data.handlers).filter((e) => !VALID_EVENTS.has(e))
  if (invalidEvents.length > 0) {
    return createResponse(
      rid,
      false,
      undefined,
      createError(ErrorCode.INVALID_PARAMS, `未知事件: ${invalidEvents.join(', ')}`),
    )
  }

  // 校验每个 handler 有 command
  for (const [event, list] of Object.entries(data.handlers)) {
    for (let i = 0; i < list.length; i++) {
      if (!list[i]?.command?.trim()) {
        return createResponse(
          rid,
          false,
          undefined,
          createError(ErrorCode.INVALID_PARAMS, `${event}[${i}]: command 不能为空`),
        )
      }
    }
  }

  // 转换为内部类型并写入
  const handlerMap: Partial<Record<HookEvent, HookHandlerConfig[]>> = {}
  for (const [event, list] of Object.entries(data.handlers)) {
    handlerMap[event as HookEvent] = list.map(fromDTO)
  }
  writeGlobalHooks(handlerMap)

  logger.event('hooks.save', { eventCount: Object.keys(data.handlers).length })
  return { ok: true }
}

/** hooks.events：返回静态事件元数据 */
async function handleHooksEvents(): Promise<HooksEventsResponseData> {
  return { events: EVENT_META }
}

export function registerHooksHandlers(router: RpcRouter): void {
  router.register(Method.HOOKS_GET, handleHooksGet)
  router.register(Method.HOOKS_SAVE, handleHooksSave)
  router.register(Method.HOOKS_EVENTS, handleHooksEvents)
}
