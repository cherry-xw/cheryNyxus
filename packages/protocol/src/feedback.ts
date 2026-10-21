import {
  ErrorCode,
  ErrorId,
  RunOutcomeReasonCode,
  type ErrorId as ErrorIdValue,
  type ErrorSource,
  type FeedbackAction,
  type RunOutcomeReasonCode as RunOutcomeReasonCodeValue,
  type UserFeedback,
} from './rpc.js'
export type ErrorCategory = 'auth' | 'network' | 'provider' | 'timeout' | 'validation' | 'unknown'

function appendDetailsAction(actions: FeedbackAction[], detail?: string): FeedbackAction[] {
  return detail ? [...actions, { type: 'view_details' }] : actions
}

type RpcPresentation = { title: string; guidance?: string; actions: FeedbackAction[] }

const RPC_PRESENTATION: Record<ErrorCode, RpcPresentation> = {
  [ErrorCode.BACKEND_STOPPING]: { title: '服务正在关闭，不能开始新任务', guidance: '可以继续处理当前任务的问题或审批；取消关闭或重新启动后再提交新任务。', actions: [{ type: 'dismiss' }] },
  [ErrorCode.SCOPE_UNSYNCED]: {title:'图片采集权限尚未同步',actions:[{type:'dismiss'}]},
  [ErrorCode.STALE_SCOPE]: {title:'图片采集权限已改变',actions:[{type:'dismiss'}]},
  [ErrorCode.SOURCE_CONFLICT]: {title:'图片来源信息不一致',actions:[{type:'dismiss'}]},
  [ErrorCode.QUOTA_EXCEEDED]: {title:'图片存储额度已满',actions:[{type:'dismiss'}]},
  [ErrorCode.OFFSET_MISMATCH]: {title:'图片分块位置不一致',actions:[{type:'dismiss'}]},
  [ErrorCode.DIGEST_MISMATCH]: {title:'图片完整性校验失败',actions:[{type:'dismiss'}]},
  [ErrorCode.SOURCE_UNAVAILABLE]: {title:'原生图片来源不可用',actions:[{type:'dismiss'}]},
  [ErrorCode.STORAGE_UNAVAILABLE]: {title:'图片存储暂不可用',actions:[{type:'dismiss'}]},
  [ErrorCode.UPLOAD_ABORTED]: {title:'图片采集已停止',actions:[{type:'dismiss'}]},
  [ErrorCode.API_VERSION_MISMATCH]: { title: '插件接口版本不兼容', actions: [{ type: 'dismiss' }] },
  [ErrorCode.DEPENDENCY_CYCLE]: { title: '插件存在循环依赖', actions: [{ type: 'dismiss' }] },
  [ErrorCode.DEPENDENCY_UNAVAILABLE]: {
    title: '插件依赖未启用或不可用',
    actions: [{ type: 'dismiss' }],
  },
  [ErrorCode.DEPENDENCY_VERSION_MISMATCH]: {
    title: '插件依赖版本不一致',
    actions: [{ type: 'dismiss' }],
  },
  [ErrorCode.REGISTRATION_CONFLICT]: {
    title: '插件注册名称已被使用',
    actions: [{ type: 'dismiss' }],
  },
  [ErrorCode.CAPABILITY_DENIED]: { title: '插件未获准执行此操作', actions: [{ type: 'dismiss' }] },
  [ErrorCode.IDENTITY_REJECTED]: {
    title: '请求身份已失效或未经验证',
    actions: [{ type: 'dismiss' }],
  },
  [ErrorCode.TOOL_UNAVAILABLE]: { title: '当前工具不可用', actions: [{ type: 'dismiss' }] },
  [ErrorCode.STOP_TIMEOUT]: {
    title: '插件未能按时停止',
    guidance: '请重启宿主后再执行卸载。',
    actions: [{ type: 'dismiss' }],
  },
  [ErrorCode.REVISION_CONFLICT]: {
    title: '配置或插件状态已改变',
    guidance: '请重新读取当前状态。',
    actions: [{ type: 'dismiss' }],
  },
  [ErrorCode.REQUEST_ID_CONFLICT]: {
    title: '同一请求标识对应了不同操作',
    actions: [{ type: 'dismiss' }],
  },
  [ErrorCode.UNAVAILABLE]: { title: '插件当前不可用', actions: [{ type: 'dismiss' }] },
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
  const preset = Object.hasOwn(RPC_PRESENTATION,input.code) ? RPC_PRESENTATION[input.code as ErrorCode] : RPC_PRESENTATION[ErrorCode.INTERNAL]
  return {
    code: input.code,
    severity: 'error',
    source: input.source,
    title: preset.title,
    description: preset.title,
    guidance: input.retryable ? (preset.guidance ?? '请检查当前状态后再决定操作。') : '请检查当前状态或联系管理员；不会自动重试，不能直接重复未知结果的操作。',
    actions: input.retryable ? preset.actions : preset.actions.filter(action => action.type !== 'retry').length ? preset.actions.filter(action => action.type !== 'retry') : [{type:'dismiss'}],
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

/**
 * 具体错误 ID → 用户响应。核心层只负责提供稳定 ID；这里集中决定文案与动作。
 * category/source 目录仍作为旧错误和未知错误 ID 的兼容兜底。
 */
const RUN_PRESENTATION_BY_ERROR_ID: Record<ErrorIdValue, RunPresentation> = {
  [ErrorId.CAPABILITY_REQUIRES_APPROVAL]: {title:'文件处理需要审批',description:'当前文件工具需要人工审批或被角色权限限制，未自动执行。',guidance:'请在工作台检查角色权限并通过受保护的审批流程处理。',actions:[{type:'view_details'}]},
  [ErrorId.FILE_OPERATION_FAILED]: {title:'文件处理未完成',description:'文件工具没有返回可用结果，不能视为已经读取文件。',guidance:'请检查文件操作状态和服务配置；结果未知时不要重复发起收费操作。',actions:[{type:'view_details'}]},
  [ErrorId.REQUEST_INPUT_TOO_LARGE]: {title:'请求内容超过上限',description:'本次请求的内容或上下文超过当前模型或传输上限，尚未发送。',guidance:'请减少输入或文件内容，检查上下文预算后重新提交。',actions:[{type:'resend_input'}]},
  [ErrorId.REQUEST_THINKING_UNSUPPORTED]: {title:'思考配置不受支持',description:'当前型号与协议不支持所选思考配置，本次未发送模型请求。',guidance:'请管理员选择此型号支持的思考等级，不会自动更换模型或设置。',actions:[{type:'open_settings',section:'provider'}]},
  [ErrorId.REQUEST_TOOLS_UNSUPPORTED]: {title:'当前模型配置不支持工具',description:'当前型号、协议与思考等级不支持所需函数调用，本次未发送请求。',guidance:'请管理员检查型号、协议及工具能力；不会自动删除工具或更换配置。',actions:[{type:'open_settings',section:'provider'}]},
  [ErrorId.BRAIN_HTTP_AUTH_REJECTED]: { title: 'AI 服务拒绝认证', description: 'AI 服务拒绝了当前凭据或访问权限。', guidance: '请管理员检查服务密钥与模型访问权限；不会自动重试。', actions: [{ type: 'open_settings', section: 'provider' }] },
  [ErrorId.BRAIN_HTTP_RATE_LIMITED]: { title: 'AI 服务限制请求', description: 'AI 服务返回请求限制，可能是频率或额度限制；当前无法进一步确定。', guidance: '请检查服务额度和限制后再决定重试，避免反复提交。', actions: [{ type: 'view_details' }] },
  [ErrorId.BRAIN_CONTEXT_OVERFLOW]: { title: 'AI 服务确认输入超出窗口', description: '服务方明确报告本次模型输入超过可用上下文。', guidance: '请减少单次输入或检查固定提示词与工具；无法安全压缩恢复时不会自动重复执行工具。', actions: [{ type: 'view_details' }] },
  [ErrorId.BRAIN_HTTP_REQUEST_REJECTED]: { title: 'AI 服务拒绝请求参数', description: 'AI 服务拒绝了请求内容或参数；不是已确认的图片审核拒绝。', guidance: '请管理员按追踪码检查请求协议、模型及参数配置后再试；不会自动重试。', actions: [{ type: 'view_details' }] },
  [ErrorId.BRAIN_HTTP_SERVICE_FAILED]: { title: 'AI 服务发生异常', description: 'AI 服务返回服务端错误，未完成本次调用。', guidance: '请检查提供商状态后再决定继续；不会自动重复执行 QQ 任务。', actions: [{ type: 'view_details' }] },
  [ErrorId.BRAIN_IMAGE_REVIEW_REJECTED]: {
    title: '上游图片审核拒绝请求',
    description: '上游图片审核拒绝了本次请求，可能存在误判；这不代表已确认图片违规，也无法据此确定是哪张图。',
    guidance: '不会自动重试、移除图片或更换模型。可联系提供商反馈，或自行决定后续如何处理。',
    actions: [{ type: 'view_details' }, { type: 'dismiss' }],
  },
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
  [ErrorId.ASSET_NOT_FOUND]: {
    title: '找不到引用的文件',
    description: '消息或工具引用的文件不存在或已被清理。',
    guidance: '请重新上传或选择可用文件后再试。',
    actions: [{ type: 'resend_input' }],
  },
  [ErrorId.ASSET_UNAVAILABLE]: {
    title: '文件当前不可访问',
    description: '当前会话或角色无权访问该文件，或文件无法读取。',
    guidance: '请检查文件来源并重新附加后再试。',
    actions: [{ type: 'resend_input' }],
  },
  [ErrorId.ASSET_TOO_LARGE]: {
    title: '文件超出大小限制',
    description: '上传或处理的文件超出了当前策略或接口允许的上限。',
    guidance: '请缩小文件体积或在全局文件设置中调整大小限制。',
    actions: [{ type: 'open_settings', section: 'provider' }],
  },
  [ErrorId.ASSET_FORMAT_UNSUPPORTED]: {
    title: '文件格式不受支持',
    description: '当前模型或文件服务不支持该文件格式的处理。',
    guidance: '请转换文件格式或在设置中配置支持该格式的文件服务。',
    actions: [{ type: 'open_settings', section: 'provider' }],
  },
  [ErrorId.CAPABILITY_UNAVAILABLE]: {
    title: '当前缺少所需的文件处理能力',
    description: '当前角色既没有对应的模型原生能力，也没有可用的文件服务工具或可委派角色。',
    guidance: '请在设置中配置对应的文件服务或角色文件能力后再试。',
    actions: [{ type: 'open_settings', section: 'provider' }],
  },
  [ErrorId.CAPABILITY_SELECTION_REQUIRED]: {
    title: '需要指定文件处理方式',
    description: '存在多个可用的文件服务或角色候选，系统无法自动唯一决定。',
    guidance: '请在角色设置中指定默认处理对象，或在本次消息中明确指定。',
    actions: [{ type: 'open_settings', section: 'provider' }],
  },
  [ErrorId.CAPABILITY_DELEGATION_CYCLE]: {
    title: '角色文件委派存在循环',
    description: '角色之间的文件能力委派形成了循环链路。',
    guidance: '请在角色设置中修改文件能力的委派目标，解除循环引用。',
    actions: [{ type: 'open_settings', section: 'provider' }],
  },
  [ErrorId.FILE_SERVICE_INVALID_CONFIG]: {
    title: '文件服务配置有误',
    description: '所选文件服务的地址、模型或密钥配置不完整或无效。',
    guidance: '请在设置中检查并修正文件服务配置后再试。',
    actions: [{ type: 'open_settings', section: 'provider' }],
  },
  [ErrorId.FILE_OPERATION_RESULT_UNKNOWN]: {
    title: '远端生成结果尚未确认',
    description: '请求已发出但连接中断，远端是否已完成尚不明确。',
    guidance: '请先刷新状态或等待确认，避免盲目重新扣费提交。',
    actions: [{ type: 'resume_run' }],
  },
  [ErrorId.FILE_OPERATION_DELIVERY_FAILED]: {
    title: '远端已生成但本地保存失败',
    description: '远端操作已成功返回，但下载或写入本地资产库时失败。',
    guidance: '请重试保存步骤，无需重新发起远端生成。',
    actions: [{ type: 'resume_run' }],
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
  const preset = input.errorId && Object.hasOwn(RUN_PRESENTATION_BY_ERROR_ID,input.errorId)
    ? RUN_PRESENTATION_BY_ERROR_ID[input.errorId]
    : (Object.hasOwn(RUN_PRESENTATION,input.category) ? RUN_PRESENTATION[input.category] : RUN_PRESENTATION.unknown)
  const detail = input.detail && /^HTTP [1-5][0-9]{2}(; provider code 1026; image_review_rejected)?$/.test(input.detail) ? input.detail : undefined
  const applicableActions = preset.actions.filter(
    (action) => action.type !== 'resume_run' || input.canResume,
  )
  const actions: FeedbackAction[] =
    applicableActions.length > 0 ? applicableActions : [{ type: 'resend_input' }]
  const reasonCode = Object.hasOwn(RUN_REASON_BY_CATEGORY,input.category) ? RUN_REASON_BY_CATEGORY[input.category] : RunOutcomeReasonCode.UNKNOWN_FAILED
  return {
    reasonCode,
    feedback: {
      code: input.errorId ?? reasonCode,
      severity: 'error',
      source: input.source,
      title: preset.title,
      description: preset.description ?? preset.title,
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

/** Fixed public file/HTTP diagnostics; never return exception prose. */
export function publicFileHttpFailure(error: unknown): {status:number;error:{code:string;message:string}} {
  const code=(error as {code?:unknown}|null)?.code
  if((error as {status?:unknown}|null)?.status===409) return {status:409,error:{code:'file.state_conflict',message:'操作状态已改变，请刷新确认后再决定下一步。'}}
  if(code==='ASSET_UNAVAILABLE'||code==='ENOENT') return {status:404,error:{code:'asset.unavailable',message:'文件不存在或无权访问。'}}
  if(code==='PAYLOAD_TOO_LARGE') return {status:413,error:{code:'asset.too_large',message:'文件或请求超过大小限制，请减少大小后重新提交。'}}
  if(code==='ENOSPC'||code==='EDQUOT') return {status:507,error:{code:'storage.unavailable',message:'存储空间或额度不足，请联系管理员处理后再保存；不要重新生成。'}}
  if(code==='EACCES'||code==='EPERM') return {status:403,error:{code:'file.permission_denied',message:'文件操作权限不足，请检查访问与存储权限。'}}
  return {status:400,error:{code:'file.operation_rejected',message:'文件操作未完成，请检查输入、权限与当前操作状态；不要重复提交结果未知的生成请求。'}}
}

/** Registry text only: exception prose and private details never enter channel notices. */
export function publicOutcomeText(input: { status?: string; reasonCode?: string; canResume?: boolean; retryable?: boolean; feedback?: { code?: string; tracingId?: string } }): string {
  const status = input.status, code = input.feedback?.code ?? input.reasonCode ?? ''
  const known = Object.hasOwn(RUN_PRESENTATION_BY_ERROR_ID,code) ? RUN_PRESENTATION_BY_ERROR_ID[code as ErrorIdValue] : undefined
  const category = (Object.keys(RUN_REASON_BY_CATEGORY) as ErrorCategory[]).find(key => RUN_REASON_BY_CATEGORY[key] === code)
  const preset = known ?? (category ? RUN_PRESENTATION[category] : undefined)
  let text: string
  if (status === 'cancelled') text = '本次任务已取消，不会自动继续。'
  else if (status === 'paused') text = code === RunOutcomeReasonCode.LOOP_LIMIT_REACHED ? '任务已达到循环上限并暂停，执行现场已保留。请检查后决定是否继续。' : '本次任务已暂停，尚未完成；不会自动继续。请先处理待回答问题或在工作台检查暂停原因。'
  else if (status === 'completed') text = '本次任务已完成。'
  else if (status === 'failed') text = preset ? [preset.description ?? preset.title, input.canResume ? preset.guidance : (preset.fallbackGuidance ?? preset.guidance), '本次不会自动重复执行。'].join(' ') : '本次任务未完成，原因尚未确定。请保留追踪码并联系管理员核查，不会自动重复执行。'
  else text = '收到无法识别的任务状态，结果尚未确认；请联系管理员检查版本和原任务，不会自动重复执行。'
  const trace = input.feedback?.tracingId
  return text + (trace && /^[0-9a-f]{8}$/.test(trace) ? ` 追踪码：${trace}` : '')
}
