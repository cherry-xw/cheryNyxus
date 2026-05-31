import { describe, it, expect, beforeEach } from "vitest";
import { registerLLMAdapter, getLLMAdapter } from "@/core/llm/adapter";

const createMockLLMAdapter = () => ({
  chat: async () => ({
    role: "assistant",
    content: "test",
    createdAt: Date.now(),
    updateAt: Date.now(),
    raw: null,
  }),
  chatStream: async () => ({
    async *[Symbol.asyncIterator]() {
      yield { role: "assistant", content: "test", createdAt: 0, updateAt: 0, raw: null };
    },
  }),
});

describe("LLM Adapter", () => {
  beforeEach(() => {
    // Clear registries if needed
  });

  describe("registerLLMAdapter", () => {
    it("registers adapter for provider", () => {
      const adapter = createMockLLMAdapter();
      registerLLMAdapter("test-provider", adapter);

      const retrieved = getLLMAdapter("test-provider");
      expect(retrieved).toBeDefined();
    });

    it("allows multiple providers", () => {
      const adapter1 = createMockLLMAdapter();
      const adapter2 = createMockLLMAdapter();

      registerLLMAdapter("provider-a", adapter1);
      registerLLMAdapter("provider-b", adapter2);

      expect(getLLMAdapter("provider-a")).toBeDefined();
      expect(getLLMAdapter("provider-b")).toBeDefined();
    });

    it("overwrites existing adapter", () => {
      const adapter1 = createMockLLMAdapter();
      const adapter2 = createMockLLMAdapter();

      registerLLMAdapter("overwrite-test", adapter1);
      registerLLMAdapter("overwrite-test", adapter2);

      expect(getLLMAdapter("overwrite-test")).toBeDefined();
    });
  });

  describe("getLLMAdapter", () => {
    it("returns registered adapter", () => {
      const adapter = createMockLLMAdapter();
      registerLLMAdapter("get-test", adapter);

      expect(getLLMAdapter("get-test")).toBeDefined();
    });

    it("returns undefined for unregistered provider", () => {
      expect(getLLMAdapter("unknown-provider")).toBeUndefined();
    });
  });

  describe("llmAdapter interface", () => {
    it("chat returns response", async () => {
      const adapter = createMockLLMAdapter();
      const response = await adapter.chat();

      expect(response).toHaveProperty("role");
      expect(response).toHaveProperty("content");
    });

    it("chatStream returns async generator", async () => {
      const adapter = createMockLLMAdapter();
      const stream = await adapter.chatStream();

      const chunks = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }

      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0]).toHaveProperty("role");
    });
  });
});