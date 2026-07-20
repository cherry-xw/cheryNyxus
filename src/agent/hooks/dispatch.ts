/**
 * Hooks dispatcher：按事件触发 shell handler，解析 stdout JSON，应用决策。
 *
 * 设计：
 * - 顺序执行（不支持并发：避免 stdout 竞态）
 * - matcher 过滤 + if 谓词过滤（按 payload+ctx 评估）
 * - 单 handler 异常（非 0/2）→ log + 继续；exit 2 → 阻断
 * - PreLLMRequest 完整实现；其它 9 事件 stub（logger.event + 返回 undefined）
 *
 * 详见 [docs/agent/hooks.md](../../../../docs/agent/hooks.md)。
 */

import { spawn } from 'node:child_process'
import { logger, LogLevel } from '@/utils/logger/index.js'
import { ClassifiedError } from '@/utils/error.js'
import { loadHookRegistry } from './registry.js'
import { matches, evalIf, expandCommandTemplate, type HookHandlerConfig } from './matcher.js'
import type { HookEvent, HookDispatchContext, HookPayloadMap, HookDecisionMap } from './types.js'

/** runHandler 返回值：解析后的 decision 或特殊标记（exit 2 阻断） */
type RunHandlerResult<TDecision> =
  { ok: true; decision: TDecision | null } | { ok: false; error: ClassifiedError }

/**
 * 通用 dispatch 入口。
 *
 * 各事件按 event type 走对应执行路径：handler 顺序执行 → 合并 decision → 应用到 payload
 * - PreLLMRequest：decision.body 替换 payload.body；decision:'block' 抛 ClassifiedError
 * - PreToolUse：decision.updatedInput 修改 args；decision:'deny' 抛 ClassifiedError
 * - PostToolUse / UserPromptSubmit / PostLLMResponse：decision.decision === 'block' 抛 ClassifiedError
 * - Stop：decision.decision === 'block' → chat 层强制继续（仅返回 decision，由调用方决策）
 * - 其它事件（SessionStart/SessionEnd/PreCompact/PostCompact）：stub
 */
export async function dispatch<E extends HookEvent>(
  event: E,
  payload: HookPayloadMap[E],
  ctx: HookDispatchContext,
): Promise<HookDecisionMap[E] | undefined> {
  const registry = loadHookRegistry()
  const handlers = registry[event]
  if (!handlers || handlers.length === 0) {
    // 其它事件 stub（仅记录日志，handler 暂未启用）
    if (event !== 'PreLLMRequest' && event !== 'PreToolUse') {
      logger.event('hook.stub', { event, brain: ctx.brain }, LogLevel.debug)
    }
    return undefined
  }

  switch (event) {
    case 'PreLLMRequest':
      return dispatchWithPayload<'PreLLMRequest'>(
        event,
        payload as unknown as HookPayloadMap['PreLLMRequest'],
        ctx,
        handlers,
      ) as Promise<HookDecisionMap[E] | undefined>
    case 'PreToolUse':
      return dispatchWithPayload<'PreToolUse'>(
        event,
        payload as unknown as HookPayloadMap['PreToolUse'],
        ctx,
        handlers,
      ) as Promise<HookDecisionMap[E] | undefined>
    case 'PostToolUse':
    case 'UserPromptSubmit':
    case 'PostLLMResponse':
    case 'Stop':
      return dispatchDecisionsOnly<E>(event, payload, ctx, handlers)
    default:
      logger.event('hook.stub', { event, brain: ctx.brain }, LogLevel.debug)
      return undefined
  }
}

/**
 * 通用 handler 执行循环：顺序执行匹配 handler，合并所有 decision（后置覆盖前置）。
 * 任何 handler 抛 {ok:false, error} → 立即抛 ClassifiedError（阻断）。
 * 返回合并后的 decision（如果所有 handler 都返回 null/空 → undefined）。
 */
