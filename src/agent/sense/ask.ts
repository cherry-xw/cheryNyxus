import { z } from "zod";
import { sense, type SenseResult } from "@/core/sense";
import { SupervisionLevel } from "@/core/config";
import { createQuestion } from "@/core/sense/questionRegistry.js";

/**
 * ask_user_question 感官：LLM 用此向用户提结构化问题（2-4 选项 + 可选「其他」自由文本）。
 *
 * SupervisionLevel.auto：handler 内部 await createQuestion 阻塞直至用户回答；
 *   不走 approval 二元 accept/reject 流。
 *
 * 生命周期：tool.ts buildSenseTrigger 同步创建 registry entry → checkpoint.ts yield
 *   question_pending chunk → 前端收到 question_requested → 用户回答 → RPC → resolveQuestion
 *   → 本 handler await 解除 → 返回 content。createQuestion 幂等复用同一 Promise。
 *
 * 答案格式：`{ selectedLabels: string[], freeText?: string, cancelled: boolean }`。
 *   - 单选：selectedLabels.length === 1
 *   - 多选：selectedLabels.length >= 1
 *   - 「其他」+ 自由文本：selectedLabels 留空（前端在 chip「其他」触发模态对话框时设定）
 *   - 用户取消 / 超时：cancelled: true
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
  async (input, _shared, ctx): Promise<SenseResult> => {
    // id 用 sense call id（= 主 chat sense message.id），供前端 dismissQuestion + resume 续接关联。
    // buildSenseTrigger 已同步调用 createQuestion(id, timeout) 注册 entry（避免 handler await 时 entry 未建的竞态）；
    // 本 handler 幂等返回同一 Promise 并 await。
    const id = ctx?.messageId ?? crypto.randomUUID();
    const ans = await createQuestion(id);
    if (ans.cancelled) return { content: "(用户取消了此问题)" };
    const labels = ans.selectedLabels;
    const text = ans.freeText ? `其他: ${ans.freeText}` : labels.join(", ");
    return { content: `用户回答: ${text}` };
  },
  SupervisionLevel.auto,
);