import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { assertManagedToolAllowed } from '../security/managedRequest.js'
import { SupervisionLevel } from '../config'
import type { ToolAuthorization } from '../security/rolePolicy.js'

import type { SenseResult, SenseExecutionError, ObservationEnvelope, SenseResultStatus, SenseCheckpoint, SenseCheckpointStatus, SenseRecoveryState, SenseLifecycleEvent, SenseExecutionBudget } from '@chery/plugin-api/sense'
export type { SenseResult, SenseExecutionError, ObservationEnvelope, ObservationSource, ObservationKind, SenseResultStatus, SenseErrorCode, SenseCheckpoint, SenseCheckpointStatus, SenseRecoveryState, SenseLifecycleEvent, SenseExecutionBudget } from '@chery/plugin-api/sense'

export const MAX_OBSERVATION_CONTENT_CHARS = 100_000

export function normalizeObservation(observation: ObservationEnvelope): ObservationEnvelope {
  if (!observation || !['observation', 'error'].includes(observation.kind))
    throw new Error('Invalid observation kind')
  if (typeof observation.content !== 'string') throw new Error('Invalid observation content')
  if (observation.content.length > MAX_OBSERVATION_CONTENT_CHARS)
    throw new Error('Observation content exceeds server limit')
  const sources = observation.sources?.map((source) => {
    if (!source || typeof source !== 'object') throw new Error('Invalid observation source')
    if (source.url !== undefined) {
      const url = new URL(source.url)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        throw new Error('Invalid observation source URL')
    }
    return { ...source }
  })
  return {
    ...observation,
    ...(sources ? { sources } : {}),
    untrusted: observation.untrusted ?? true,
  }
}

export function createSenseCheckpoint(input: {
  operationId: string
  senseCallId: string
  status: SenseCheckpointStatus
  startedAt?: number
  completedAt?: number
  error?: SenseExecutionError
}): SenseCheckpoint {
  return { version: 1, detached: false, ...input }
}

export function getSenseRecoveryState(checkpoint?: SenseCheckpoint): SenseRecoveryState {
  if (!checkpoint) return { required: true, reason: 'process_restart' }
  if (
    checkpoint.version !== 1 ||
    checkpoint.detached !== false ||
    !checkpoint.operationId ||
    !checkpoint.senseCallId ||
    !['completed', 'rejected'].includes(checkpoint.status) ||
    !Number.isFinite(checkpoint.completedAt)
  )
    return { required: true, reason: 'incomplete_checkpoint', checkpoint }
  return { required: false, checkpoint }
}

export const SENSE_EXECUTION_LIMITS = Object.freeze({
  timeoutMs: 120_000,
  maxOutputChars: 100_000,
  maxBytes: 400_000,
  maxConcurrent: 8,
})

// Count actual handlers, not callers still waiting for their results.
let inFlightSenseCalls = 0

export function normalizeSenseExecutionBudget(
  budget?: SenseExecutionBudget,
): Required<SenseExecutionBudget> {
  const limit = (value: number | undefined, maximum: number) =>
    Math.max(1, Math.min(Number.isFinite(value) ? Math.floor(value!) : maximum, maximum))
  return {
    timeoutMs: limit(budget?.timeoutMs, SENSE_EXECUTION_LIMITS.timeoutMs),
    maxOutputChars: limit(budget?.maxOutputChars, SENSE_EXECUTION_LIMITS.maxOutputChars),
    maxBytes: limit(budget?.maxBytes, SENSE_EXECUTION_LIMITS.maxBytes),
    maxConcurrent: limit(budget?.maxConcurrent, SENSE_EXECUTION_LIMITS.maxConcurrent),
  }
}

