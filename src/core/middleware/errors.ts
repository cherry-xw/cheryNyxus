/**
 * Agent abort 领域错误：chat.abort / 审批 reject / 连接关闭中止等控制流信号。
 *
 * compose 洋葱链的 catch 会包装普通错误（`[compose] handler at index N threw: …`）以便调试，
 * 但 abort 是控制流信号而非可调试故障，且下游消费者（retry / send）需原样识别以静默退出。
 * 故 compose catch 对 AgentAbortError 豁免包装，原样上浮。
 *
 * `code` 常量双保险：防跨 realm / 原型链丢失导致 instanceof 失效；消费者优先 instanceof，code 兜底。
 */
export const AGENT_ABORT_CODE = "AGENT_ABORT";

export class AgentAbortError extends Error {
  readonly code = AGENT_ABORT_CODE;
  constructor(message = "approval aborted") {
    super(message);
    this.name = "AgentAbortError";
  }
}

/**
 * 判定是否 AgentAbortError（instanceof 为主路径，code 兜底跨 realm）。
 */
export function isAgentAbortError(error: unknown): boolean {
  return (
    error instanceof AgentAbortError ||
    (error instanceof Error &&
      (error as { code?: string }).code === AGENT_ABORT_CODE)
  );
}