async function dispatchWithPayload<E extends HookEvent>(
  event: E,
  payload: HookPayloadMap[E],
  ctx: HookDispatchContext,
  handlers: HookHandlerConfig[],
): Promise<HookDecisionMap[E] | undefined> {
  // 用 mutable 容器承载 payload（handler 可能改 body / args）
  const mutable = { payload: { ...(payload as unknown as Record<string, unknown>) } } as {
    payload: Record<string, unknown>
  }
  const merged: Record<string, unknown> = {}

  for (const handler of handlers) {
    // matcher 过滤：按事件选字段
    const matchValue = getMatcherValue(event, mutable.payload)
    if (!matches(handler.matcher, matchValue)) continue

    // if 谓词过滤
    if (handler.if && !evalIf(handler.if, { event, payload: mutable.payload, ctx })) {
      continue
    }

    const result = await runHandler(handler, { event, payload: mutable.payload, ctx })
    if (!result.ok) throw result.error

    const decision = result.decision
    if (!decision) continue

    Object.assign(merged, decision)

    // 阻断：立即返回
    if (merged.decision === 'block') {
      // 应用 decision 到 payload
      applyDecisionToPayload(event, mutable.payload, merged as never)
      throwDecision(event, merged as never)
    }
  }

  // 应用 merged 到 payload
  if (Object.keys(merged).length > 0) {
    applyDecisionToPayload(event, mutable.payload, merged as never)
  }

  // 反向写回 payload（调用方可读到最新值）
  Object.assign(payload as unknown as Record<string, unknown>, mutable.payload)
  if (Object.keys(merged).length > 0) {
    return merged as HookDecisionMap[E]
  }
  return undefined
}

/**
 * 决策型事件：handler 返回 decision 后由调用方决策（不修改 payload），仅合并返回。
 * block 决策作为 error 抛（PreToolUse: 'deny' 视为 block）。
 */
async function dispatchDecisionsOnly<E extends HookEvent>(
  event: E,
  payload: HookPayloadMap[E],
  ctx: HookDispatchContext,
  handlers: HookHandlerConfig[],
): Promise<HookDecisionMap[E] | undefined> {
  const merged: Record<string, unknown> = {}

  for (const handler of handlers) {
    const matchValue = getMatcherValue(event, payload as unknown as Record<string, unknown>)
    if (!matches(handler.matcher, matchValue)) continue

    if (handler.if && !evalIf(handler.if, { event, payload, ctx })) {
      continue
    }

    const result = await runHandler(handler, { event, payload, ctx })
    if (!result.ok) throw result.error

    const decision = result.decision
    if (!decision) continue

    Object.assign(merged, decision)

    if (merged.decision === 'block') {
      // 阻断语义：抛 ClassifiedError（调用方 catch 后用 userMessage 响应）
      throwDecision(event, merged as never)
    }
  }

  if (Object.keys(merged).length === 0) return undefined
  return merged as HookDecisionMap[E]
}

/** 选 matcher 比较字段 */
function getMatcherValue(event: HookEvent, payload: Record<string, unknown>): string {
  switch (event) {
    case 'PreLLMRequest':
      return String(payload.provider ?? '')
    case 'PreToolUse':
    case 'PostToolUse':
      return String(payload.name ?? '')
    case 'PostLLMResponse':
      return String(payload.provider ?? '')
    case 'UserPromptSubmit':
      return String(payload.role ?? '')
    case 'Stop':
    case 'PreCompact':
    case 'PostCompact':
    case 'SessionStart':
    case 'SessionEnd':
      return ''
  }
}

/** 应用 decision 到 payload（事件特定）*/
function applyDecisionToPayload(
  event: HookEvent,
  payload: Record<string, unknown>,
  decision: { body?: Record<string, unknown>; updatedInput?: Record<string, unknown> },
): void {
  if (event === 'PreLLMRequest' && decision.body) {
    payload.body = decision.body
  } else if (event === 'PreToolUse' && decision.updatedInput) {
    // 合并 args（updatedInput 是 patch）
    const args = (payload.args as Record<string, unknown> | undefined) ?? {}
    payload.args = { ...args, ...decision.updatedInput }
  }
}

/** 抛 ClassifiedError（hook 阻断） */
function throwDecision(event: HookEvent, decision: { reason?: string; decision?: string }): never {
  const reason = decision.reason ?? `被 ${event} 钩子拦截`
  throw new ClassifiedError({
    message: `${event} hook ${decision.decision}: ${reason}`,
    userMessage: reason,
    category: 'validation',
    source: 'hook',
  })
}

