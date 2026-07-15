import { describe, expect, it } from "vitest";
import { getQuestionBatch } from "../src/stores/agents/questionBatch";
import type { QuestionState } from "../src/stores/agents/types";

function question(questionId: string, batchId?: string): QuestionState {
  return {
    questionId,
    senseName: "ask_user_question",
    question: questionId,
    options: [],
    multiSelect: false,
    waitTime: 0,
    createdAt: 0,
    ...(batchId ? { batchId } : {}),
    status: "pending",
  };
}

describe("getQuestionBatch", () => {
  it("keeps all restored questions together when batchId is missing", () => {
    const questions = [question("q1"), question("q2"), question("q3")];

    expect(getQuestionBatch(questions, questions[0]!)).toEqual(questions);
  });

  it("keeps all restored questions together when one stale batchId is isolated", () => {
    const questions = [question("q1", "stale"), question("q2"), question("q3")];

    expect(getQuestionBatch(questions, questions[0]!)).toEqual(questions);
  });
});