/** Execute one Sense with server-owned timeout, cancellation and output boundaries. */
async function executeControlledSense(
  execute: (
    input: Record<string, unknown>,
    senseSharedData: SenseSharedData,
    ctx?: SenseRuntimeContext,
  ) => Promise<SenseResult>,
  input: Record<string, unknown>,
  sharedData: SenseSharedData,
  context: SenseRuntimeContext,
): Promise<SenseResult> {
  const budget = normalizeSenseExecutionBudget(context.budget)
  if (context.signal?.aborted) return { content: '', status: 'cancelled', errorCode: 'cancelled' }
  if (context.deadlineAt !== undefined && context.deadlineAt <= Date.now())
    return { content: '', status: 'timeout', errorCode: 'timeout' }
  if (inFlightSenseCalls >= budget.maxConcurrent)
    return {
      content: '感官并发调用已达到服务端上限，请稍后重试。',
      status: 'budget_exceeded',
      errorCode: 'budget_exceeded',
    }

  inFlightSenseCalls++
  let terminalStatus: SenseResultStatus = 'provider_error'
  const controller = new AbortController()
  let acceptingResult = true
  const stoppedResult = (): SenseResult => {
    terminalStatus = context.signal?.aborted ? 'cancelled' : 'timeout'
    return {
      content: '',
      status: terminalStatus,
      errorCode: terminalStatus,
      error: { code: terminalStatus, message: terminalStatus },
    }
  }
  // Install before invoking the handler: it may synchronously cancel the run.
  let onStopped!: () => void
  const stopped = new Promise<SenseResult>((resolve) => {
    onStopped = () => resolve(stoppedResult())
    controller.signal.addEventListener('abort', onStopped, { once: true })
  })
  const onAbort = () => controller.abort()
  context.signal?.addEventListener('abort', onAbort, { once: true })
  const deadlineMs =
    context.deadlineAt === undefined
      ? budget.timeoutMs
      : Math.max(1, Math.min(budget.timeoutMs, context.deadlineAt - Date.now()))
  const timer = setTimeout(() => controller.abort(), deadlineMs)
  let operation: Promise<SenseResult> | undefined
  try {
    operation = Promise.resolve(
      execute(input, sharedData, {
        ...context,
        budget,
        deadlineAt: Date.now() + deadlineMs,
        signal: controller.signal,
        yieldTurn: context.yieldTurn
          ? () => {
              if (acceptingResult && !controller.signal.aborted) context.yieldTurn?.()
            }
          : undefined,
      }),
    ).finally(() => {
      // A detached/uncooperative handler retains its slot until it settles.
      inFlightSenseCalls--
    })
    const result = await Promise.race([stopped, operation])
    if (controller.signal.aborted) return stoppedResult()
    if (!result || typeof result.content !== 'string') {
      terminalStatus = 'invalid_result'
      return {
        content: '',
        status: terminalStatus,
        errorCode: terminalStatus,
        error: { code: terminalStatus, message: 'Sense provider returned an invalid result.' },
      }
    }
    if (result.status && result.status !== 'ok') {
      terminalStatus = result.status
      return result
    }
    const limited = result.content.slice(0, budget.maxOutputChars)
    const limitedResult: SenseResult =
      limited.length === result.content.length
        ? { ...result, status: result.status ?? 'ok' }
        : {
            ...result,
            content: `${limited}\n[结果已按服务端上限截断]`,
            status: 'budget_exceeded',
            errorCode: 'budget_exceeded',
          }
    if (Buffer.byteLength(limitedResult.content, 'utf8') > budget.maxBytes) {
      terminalStatus = 'budget_exceeded'
      const marker = '\n[结果已按服务端字节上限截断]'
      const markerBytes = Buffer.byteLength(marker, 'utf8')
      const available = Math.max(0, budget.maxBytes - markerBytes)
      let end = Math.min(limitedResult.content.length, available)
      while (end > 0 && Buffer.byteLength(limitedResult.content.slice(0, end), 'utf8') > available)
        end--
      if (markerBytes > budget.maxBytes) {
        end = Math.min(limitedResult.content.length, budget.maxBytes)
        while (
          end > 0 &&
          Buffer.byteLength(limitedResult.content.slice(0, end), 'utf8') > budget.maxBytes
        )
          end--
        return {
          ...limitedResult,
          content: limitedResult.content.slice(0, end),
          status: 'budget_exceeded',
          errorCode: 'budget_exceeded',
        }
      }
      return {
        ...limitedResult,
        content: `${limitedResult.content.slice(0, end)}${marker}`,
        status: 'budget_exceeded',
        errorCode: 'budget_exceeded',
      }
    }
    terminalStatus = limitedResult.status ?? 'ok'
    return limitedResult
  } catch (error) {
    if (controller.signal.aborted) return stoppedResult()
    terminalStatus = 'provider_error'
    return {
      content: `感官执行失败：${error instanceof Error ? error.message : String(error)}`,
      status: terminalStatus,
      errorCode: terminalStatus,
      error: {
        code: terminalStatus,
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      },
    }
  } finally {
    acceptingResult = false
    // Synchronous throws have no promise whose finally can release the slot.
    if (!operation) inFlightSenseCalls--
    clearTimeout(timer)
    controller.signal.removeEventListener('abort', onStopped)
    context.signal?.removeEventListener('abort', onAbort)
  }
}