/**
 * 执行单个 handler：spawn sh -c command，stdin 写 JSON，stdout 解析为 decision。
 *
 * 返回值：
 * - `{ok:true, decision}`：exit 0 + stdout JSON 解析成功（或空，decision=null）
 * - `{ok:false, error}`：exit 2（阻断）或 spawn 严重错误 → 调用方决定是否抛
 */
async function runHandler<TDecision>(
  handler: HookHandlerConfig,
  stdinPayload: Record<string, unknown>,
): Promise<RunHandlerResult<TDecision>> {
  const cheryDir = process.env.CHERY_DIR || process.cwd()
  const env: Record<string, string | undefined> = {
    CHERY_DIR: cheryDir,
    ...(process.env as Record<string, string | undefined>),
  }
  const expandedCommand = expandCommandTemplate(handler.command, env)
  const timeoutMs = (handler.timeout ?? 10) * 1000

  return new Promise<RunHandlerResult<TDecision>>((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let child

    try {
      child = spawn('sh', ['-c', expandedCommand], {
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (err) {
      logger.event(
        'hook.spawn_failed',
        {
          command: handler.command,
          error: (err as Error).message,
        },
        LogLevel.warn,
      )
      resolve({
        ok: false,
        error: new ClassifiedError({
          message: `Hook spawn failed: ${handler.command}`,
          userMessage: '钩子启动失败',
          category: 'validation',
          source: 'hook',
          cause: err,
        }),
      })
      return
    }

    // stdin 异步 error（如 EPIPE：handler 进程已退出，stdin 写入失败）→ 吞掉，不阻断
    child.stdin?.on?.('error', () => {
      // handler 已读 stdin 或已退出，写入端关闭属正常
    })

    const timer = setTimeout(() => {
      timedOut = true
      child?.kill('SIGKILL')
      logger.event('hook.timeout', { command: handler.command, timeoutMs }, LogLevel.warn)
      resolve({
        ok: false,
        error: new ClassifiedError({
          message: `Hook timeout: ${handler.command}`,
          userMessage: '钩子执行超时',
          category: 'validation',
          source: 'hook',
        }),
      })
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      logger.event(
        'hook.failed',
        {
          command: handler.command,
          error: err.message,
          stderr: stderr.slice(0, 200),
        },
        LogLevel.warn,
      )
      resolve({
        ok: false,
        error: new ClassifiedError({
          message: `Hook spawn error: ${handler.command}`,
          userMessage: '钩子执行失败',
          category: 'validation',
          source: 'hook',
          cause: err,
        }),
      })
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) return // 已 resolve

      if (code === 2) {
        // 显式阻断
        const reason = stderr.trim() || 'handler exit 2'
        resolve({
          ok: false,
          error: new ClassifiedError({
            message: `Hook exit 2 (block): ${handler.command}`,
            userMessage: reason,
            category: 'validation',
            source: 'hook',
          }),
        })
        return
      }

      if (code !== 0) {
        logger.event(
          'hook.failed',
          {
            command: handler.command,
            exitCode: code,
            stderr: stderr.slice(0, 200),
          },
          LogLevel.warn,
        )
        resolve({ ok: true, decision: null })
        return
      }

      // exit 0：解析 stdout JSON（最后一行非空）
      const trimmed = stdout.trim()
      if (!trimmed) {
        resolve({ ok: true, decision: null })
        return
      }
      try {
        const parsed = JSON.parse(trimmed) as TDecision
        resolve({ ok: true, decision: parsed })
      } catch (err) {
        logger.event(
          'hook.parse_failed',
          {
            command: handler.command,
            error: (err as Error).message,
            stdout: trimmed.slice(0, 200),
          },
          LogLevel.warn,
        )
        resolve({ ok: true, decision: null })
      }
    })

    // 写 stdin
    try {
      child.stdin?.write(JSON.stringify(stdinPayload))
      child.stdin?.end()
    } catch (err) {
      clearTimeout(timer)
      logger.event(
        'hook.stdin_failed',
        {
          command: handler.command,
          error: (err as Error).message,
        },
        LogLevel.warn,
      )
      resolve({ ok: true, decision: null })
    }
  })
}
