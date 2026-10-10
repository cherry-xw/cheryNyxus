/**
 * bigmodel provider 单元测试：registerBigmodelAdapter + LLM adapter chat/chatStream。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerBigmodelAdapter } from "@/agent/provider/bigmodel.js";
import { getLLMAdapter } from "@/core/llm/adapter.js";
import { getMessageAdapter } from "@/core/message/adapter.js";
import { getSenseAdapter } from "@/core/sense/adapter.js";
import { ClassifiedError } from "@/utils/error.js";
import { ErrorId, type ErrorId as ErrorIdValue } from "@chery/protocol";

async function expectBrainConfigurationError(
  promise: Promise<unknown>,
  errorId: ErrorIdValue,
  text: string,
) {
  try {
    await promise;
    throw new Error("expected provider call to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ClassifiedError);
    expect(error).toMatchObject({
      errorId,
      category: "validation",
      source: "brain",
      userMessage: expect.stringContaining(text),
    });
  }
}

describe("bigmodel provider", () => {
  beforeEach(() => {
    registerBigmodelAdapter();
  });

  it("注册 LLM adapter", () => {
    expect(getLLMAdapter("bigmodel")).toBeDefined();
  });

  it("注册 message adapter", () => {
    expect(getMessageAdapter("bigmodel")).toBeDefined();
  });

  it("注册 sense adapter", () => {
    expect(getSenseAdapter("bigmodel")).toBeDefined();
  });

  it("chat 缺 model → throw", async () => {
    const llm = getLLMAdapter("bigmodel")!;
    await expectBrainConfigurationError(
      llm.chat([], [], { url: "https://x" }),
      ErrorId.BRAIN_CONFIG_MODEL_MISSING,
      "大脑没配好",
    );
  });

  it("chatStream 缺 model → throw", async () => {
    const llm = getLLMAdapter("bigmodel")!;
    await expectBrainConfigurationError(
      llm.chatStream([], [], { url: "https://x" }),
      ErrorId.BRAIN_CONFIG_MODEL_MISSING,
      "大脑没配好",
    );
  });

  it("chat 缺 key → throw", async () => {
    const llm = getLLMAdapter("bigmodel")!;
    await expectBrainConfigurationError(
      llm.chat([], [], { model: "glm-4", url: "https://x" }),
      ErrorId.BRAIN_CONFIG_KEY_MISSING,
      "钥匙没配好",
    );
  });
});
