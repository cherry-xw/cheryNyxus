import {
  ErrorCode,
  ErrorId,
  RunOutcomeReasonCode,
  type ErrorId as ErrorIdValue,
  type ErrorSource,
  type FeedbackAction,
  type RunOutcomeReasonCode as RunOutcomeReasonCodeValue,
  type UserFeedback,
} from '@chery/protocol'
import type { ErrorCategory } from '@/utils/error.js'

const TRACE_PREFIX = /^\[[0-9a-f]{8}\]\s*/i
const MAX_DETAIL_LENGTH = 200

function withoutTrace(message: string): string {
  return message.replace(TRACE_PREFIX, '').trim()
}

function normalizeDetail(detail?: string): string | undefined {
  if (!detail) return undefined
  const normalized = detail.replace(/\s+/g, ' ').trim()
  if (!normalized) return undefined
  return normalized.length > MAX_DETAIL_LENGTH
    ? `${normalized.slice(0, MAX_DETAIL_LENGTH - 1)}…`
    : normalized
}

function appendDetailsAction(actions: FeedbackAction[], detail?: string): FeedbackAction[] {
  return detail ? [...actions, { type: 'view_details' }] : actions
}

type RpcPresentation = { title: string; guidance?: string; actions: FeedbackAction[] }

const RPC_PRESENTATION: Record<ErrorCode, RpcPresentation> = {
  [ErrorCode.METHOD_NOT_FOUND]: {
    title: '当前版本不支持此操作',
    guidance: '请确认桌面端与服务端版本一致；如果只升级过一端，请同步升级另一端后重试。',
    actions: [{ type: 'dismiss' }],
  },
  [ErrorCode.INTERNAL]: {
    title: '操作没有完成',
    guidance: '可以稍后重试；如果持续出现，请复制追踪码用于排查。',
    actions: [{ type: 'retry' }, { type: 'view_details' }],
  },
  [ErrorCode.TIMEOUT]: {
    title: '等待响应超时',
    guidance: '请检查连接后重试。',
    actions: [{ type: 'retry' }],
  },
  [ErrorCode.NOT_FOUND]: {
    title: '目标不存在或已被移除',
    guidance: '请刷新后重新选择。',
    actions: [{ type: 'dismiss' }],
  },
  [ErrorCode.INVALID_PARAMS]: {
    title: '请求内容不完整',
    guidance: '请检查输入后重新发送。',
    actions: [{ type: 'resend_input' }],
  },
  [ErrorCode.CONFLICT]: {
    title: '状态已经发生变化',
    guidance: '请刷新当前状态后重试。',
    actions: [{ type: 'retry' }],
  },
  [ErrorCode.RUNTIME_SELECTION_REQUIRED]: {
    title: '还没有选择运行环境',
    guidance: '请先在设置中选择运行环境。',
    actions: [{ type: 'open_settings', section: 'runtime' }],
  },
  [ErrorCode.MAINTENANCE_MODE]: {
    title: '服务正在维护',
    guidance: '请稍后重试。',
    actions: [{ type: 'retry' }],
  },
  [ErrorCode.INTERACTION_STALE]: {
    title: '这个操作已经过期',
    guidance: '请以当前界面中的最新状态为准。',
    actions: [{ type: 'dismiss' }],
  },
  [ErrorCode.INTERACTION_ALREADY_RESOLVED]: {
    title: '这个操作已经处理过了',
    guidance: '无需重复操作。',
    actions: [{ type: 'dismiss' }],
  },
  [ErrorCode.COMMAND_CONFLICT]: {
    title: '已有操作正在执行',
    guidance: '请等待当前操作结束后再试。',
    actions: [{ type: 'retry' }],
  },
  [ErrorCode.INPUT_QUEUE_FULL]: {
    title: '待处理消息太多',
    guidance: '请等待一部分消息处理完成后再发送。',
    actions: [{ type: 'retry' }],
  },
  [ErrorCode.PROFILE_VERSION_UNSUPPORTED]: {
    title: '配置版本不兼容',
    guidance: '请使用与当前配置兼容的客户端版本，或将桌面端与服务端升级到同一版本。',
    actions: [{ type: 'dismiss' }],
  },
  [ErrorCode.RATE_LIMITED]: {
    title: '请求太频繁',
    guidance: '请稍等一会儿再试。',
    actions: [{ type: 'retry' }],
  },
}

