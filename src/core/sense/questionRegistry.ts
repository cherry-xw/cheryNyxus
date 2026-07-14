/**
 * Question Registry（ask_user_question 感官 Promise 管理）。
 *
 * 设计：镜像 approvalRegistry — core 层持有 user 答案 Promise，service 层 QuestionManager
 *   按 id 注册 / confirm / abort；sense handler 内 `await createQuestion` 阻塞直至用户回答。
 *
 * 与 approval 区别：
 *   - 答案不是二元 accept/reject，而是结构化 `{ selectedLabels, freeText?, cancelled }`。
 *   - 由 sense handler 主动 await（auto 监管等级路径，绕过 approval 流）。
 *
 * 生命周期（避免竞态）：
 *   1. middleware tool.ts buildSenseTrigger 同步调用 createQuestion 注册 Promise entry；
 *   2. trigger 流到 checkpoint.ts，yield question_pending chunk（含 question payload）；
 *   3. chunk → observer 注册 + streamMapper 推 question_requested 通知前端；
 *   4. 用户回答 → RPC sense.question.answer → questionManager.confirm → resolveQuestion；
 *   5. handler 后续 await createQuestion(id)（幂等返回同一 Promise）→ 即时返回答案。
 *
 * createQuestion 幂等：同 id 多次调用复用同一 Promise（首个调用方决定 timeoutMs）。
 */

export type QuestionAnswer = {
  /** 用户选择的选项 label 数组（单选时长度 1；多选时可多个） */
  selectedLabels: string[];
  /** 「其他」自由文本（如选择「其他」chip + 输入框） */
  freeText?: string;
  /** 用户取消或超时（统一转 cancelled，前端据此 dismiss） */
  cancelled: boolean;
};

interface PendingQuestion {
  promise: Promise<QuestionAnswer>;
  resolve: (answer: QuestionAnswer) => void;
  reject: (error: Error) => void;
  timeoutTimer?: ReturnType<typeof setTimeout>;
}

const registry = new Map<string, PendingQuestion>();

/**
 * 创建/获取问题 Promise（幂等：同 id 多次调用复用同一 Promise；首个调用方的 timeoutMs 生效）。
 * middleware tool.ts buildSenseTrigger 同步调用以在 handler await 前注册 entry，
 * 避免 handler 到达时用户已答但 entry 尚未创建的竞态。
 * @param timeoutMs 超时毫秒（来自 `global.approval_timeout`）；`undefined` 或 `<= 0` 表示不超时（永久等待）。
 *                  超时 → resolve as `{ selectedLabels: [], cancelled: true, freeText: "等待超时" }`。
 */
export function createQuestion(id: string, timeoutMs?: number): Promise<QuestionAnswer> {
  const existing = registry.get(id);
  if (existing) return existing.promise;

  let resolveFn!: (answer: QuestionAnswer) => void;
  let rejectFn!: (error: Error) => void;
  const promise = new Promise<QuestionAnswer>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });

  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs && timeoutMs > 0) {
    timeoutTimer = setTimeout(() => {
      const entry = registry.get(id);
      if (entry) {
        entry.resolve({ selectedLabels: [], cancelled: true, freeText: "等待超时" });
        registry.delete(id);
      }
    }, timeoutMs);
  }

  registry.set(id, { promise, resolve: resolveFn, reject: rejectFn, timeoutTimer });
  return promise;
}

/**
 * 确认问题答案（service QuestionManager.confirm 调用）：resolve sense handler 的 await Promise。
 */
export function resolveQuestion(id: string, answer: QuestionAnswer): void {
  const entry = registry.get(id);
  if (entry) {
    if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer);
    entry.resolve(answer);
    registry.delete(id);
  }
}

/**
 * 中止问题（service QuestionManager.abort 调用）：reject sense handler 的 await Promise，
 * 解除 await 使挂起 generator 正常结束可被 GC（断连 / chat.abort 路径）。
 */
export function rejectQuestion(id: string, error: Error): void {
  const entry = registry.get(id);
  if (entry) {
    if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer);
    entry.reject(error);
    registry.delete(id);
  }
}

/**
 * 清理所有待处理问题（应用关闭时调用）。
 * 清除所有超时定时器 + reject 所有待处理问题（视为 abort）。
 */
export function clearAllQuestions(): void {
  for (const [id, entry] of registry) {
    if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer);
    entry.reject(new Error("应用关闭，问题被中止"));
    registry.delete(id);
  }
}