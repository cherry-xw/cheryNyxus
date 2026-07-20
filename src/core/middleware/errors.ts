/**
 * Agent abort 领域错误：chat.abort / 审批 reject / 连接关闭中止等控制流信号。
 *
 * compose 洋葱链的 catch 会包装普通错误（`[compose] handler at index N threw: …`）以便调试，
 * 但 abort 是控制流信号而非可调试故障，且下游消费者（retry / send）需原样识别以静默退出。
 * 故 compose catch 对 AgentAbortError 豁免包装，原样上浮。
 *
 * `code` 常量双保险：防跨 realm / 原型链丢失导致 instanceof 失效；消费者优先 instanceof，code 兜底。
 */
export const AGENT_ABORT_CODE = 'AGENT_ABORT'

export class AgentAbortError extends Error {
  readonly code: string = AGENT_ABORT_CODE
  constructor(message = 'approval aborted') {
    super(message)
    this.name = 'AgentAbortError'
  }
}

/**
 * 判定是否 AgentAbortError（instanceof 为主路径，code 兜底跨 realm）。
 */
export function isAgentAbortError(error: unknown): boolean {
  return (
    error instanceof AgentAbortError ||
    (error instanceof Error && (error as { code?: string }).code === AGENT_ABORT_CODE)
  )
}

/**
 * Agent park 领域错误：WS 断连导致的审批挂起信号（区别于用户主动 chat.abort 的 AgentAbortError）。
 *
 * 继承 AgentAbortError：复用「控制流信号、compose 不包装、send 层 isAgentAbortError 静默」语义，
 * 故 send/resume catch 无需改动（park 自动静默）。observer 层用 isAgentParkError 精确区分——
 * park 不 wakeParent 错误唤主（子 chat 保持 canResume Case1 待重连 chat.resume 重建 pending sense），
 * abort 唤主报错（用户主动停语义）。两者都 throw 保 pending sense content=NULL。
 */
export const AGENT_PARK_CODE = 'AGENT_PARK'

export class AgentParkError extends AgentAbortError {
  readonly code = AGENT_PARK_CODE
  constructor(message = 'approval parked (connection closed)') {
    super(message)
    this.name = 'AgentParkError'
  }
}

/**
 * 判定是否 AgentParkError（instanceof 为主路径，code 兜底跨 realm）。
 * 注意：AgentParkError 继承 AgentAbortError，故 isAgentAbortError(parkError) 也为 true；
 * observer 需先判 isAgentParkError 再判 isAgentAbortError 以区分 park/abort 分支。
 */
export function isAgentParkError(error: unknown): boolean {
  return (
    error instanceof AgentParkError ||
    (error instanceof Error && (error as { code?: string }).code === AGENT_PARK_CODE)
  )
}