export function feedbackForRpcError(input: {
  code: string
  message: string
  source: ErrorSource
  tracingId: string
  retryable: boolean
}): UserFeedback {
  const preset = RPC_PRESENTATION[input.code as ErrorCode] ?? RPC_PRESENTATION[ErrorCode.INTERNAL]
  return {
    code: input.code,
    severity: 'error',
    source: input.source,
    title: preset.title,
    description: withoutTrace(input.message) || preset.title,
    ...(preset.guidance ? { guidance: preset.guidance } : {}),
    actions: preset.actions,
    retention: 'transient',
    tracingId: input.tracingId,
  }
}

const RUN_REASON_BY_CATEGORY: Record<ErrorCategory, RunOutcomeReasonCodeValue> = {
  auth: RunOutcomeReasonCode.AUTH_FAILED,
  network: RunOutcomeReasonCode.NETWORK_FAILED,
  provider: RunOutcomeReasonCode.PROVIDER_FAILED,
  timeout: RunOutcomeReasonCode.TIMEOUT,
  validation: RunOutcomeReasonCode.VALIDATION_FAILED,
  unknown: RunOutcomeReasonCode.UNKNOWN_FAILED,
}

type RunPresentation = {
  title: string
  description?: string
  guidance: string
  fallbackGuidance?: string
  actions: FeedbackAction[]
}

const RUN_PRESENTATION: Record<ErrorCategory, RunPresentation> = {
  auth: {
    title: 'AI 服务凭证不可用',
    guidance: '请在设置中检查服务地址、模型和密钥。',
    actions: [{ type: 'open_settings', section: 'provider' }],
  },
  network: {
    title: 'AI 服务连接中断',
    guidance: '请检查网络或服务状态后继续运行。',
    fallbackGuidance: '请检查网络或服务状态后重新发送。',
    actions: [{ type: 'resume_run' }],
  },
  provider: {
    title: 'AI 服务没有完成请求',
    guidance: '可以稍后继续运行；如果持续出现，请检查服务配置。',
    fallbackGuidance: '可以稍后重新发送；如果持续出现，请检查服务配置。',
    actions: [{ type: 'resume_run' }, { type: 'open_settings', section: 'provider' }],
  },
  timeout: {
    title: 'AI 服务响应超时',
    guidance: '请检查连接后继续运行。',
    fallbackGuidance: '请检查连接后重新发送。',
    actions: [{ type: 'resume_run' }],
  },
  validation: {
    title: '本轮请求无法继续',
    guidance: '请检查最后一条输入和当前配置，再决定继续运行或重新发送。',
    fallbackGuidance: '请检查最后一条输入和当前配置后重新发送。',
    actions: [{ type: 'resume_run' }, { type: 'resend_input' }],
  },
  unknown: {
    title: '本轮运行意外中断',
    guidance: '可以继续运行；如果持续出现，请复制追踪码用于排查。',
    fallbackGuidance: '请重新发送；如果持续出现，请复制追踪码用于排查。',
    actions: [{ type: 'resume_run' }],
  },
}

const BRAIN_CONFIGURATION_VALIDATION_PRESENTATION: RunPresentation = {
  title: 'AI 服务配置有误',
  guidance: '请在设置中修正模型地址、模型或密钥配置后，再继续运行。',
  fallbackGuidance: undefined,
  actions: [{ type: 'open_settings' as const, section: 'provider' as const }],
}

/**
 * 具体错误 ID → 用户响应。核心层只负责提供稳定 ID；这里集中决定文案与动作。
 * category/source 目录仍作为旧错误和未知错误 ID 的兼容兜底。
 */
