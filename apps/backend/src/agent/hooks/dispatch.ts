import { spawn } from 'node:child_process'
import { getSenseOrigin } from '@/core/sense/senseRegistry.js'
import { logger, LogLevel } from '@/utils/logger/index.js'
import { trackRestartActivity } from '@/service/restartCoordinator.js'
import { ClassifiedError } from '@/utils/error.js'
import { resolvePosixShell } from '@/core/security/sandbox.js'
import { loadHookRegistry } from './registry.js'
import { matches, evalIf, expandCommandTemplate, type HookHandlerConfig } from './matcher.js'
import { functionHooks, invokeFunction, projectHookContext } from './functions.js'
import { isReadonlyHook, validateDecision } from './decisions.js'
import type { HookEvent, HookDispatchContext, HookPayloadMap, HookDecisionMap } from './types.js'

function failure(code: string, reason?: string): ClassifiedError {
  return new ClassifiedError({
    message: code,
    userMessage: reason || '请求处理检查未完成，已拒绝操作',
    category: 'validation',
    source: 'hook',
  })
}
/** Shared dispatch: published functions, global commands, then the selected brain's commands. */
export async function dispatch<E extends HookEvent>(
  event: E,
  payload: HookPayloadMap[E],
  ctx: HookDispatchContext,
): Promise<HookDecisionMap[E] | undefined> {
  const mutable = structuredClone(payload) as unknown as Record<string, unknown>
  const merged: Record<string, unknown> = {}
  const readonly = isReadonlyHook(event)
  const functions = functionHooks(event)
  const commands = [...(loadHookRegistry()[event] ?? [])]
  const apply = (raw: unknown, ownerId: string) => {
    const decision = validateDecision(event, raw, mutable)
    if (decision.decision === 'block' || decision.decision === 'deny')
      throw failure('HOOK_DENIED', decision.reason as string | undefined)
    if (decision.toolPhase) {
      merged.toolPhase = (decision.toolPhase as string[]).filter(name => getSenseOrigin(name)?.pluginId === ownerId)
      delete decision.toolPhase
    }
    if (decision.excludedTools) {
      merged.excludedTools = (decision.excludedTools as string[]).filter(name => getSenseOrigin(name)?.pluginId === ownerId)
      delete decision.excludedTools
    }
    if (decision.tools) {
      merged.tools = [...((merged.tools ?? []) as string[]), ...(decision.tools as string[]).filter(name => getSenseOrigin(name)?.pluginId === ownerId)]
      delete decision.tools
    }
    if (decision.contexts) {
      merged.contexts = [
        ...((merged.contexts ?? []) as unknown[]),
        ...(decision.contexts as Record<string, unknown>[]).map((item) => ({ ...item, ownerId })),
      ]
      delete decision.contexts
    }
    if (decision.additionalContext) {
      merged.additionalContext = [merged.additionalContext, decision.additionalContext]
        .filter(Boolean)
        .join('\n')
      delete decision.additionalContext
    }
    if (merged.decision === 'ask' && decision.decision === 'allow') delete decision.decision
    Object.assign(merged, decision)
    if (event === 'PreLLMRequest' && decision.body) mutable.body = decision.body
    if (event === 'PreToolUse' && decision.updatedInput)
      mutable.args = { ...(mutable.args as object), ...(decision.updatedInput as object) }
    if (event === 'PreToolUse' && decision.updatedInput) merged.updatedInput = mutable.args
  }
  const run = async (
    action: (signal: AbortSignal) => Promise<unknown>,
    ownerId: string,
    required: boolean,
    timeoutMs: number,
    pluginSignal?: AbortSignal,
  ) => {
    if (ctx.signal?.aborted && !readonly) throw failure('HOOK_CANCELLED')
    const controller = new AbortController()
    const abort = () => controller.abort()
    ctx.signal?.addEventListener('abort', abort, { once: true })
    pluginSignal?.addEventListener('abort', abort, { once: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const stopped = new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(failure('HOOK_CANCELLED')), {
          once: true,
        })
        timer = setTimeout(() => {
          reject(failure('HOOK_TIMEOUT'))
          controller.abort()
        }, timeoutMs)
      })
      if (pluginSignal?.aborted || (ctx.signal?.aborted && !readonly)) controller.abort()
      const value = await Promise.race([
        Promise.resolve().then(() => action(controller.signal)),
        stopped,
      ])
      if (controller.signal.aborted) throw failure('HOOK_CANCELLED')
      apply(value, ownerId)
    } catch (error) {
      if (!readonly && error instanceof ClassifiedError && error.message === 'HOOK_DENIED')
        throw error
      if (!readonly && (required || ctx.signal?.aborted)) throw failure('HOOK_DENIED')
      logger.event('hook.failed', { event, ownerId, code: 'HOOK_FAILED' }, LogLevel.warn)
    } finally {
      if (timer) clearTimeout(timer)
      ctx.signal?.removeEventListener('abort', abort)
      pluginSignal?.removeEventListener('abort', abort)
    }
  }
  for (const entry of functions)
    await run(
      (signal) =>
        invokeFunction(entry, mutable as unknown as HookPayloadMap[HookEvent], ctx, signal),
      entry.ownerId,
      entry.definition.required ?? !readonly,
      entry.definition.timeoutMs ?? 10000,
      entry.signal,
    )
  for (const handler of commands) {
    if (handler.brain && handler.brain !== ctx.brain) continue
    const matcherValue = String(mutable.provider ?? mutable.name ?? mutable.role ?? '')
    if (
      !matches(handler.matcher, matcherValue) ||
      (handler.if && !evalIf(handler.if, { event, payload: mutable, ctx }))
    )
      continue
    await run(
      async (signal) => {
        const safeContext = projectHookContext(ctx)
        delete safeContext.signal
        return runCommand(handler, { event, payload: mutable, ctx: safeContext }, signal)
      },
      'command',
      handler.required ?? !readonly,
      Math.min(30000, Math.max(1, (handler.timeout ?? 10) * 1000)),
    )
  }
  if (merged.body) (payload as unknown as Record<string, unknown>).body = mutable.body
  if (merged.updatedInput) (payload as unknown as Record<string, unknown>).args = mutable.args
  return Object.keys(merged).length ? (merged as HookDecisionMap[E]) : undefined
}
function runCommand(
  handler: HookHandlerConfig,
  input: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const command = expandCommandTemplate(handler.command, {
    ...process.env,
    CHERY_DIR: process.env.CHERY_DIR || process.cwd(),
  })
  const executable = resolvePosixShell().executable
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-c', command], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    })
    const release = trackRestartActivity({
      kind: 'hook',
      description: '等待 Hook 进程退出',
      pid: child.pid,
    })
    let stdout = ''
    let stdoutBytes = 0
    let stderrBytes = 0
    let settled = false
    const kill = () => {
      if (process.platform !== 'win32' && child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {}
      }
      child.kill('SIGKILL')
    }
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      release()
      if (error) reject(error)
      else resolve(value)
    }
    const abort = () => {
      kill()
      finish(failure('HOOK_CANCELLED'))
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    child.stdin.on('error', () => {})
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > 256 * 1024) {
        kill()
        finish(failure('HOOK_OUTPUT_LIMIT'))
        return
      }
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length
      if (stderrBytes > 256 * 1024) {
        kill()
        finish(failure('HOOK_OUTPUT_LIMIT'))
      }
    })
    child.on('error', () => finish(failure('HOOK_SPAWN_FAILED')))
    child.on('close', (code) => {
      if (code === 2) {
        finish(failure('HOOK_DENIED'))
        return
      }
      if (code !== 0) {
        finish(failure('HOOK_NONZERO_EXIT'))
        return
      }
      try {
        finish(undefined, stdout.trim() ? JSON.parse(stdout) : undefined)
      } catch {
        finish(failure('HOOK_INVALID_JSON'))
      }
    })
    child.stdin.end(JSON.stringify(input))
  })
}
