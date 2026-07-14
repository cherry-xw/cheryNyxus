import { resolveQuestion, rejectQuestion } from "@/core/sense/questionRegistry.js";
import { AgentAbortError } from "@/core/middleware/errors.js";

/**
 * 问题管理器（ask_user_question 感官专用）。
 *
 * 与 ApprovalManager 镜像：core questionRegistry 持有 Promise resolve/reject，
 * 本 manager 仅按 id 登记；confirm/abort 转调 core registry 触发 sense handler 的 await。
 *
 * 不持久化：pending question 靠 messages.content 空判断（与 approval 相同，sense message 落库前
 *   await 一直挂起；handleChatAbort 触发 rejectQuestion 把 sense 消息保持 content=NULL，
 *   下次 chat.get canResume=true 重新审核）。
 */
export class QuestionManager {
  private ids = new Set<string>();

  /** 注册待回答 id（service observer 收 question_pending 时调用） */
  register(id: string): void {
    this.ids.add(id);
  }

  /** 确认答案：转调 core registry resolve，触发 sense handler await 解除。 */
  confirm(id: string, answer: {
    selectedLabels: string[];
    freeText?: string;
    cancelled?: boolean;
  }): void {
    if (this.ids.has(id)) {
      resolveQuestion(id, {
        selectedLabels: answer.selectedLabels,
        ...(answer.freeText !== undefined ? { freeText: answer.freeText } : {}),
        cancelled: answer.cancelled ?? false,
      });
      this.ids.delete(id);
    }
  }

  /** 中止：转调 core registry reject，解除 sense handler 的 await Promise， */
  /** 使挂起 generator 正常结束可被 GC（断连 / chat.abort 路径）。 */
  abort(id: string): void {
    if (this.ids.has(id)) {
      rejectQuestion(id, new AgentAbortError());
      this.ids.delete(id);
    }
  }
}

export const questionManager = new QuestionManager();