const RUN_PRESENTATION_BY_ERROR_ID: Record<ErrorIdValue, RunPresentation> = {
  [ErrorId.BRAIN_CONFIG_MODEL_MISSING]: {
    title: 'AI 服务配置不完整',
    description: '当前 AI 服务没有配置模型。',
    guidance: '请在设置中为当前 AI 服务选择模型后，再重新发送。',
    actions: [{ type: 'open_settings', section: 'provider' }],
  },
  [ErrorId.BRAIN_CONFIG_URL_MISSING]: {
    title: 'AI 服务配置不完整',
    description: '当前 AI 服务没有配置服务地址。',
    guidance: '请在设置中填写服务地址后，再重新发送。',
    actions: [{ type: 'open_settings', section: 'provider' }],
  },
  [ErrorId.BRAIN_CONFIG_KEY_MISSING]: {
    title: 'AI 服务配置不完整',
    description: '当前 AI 服务没有配置密钥。',
    guidance: '请在设置中填写密钥或环境变量后，再重新发送。',
    actions: [{ type: 'open_settings', section: 'provider' }],
  },
  [ErrorId.BRAIN_CONFIG_KEY_ENV_UNRESOLVED]: {
    title: 'AI 服务配置不完整',
    description: '密钥引用的环境变量尚未配置。',
    guidance: '请配置对应环境变量，或在设置中改用可用密钥后重新发送。',
    actions: [{ type: 'open_settings', section: 'provider' }],
  },
  [ErrorId.BRAIN_CONFIG_KEY_ENV_INVALID]: {
    title: 'AI 服务配置有误',
    description: '密钥的环境变量占位符格式不正确。',
    guidance: '请将占位符改成 $API_KEY 这类全大写格式后，再重新发送。',
    actions: [{ type: 'open_settings', section: 'provider' }],
  },
}

export function runFailureFeedback(input: {
  errorId?: ErrorIdValue
  category: ErrorCategory
  source: ErrorSource
  description: string
  tracingId: string
  detail?: string
  canResume: boolean
}): { reasonCode: RunOutcomeReasonCodeValue; feedback: UserFeedback } {
  const preset = input.errorId
    ? RUN_PRESENTATION_BY_ERROR_ID[input.errorId]
    : input.category === 'validation' && input.source === 'brain'
      ? BRAIN_CONFIGURATION_VALIDATION_PRESENTATION
      : RUN_PRESENTATION[input.category]
  const detail = normalizeDetail(input.detail)
  const applicableActions = preset.actions.filter(
    (action) => action.type !== 'resume_run' || input.canResume,
  )
  const actions: FeedbackAction[] =
    applicableActions.length > 0 ? applicableActions : [{ type: 'resend_input' }]
  const reasonCode = RUN_REASON_BY_CATEGORY[input.category]
  return {
    reasonCode,
    feedback: {
      code: input.errorId ?? reasonCode,
      severity: 'error',
      source: input.source,
      title: preset.title,
      description: preset.description ?? (withoutTrace(input.description) || preset.title),
      guidance: input.canResume ? preset.guidance : (preset.fallbackGuidance ?? preset.guidance),
      actions: appendDetailsAction(actions, detail ?? input.tracingId),
      retention: 'history',
      tracingId: input.tracingId,
      ...(detail ? { detail } : {}),
    },
  }
}

export function loopLimitFeedback(input: { maxLoop: number; iterations: number }): UserFeedback {
  return {
    code: RunOutcomeReasonCode.LOOP_LIMIT_REACHED,
    severity: 'warning',
    source: 'system',
    title: '已达到循环上限',
    description: `本轮已执行 ${input.iterations} 次。为避免继续重复或失控运行，系统已安全暂停，当前会话内容和执行现场已保留。`,
    guidance:
      '请先检查最后几步是否在重复；确认仍需继续时可以继续运行，也可以在“设置 → 限制”调整最大循环次数。',
    actions: [
      { type: 'resume_run' },
      { type: 'open_settings', section: 'limits' },
      { type: 'view_details' },
      { type: 'dismiss' },
    ],
    retention: 'history',
    detail: `iterations=${input.iterations}; maxLoop=${input.maxLoop}`,
  }
}