/** Single public execution boundary; lifecycle data never includes input or result text. */
export async function executeSenseWithControl(
  execute: (
    input: Record<string, unknown>,
    senseSharedData: SenseSharedData,
    ctx?: SenseRuntimeContext,
  ) => Promise<SenseResult>,
  input: Record<string, unknown>,
  sharedData: SenseSharedData,
  context: SenseRuntimeContext,
): Promise<SenseResult> {
  const operationId = context.operationId ?? randomUUID()
  const emit = (event: SenseLifecycleEvent): void => {
    try {
      context.onLifecycleEvent?.(event)
    } catch {
      // Optional diagnostic observers cannot change the result.
    }
  }
  const startedAt = Date.now()
  emit({ phase: 'start', operationId, senseCallId: context.messageId, at: startedAt })
  const result = await executeControlledSense(execute, input, sharedData, {
    ...context,
    operationId,
  })
  const status = result.status ?? 'ok'
  const normalized: SenseResult =
    status === 'ok'
      ? result
      : {
          ...result,
          errorCode: status,
          error: result.error ?? {
            code: status,
            message: status,
            retryable: false,
            ...(status === 'recovery_required' ? { recoveryRequired: true } : {}),
          },
        }
  const completed: SenseResult = {
    ...normalized,
    operationId,
    durationMs: Math.max(0, Date.now() - startedAt),
    ...(normalized.status === 'budget_exceeded' ? { truncated: true } : {}),
  }
  emit({
    phase: 'finish',
    operationId,
    senseCallId: context.messageId,
    at: Date.now(),
    status,
    errorCode: completed.errorCode,
    detached: false,
  })
  return completed
}

export interface SenseFunction {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: {
        [key: string]: {
          type?: string | string[]
          items?: unknown
          description?: string
          enum?: unknown[]
        }
      }
      required: string[]
      additionalProperties: boolean
    }
  }
}

/** Sense间共享数据结构 */
export type SenseSharedData = Map<string, Map<string, unknown>>

/**
 * 工具能力声明：工具自己描述「接收什么、产出什么、是否前置执行、每批容量」。
 *
 * - `accepts`：接收的媒体类型（image/video/audio）或文件后缀（doc/docx/pdf…）。
 *   用于前置调度匹配（preprocess=true 时按实际媒体类型/后缀匹配）与发送门控判断。
 * - `produces`：产出的媒体类型（image/video/audio）或 text。生成类工具注入判断
 *   以工具自身 produces 声明为准（大脑 generate.* 标记不再作为注入门）。
 * - `preprocess`：是否前置执行（缺省 false = 普通后置工具，模型按需调用）。
 *   前置工具在发请求前执行，结果替换进消息（理解类媒体在非多模态模型下的处理路径）。
 * - `batchSize`：每批最多同时处理多少媒体项（缺省 = 一次性全量处理）。
 *   仅影响工具内部实现（分批调用外部接口），调度层永远全量传入。
 */
export interface SenseCapabilities {
  accepts?: string[]
  produces?: string[]
  preprocess?: boolean
  batchSize?: number
}

