import type { Ref } from "vue";
import type { PetInstance } from "@/features/pets/types";
import type { QuestionDraftAnswer, StreamState } from "./types";
import { agentApi } from "@/services/agentApi";
import { findQuestion, removeQuestionBatch } from "./questionBatch";

function selectQuestion(streams: Ref<Record<string, StreamState>>) {
  return (chatId: string, questionId: string): void => {
    const stream = streams.value[chatId];
    if (!stream || !findQuestion(stream, questionId)) return;
    stream.activeQuestionId = questionId;
  };
}

function updateQuestionDraft(streams: Ref<Record<string, StreamState>>) {
  return (chatId: string, questionId: string, draft?: QuestionDraftAnswer): void => {
    const found = findQuestion(streams.value[chatId], questionId);
    if (!found || found.batch.status === "submitting") return;
    if (draft) found.question.draftAnswer = draft;
    else delete found.question.draftAnswer;
  };
}

export function createQuestionActions(
  streams: Ref<Record<string, StreamState>>,
  _pets: Ref<PetInstance[]>,
  resumeAgent: (chatId: string) => Promise<void>,
) {
  const select = selectQuestion(streams);
  const updateDraft = updateQuestionDraft(streams);

  async function submitBatch(chatId: string, batchId: string): Promise<void> {
    const stream = streams.value[chatId];
    const batch = stream?.questionBatches.find((item) => item.batchId === batchId);
    if (!stream || !batch || batch.status === "submitting") return;
    if (!batch.questions.every((question) => question.localStatus === "ready" && question.draftAnswer)) return;

    batch.status = "submitting";
    try {
      const response = await agentApi.answerQuestionBatch(
        chatId,
        batchId,
        batch.questions.map((question) => ({
          questionId: question.questionId,
          selectedLabels: [...question.draftAnswer!.selectedLabels],
          ...(question.draftAnswer!.freeText ? { freeText: question.draftAnswer!.freeText } : {}),
          ...(question.draftAnswer!.cancelled ? { cancelled: true } : {}),
        })),
      );
      removeQuestionBatch(stream, batchId);
      if (response.shouldResume) await resumeAgent(chatId);
    } catch (error) {
      batch.status = "pending";
      throw error;
    }
  }

  async function advanceQuestion(
    chatId: string,
    questionId: string,
    draft: QuestionDraftAnswer,
  ): Promise<void> {
    const stream = streams.value[chatId];
    const found = findQuestion(stream, questionId);
    if (!stream || !found || found.batch.status === "submitting") return;
    found.question.draftAnswer = draft;
    found.question.localStatus = "ready";

    const next = found.batch.questions.find((question) => question.localStatus === "pending");
    if (next) {
      stream.activeQuestionId = next.questionId;
      return;
    }
    await submitBatch(chatId, found.batch.batchId);
  }

  async function cancelQuestion(chatId: string, questionId: string): Promise<void> {
    await advanceQuestion(chatId, questionId, {
      selectedLabels: [],
      cancelled: true,
    });
  }

  /**
   * 撤回当前题：current localStatus: ready → pending（draft 保留可再编辑）；
   * 然后激活同批的上一题（按 position）。批首题无上一步 → noop。
   * 整批已 ready 状态可逐次回退，无需重新走 advanceQuestion。
   */
  function backQuestion(chatId: string, questionId: string): void {
    const stream = streams.value[chatId];
    const found = findQuestion(stream, questionId);
    if (!stream || !found || found.batch.status === "submitting") return;
    const { batch, question } = found;
    const sorted = [...batch.questions].sort((a, b) => a.position - b.position);
    const currentIdx = sorted.findIndex((q) => q.questionId === questionId);
    if (currentIdx <= 0) return;
    const prev = sorted[currentIdx - 1];
    // 当前若是 ready 状态则撤回（pending 状态下只是切换焦点）
    if (question.localStatus === "ready") question.localStatus = "pending";
    stream.activeQuestionId = prev.questionId;
  }

  return {
    selectQuestion: select,
    updateQuestionDraft: updateDraft,
    advanceQuestion,
    backQuestion,
    cancelQuestion,
    submitBatch,
  };
}
