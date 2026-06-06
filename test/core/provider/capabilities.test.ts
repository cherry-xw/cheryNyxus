import { describe, it, expect } from "vitest";
import {
  openaiCapabilities,
  ollamaCapabilities,
  type ProviderCapabilities,
} from "@/core/provider/capabilities";

describe("capabilities", () => {
  describe("ProviderCapabilities interface", () => {
    it("openaiCapabilities should satisfy ProviderCapabilities", () => {
      const caps: ProviderCapabilities = openaiCapabilities;
      expect(caps).toBeDefined();
    });

    it("ollamaCapabilities should satisfy ProviderCapabilities", () => {
      const caps: ProviderCapabilities = ollamaCapabilities;
      expect(caps).toBeDefined();
    });
  });

  describe("openaiCapabilities", () => {
    it("should support streaming", () => {
      expect(openaiCapabilities.supportsStreaming).toBe(true);
    });

    it("should support tool calls", () => {
      expect(openaiCapabilities.supportsToolCalls).toBe(true);
    });

    it("should support reasoning", () => {
      expect(openaiCapabilities.supportsReasoning).toBe(true);
    });

    it("should support strict schema", () => {
      expect(openaiCapabilities.supportsStrictSchema).toBe(true);
    });

    it("should generate tool call IDs", () => {
      expect(openaiCapabilities.generatesToolCallIds).toBe(true);
    });

    it("should have all required properties", () => {
      expect(openaiCapabilities).toHaveProperty("supportsStreaming");
      expect(openaiCapabilities).toHaveProperty("supportsToolCalls");
      expect(openaiCapabilities).toHaveProperty("supportsReasoning");
      expect(openaiCapabilities).toHaveProperty("supportsStrictSchema");
      expect(openaiCapabilities).toHaveProperty("generatesToolCallIds");
    });
  });

  describe("ollamaCapabilities", () => {
    it("should support streaming", () => {
      expect(ollamaCapabilities.supportsStreaming).toBe(true);
    });

    it("should support tool calls", () => {
      expect(ollamaCapabilities.supportsToolCalls).toBe(true);
    });

    it("should support reasoning", () => {
      expect(ollamaCapabilities.supportsReasoning).toBe(true);
    });

    it("should not support strict schema", () => {
      expect(ollamaCapabilities.supportsStrictSchema).toBe(false);
    });

    it("should not generate tool call IDs", () => {
      expect(ollamaCapabilities.generatesToolCallIds).toBe(false);
    });

    it("should have all required properties", () => {
      expect(ollamaCapabilities).toHaveProperty("supportsStreaming");
      expect(ollamaCapabilities).toHaveProperty("supportsToolCalls");
      expect(ollamaCapabilities).toHaveProperty("supportsReasoning");
      expect(ollamaCapabilities).toHaveProperty("supportsStrictSchema");
      expect(ollamaCapabilities).toHaveProperty("generatesToolCallIds");
    });
  });

  describe("capability differences", () => {
    it("openai should support strict schema but ollama should not", () => {
      expect(openaiCapabilities.supportsStrictSchema).toBe(true);
      expect(ollamaCapabilities.supportsStrictSchema).toBe(false);
    });

    it("openai should generate tool call IDs but ollama should not", () => {
      expect(openaiCapabilities.generatesToolCallIds).toBe(true);
      expect(ollamaCapabilities.generatesToolCallIds).toBe(false);
    });

    it("both should support streaming", () => {
      expect(openaiCapabilities.supportsStreaming).toBe(true);
      expect(ollamaCapabilities.supportsStreaming).toBe(true);
    });

    it("both should support tool calls", () => {
      expect(openaiCapabilities.supportsToolCalls).toBe(true);
      expect(ollamaCapabilities.supportsToolCalls).toBe(true);
    });

    it("both should support reasoning", () => {
      expect(openaiCapabilities.supportsReasoning).toBe(true);
      expect(ollamaCapabilities.supportsReasoning).toBe(true);
    });
  });
});