/**
 * 感官运行时上下文（P2-11：注入边界，取代 sharedData 注入 chatId 的临时方案）。
 *
 * executor 第 3 参数（optional，兼容 2-param handler）。
 * 取消信号来自当前 run；工具不能通过该上下文扩大授权。
 */
export interface SenseRuntimeContext {
  requestView?: Readonly<import('@/service/ingress/api.js').IngressRequestView>
  /** 当前运行取消信号；支持取消的工具应透传至外部请求。 */
  signal?: AbortSignal
  /** Absolute deadline (epoch milliseconds), when supplied by the run owner. */
  deadlineAt?: number
  /** Server-side operation limits; values are clamped to SENSE_EXECUTION_LIMITS. */
  budget?: SenseExecutionBudget
  /** Stable correlation id for provider/runtime telemetry. */
  operationId?: string
  /** Optional non-blocking observer for durable lifecycle projections. */
  onLifecycleEvent?: (event: SenseLifecycleEvent) => void
  /** Detached execution is intentionally not part of the generic Sense contract. */
  detached?: false
  /** 当前 chatId（bash 等需按会话归属的 sense 读取） */
  chatId: string
  /**
   * 请求 loop 在本轮 runChain 后立即结束（yield turn）。
   * spawn_role wait=true 调：主 agent 立即结束本 turn，子完成后由后端注入角色回复唤起新一轮
   * （见 docs/shared/architecture/agent-orchestration.md §5.4）。senseMiddleware 提供闭包，置 ctx.soul.yieldTurn=true，loop 读取。
   */
  yieldTurn?: () => void
  /**
   * 当前 sense call id（= 主 chat sense message.id）。
   * spawn_role 等需回写自身关联（写到子 chat metadata，供后续 role_reply 透传前端）；
   * 前端 F 改动（点击 role 子头像 smooth scroll 回主 chat 的 sense 调用框）依赖此字段。
   * 缺省 → sense 不关注 messageId。
   */
  messageId?: string
  /** 已在统一工具门完成复核的本次授权；执行器只能消费，不能自行扩大。 */
  security?: ToolAuthorization
  /** 当前会话的规范工作区根目录。需要文件系统或命令执行的工具必须 fail closed。 */
  workspaceRoot?: string
}

export interface SenseExecutor<T extends z.ZodType> {
  schema: T
  /** execute：第 3 参数 ctx 为运行时上下文（optional，2-param handler 向后兼容） */
  execute: (
    input: z.infer<T>,
    senseSharedData: SenseSharedData,
    ctx?: SenseRuntimeContext,
  ) => Promise<SenseResult>
}

export interface Sense<T extends z.ZodType> {
  definition: SenseFunction
  executor: SenseExecutor<T>
  /** Sense自身声明的监管等级（未声明时由外部 fallback 到 global || smart） */
  supervisionLevel: SupervisionLevel | undefined
  /** 工具能力声明：接收/产出类型、是否前置执行、每批容量（缺省 undefined = 无声明） */
  capabilities?: SenseCapabilities
}

export function sense<T extends z.ZodType>(
  name: string,
  description: string,
  schema: T,
  handler: (
    input: z.infer<T>,
    senseSharedData: SenseSharedData,
    ctx?: SenseRuntimeContext,
  ) => Promise<SenseResult>,
  supervisionLevel?: SupervisionLevel,
  capabilities?: SenseCapabilities,
): Sense<T> {
  const jsonSchema = (schema as any).toJSONSchema()

  const definition: SenseFunction = {
    type: 'function',
    function: {
      name,
      description,
      parameters: {
        type: jsonSchema.type ?? 'object',
        properties: jsonSchema.properties ?? {},
        required: jsonSchema.required ?? [],
        additionalProperties: false,
      },
    },
  }

  const executor: SenseExecutor<T> = {
    schema,
    execute: async (input, sharedData, ctx) => {
      assertManagedToolAllowed(name, ctx?.requestView?.identity)
      return handler(input, sharedData, ctx)
    },
  }

  return {
    definition,
    executor,
    supervisionLevel,
    ...(capabilities ? { capabilities } : {}),
  }
}
