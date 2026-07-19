/**
 * bigmodel provider 单元测试：registerBigmodelAdapter + LLM adapter chat/chatStream。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerBigmodelAdapter } from "@/agent/provider/bigmodel.js";
import { getLLMAdapter } from "@/core/llm/adapter.js";
import { getMessageAdapter } from "@/core/message/adapter.js";
import { getSenseAdapter } from "@/core/sense/adapter.js";

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
    await expect(llm.chat([], [], { url: "https://x" })).rejects.toThrow("大脑没配好");
  });

  it("chatStream 缺 model → throw", async () => {
    const llm = getLLMAdapter("bigmodel")!;
    await expect(llm.chatStream([], [], { url: "https://x" })).rejects.toThrow("大脑没配好");
  });

  it("chat 缺 key → throw", async () => {
    const llm = getLLMAdapter("bigmodel")!;
    await expect(llm.chat([], [], { model: "glm-4", url: "https://x" })).rejects.toThrow(
      "钥匙没配好",
    );
  });
});
