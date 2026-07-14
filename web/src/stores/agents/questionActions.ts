import type { Ref } from "vue";
import type { PetInstance } from "@/features/pets/types";
import type { StreamState } from "./types";

/**
 * 立即清 pending 问题（QuestionCard submit / ✕ 后调用）。
 * 问题主线程阻塞，无 queue 并发场景；自动从 queue head pop 仅作防御性兼容。
 * 后续 question_answered notification 仍会清（已 undefined 无害）。
 */
function dismissQuestion(streams: Ref<Record<string, StreamState>>) {
  return (chatId: string): void => {
    const stream = streams.value[chatId];
    if (!stream) return;
    stream.question = undefined;
  };
}

/**
 * 把当前 question 移到 queue（用户点 ✕ 关闭问题卡片时调用）。
 * 问题与审批不同：ask_user_question 主线程阻塞 LLM，queue 中问题仍需回传答案否则 sense handler 永久挂起。
 * 默认实现：直接调 questionManager.abort（前端 RPC 不可达时由超时/断连兜底）。
 */
function dismissQuestionToQueue(_streams: Ref<Record<string, StreamState>>) {
  return (_chatId: string): void => {
    // 占位：问题无 queue 并发；仅保留 API 形状一致。QuestionCard ✕ 直接 dismissQuestion + RPC cancelled:true。
  };
}

/**
 * 从 queue 中按 questionId 找回指定问题，重新进入 question 槽（PetIcons icon 点击时调用）。
 * 当前未启用 queue（问题主线程阻塞），保留 API 一致性。
 */
function resummonQuestion(_streams: Ref<Record<string, StreamState>>) {
  return (_chatId: string, _questionId: string): void => {
    // 占位
  };
}

export function createQuestionActions(
  streams: Ref<Record<string, StreamState>>,
  _pets: Ref<PetInstance[]>,
) {
  return {
    dismissQuestion: dismissQuestion(streams),
    dismissQuestionToQueue: dismissQuestionToQueue(streams),
    resummonQuestion: resummonQuestion(streams),
  };
}