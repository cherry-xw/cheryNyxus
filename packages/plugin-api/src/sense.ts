import type { z } from 'zod'
import type { IngressRequestView } from './index.js'
export type SupervisionLevel = 0 | 1 | 2
export interface ToolAuthorization { decision: 'allow' | 'ask' | 'deny'; roleType: string; policyHash: string; requiredSandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access'; findings: Array<{ [key: string]: unknown }>; assessmentHash: string }
export interface SenseResult {
  content: string
  hash?: string
  /** Optional typed observation metadata; omitted for legacy results. */
  observation?: ObservationEnvelope
  /** Machine-readable terminal state. Omitted means success for compatibility. */
  status?: SenseResultStatus
  errorCode?: SenseErrorCode
  error?: SenseExecutionError
  operationId?: string
  durationMs?: number
  truncated?: boolean
}

export interface SenseExecutionError {
  code: SenseErrorCode
  message: string
  retryable?: boolean
  recoveryRequired?: boolean
}

export type ObservationKind = 'observation' | 'error'

export interface ObservationSource {
  url?: string
  citationId?: string
  observedAt?: string
  provider?: string
  path?: string
}

export interface ObservationEnvelope {
  schemaVersion?: 1
  kind: ObservationKind
  /** Model-visible data only; metadata is never treated as control instructions. */
  content: string
  sources?: ObservationSource[]
  observedAt?: string
  provider?: string
  path?: string
  /** MIME type of the observed resource, not a rendering instruction. */
  contentType?: string
  /** UTF-8 bytes read from the resource, before text extraction. */
  bytesRead?: number
  /** Correlates the observation with execution and recovery records. */
  operationId?: string
  truncated?: boolean
  untrusted?: boolean
  error?: { code: string; message: string }
}

export type SenseResultStatus =
  | 'ok'
  | 'timeout'
  | 'cancelled'
  | 'budget_exceeded'
  | 'provider_error'
  | 'invalid_result'
  | 'recovery_required'

export type SenseErrorCode = Exclude<SenseResultStatus, 'ok'>

export type SenseCheckpointStatus =
  'pending' | 'started' | 'completed' | 'rejected' | 'incomplete' | 'recovery_required'

export interface SenseCheckpoint {
  version: 1
  operationId: string
  senseCallId: string
  status: SenseCheckpointStatus
  detached: false
  startedAt?: number
  completedAt?: number
  error?: SenseExecutionError
}

export interface SenseRecoveryState {
  required: boolean
  reason?: 'incomplete_checkpoint' | 'process_restart' | 'detached_not_allowed'
  checkpoint?: SenseCheckpoint
}

export type SenseLifecycleEvent =
  | {
      phase: 'start'
      operationId: string
      senseCallId?: string
      senseName?: string
      at: number
    }
  | {
      phase: 'finish'
      operationId: string
      senseCallId?: string
      senseName?: string
      at: number
      status: SenseResultStatus
      errorCode?: SenseErrorCode
      detached: false
    }

export interface SenseExecutionBudget {
  timeoutMs?: number
  maxOutputChars?: number
  /** UTF-8 result text limit. Does not include downloaded response bytes. */
  maxBytes?: number
  maxConcurrent?: number
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

export type SenseSharedData = Map<string, Map<string, unknown>>

export interface SenseCapabilities {
  accepts?: string[]
  produces?: string[]
  preprocess?: boolean
  batchSize?: number
}

export interface SenseRuntimeContext {
  requestView?: Readonly<IngressRequestView>
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
  security?: unknown
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