import { describe, expect, it } from "vitest";
import { rebuildPendingQuestions } from "../src/stores/agents/streamAccumulator";
import type { HistoryItem, StreamState } from "../src/stores/agents/types";

const QUESTION_PLACEHOLDER = "(等待用户回答…)";

function makeStream(): StreamState {
  return {
    thinking: "",
    content: "",
    isWorking: false,
    history: [],
    historyLoaded: false,
    historyDirty: true,
    approvalQueue: [],
    questions: [],
    runningTools: [],
  };
}

function askCall(id: string, multiSelect: boolean) {
  return {
    id,
    name: "ask_user_question",
    args: JSON.stringify({
      question: `${id} question`,
      options: [{ label: "A" }, { label: "B" }],
      multiSelect,
    }),
    result: QUESTION_PLACEHOLDER,
    status: "done" as const,
  };
}

describe("rebuildPendingQuestions", () => {
  it("restores a single-select → multi-select → single-select batch after refresh", () => {
    const stream = makeStream();
    const history: HistoryItem[] = [{
      role: "assistant",
      content: "questions",
      msgId: "assistant-turn-1",
      createdAt: 100,
      senseCalls: [
        askCall("question-1", false),
        askCall("question-2", true),
        askCall("question-3", false),
      ],
    }];

    rebuildPendingQuestions(stream, history);

    expect(stream.questions.map((q) => ({
      id: q.questionId,
      multiSelect: q.multiSelect,
      batchId: q.batchId,
    }))).toEqual([
      { id: "question-1", multiSelect: false, batchId: "assistant-turn-1" },
      { id: "question-2", multiSelect: true, batchId: "assistant-turn-1" },
      { id: "question-3", multiSelect: false, batchId: "assistant-turn-1" },
    ]);
    expect(stream.runningTools.map((tool) => tool.id)).toEqual([
      "question-1",
      "question-2",
      "question-3",
    ]);
    expect(stream.activeQuestionId).toBe("question-1");
  });

  it("repairs a sync-restored question's batch without clearing its draft", () => {
    const stream = makeStream();
    stream.questions.push({
      questionId: "question-1",
      senseName: "ask_user_question",
      question: "stale",
      options: [],
      multiSelect: false,
      waitTime: 0,
      createdAt: 1,
      status: "answered",
      draftAnswer: { selectedLabels: ["A"] },
    });
    stream.activeQuestionId = "question-1";
    const history: HistoryItem[] = [{
      role: "assistant",
      content: "questions",
      msgId: "assistant-turn-1",
      senseCalls: [askCall("question-1", true), askCall("question-2", false)],
    }];

    rebuildPendingQuestions(stream, history);

    expect(stream.questions[0]).toMatchObject({
      questionId: "question-1",
      multiSelect: true,
      batchId: "assistant-turn-1",
      status: "answered",
      draftAnswer: { selectedLabels: ["A"] },
    });
    expect(stream.activeQuestionId).toBe("question-2");
  });
});
