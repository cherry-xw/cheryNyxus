import { z } from "zod";
import { sense, type SenseResult } from "@/core/sense";
import { SupervisionLevel } from "@/core/config";

/**
 * ask_user_question 感官：LLM 用此向用户提结构化问题（2-4 选项 + 可选「其他」自由文本）。
 *
 * SupervisionLevel.auto + **yield-turn 模型**（镜像 spawn_role wait=true，不阻塞 await）：
 *   handler 立即 `ctx.yieldTurn()` 请求 loop 本轮后结束（主 agent yield done 释放 WS；
 *   wait=true 子 agent yield child_yield 不唤主、不结束任务），并返回**非空占位** content。
 *
 *   占位 content 非空是关键：使 `hasPendingTrailingSense()`=false → resume 走 Case2 →
 *   `executeResumePending` 永不重跑本感官（避免重复提问/死循环）。
 *
 * 生命周期：
 *   1. checkpoint 收集同一 assistant turn 的全部 ask_user_question；
 *   2. placeholder sense 全部落库后 yield question_batch_pending → 后端持久化批次并推送批次事件；
 *   3. 本 handler `yieldTurn()` + 返回占位 → sense_accept（占位）→ loop 末 yieldTurn break；
 *   4. 用户回答 → sense.question.batchAnswer 原子更新整批 sense content（占位→答案）
 *      + set resumePending → 前端 chat.resume → LLM 见全部答案。
 *
 * 答案由 service 层 `resolveQuestionBatch` 直接写入 sense content（非 handler 返回），故本 handler
 *   不读答案、不 await，仅 yield + 占位。
 */
const Option = z.object({
  label: z.string().min(1),
  description: z.string().optional(),
});

const AskUserQuestionSchema = z.object({
  question: z.string().min(1).describe("要问用户的问题"),
  header: z.string().max(12).optional().describe("简短标题（≤12 字），UI 顶部展示"),
  options: z.array(Option).min(2).max(4).describe("2-4 个选项"),
  multiSelect: z.boolean().default(false).describe("是否多选；默认 false（单选）"),
});

export default sense(
  "ask_user_question",
  `向用户提问并等待回答。返回值为用户选择的 label（或「其他」自由文本）。`,
  AskUserQuestionSchema,
  async (_input, _shared, ctx): Promise<SenseResult> => {
    // yield-turn：请求 loop 本轮后结束，释放 turn 等待用户回答。
    // 答案由 service resolveQuestionBatch 原地写入本 sense（id = messageId）的 content，resume 后 LLM 见。
    ctx?.yieldTurn?.();
    return { content: "(等待用户回答…)" };
  },
  SupervisionLevel.auto,
);
