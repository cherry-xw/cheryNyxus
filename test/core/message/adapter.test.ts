import { describe, it, expect, beforeEach } from "vitest";
import {
  registerMessageAdapter,
  getMessageAdapter,
  resetMessageProviders,
  type MessageProviderAdapterConfig,
  type LLMResponse,
} from "@/core/message/adapter";

function createConfig(): MessageProviderAdapterConfig {
  return {
    role: () => "assistant",
    content: () => "test content",
    extractStreamDelta: () => "delta",
    buildMessages: () => [],
  };
}

describe("Message Adapter", () => {
  beforeEach(() => {
    resetMessageProviders();
  });

  describe("registerMessageAdapter / getMessageAdapter", () => {
    it("registers and retrieves adapter", () => {
      const cfg = createConfig();
      registerMessageAdapter("p1", cfg);
      expect(getMessageAdapter("p1")).toBe(cfg);
    });

    it("allows multiple providers", () => {
      const a = createConfig();
      const b = createConfig();
      registerMessageAdapter("pa", a);
      registerMessageAdapter("pb", b);
      expect(getMessageAdapter("pa")).toBe(a);
      expect(getMessageAdapter("pb")).toBe(b);
    });

    it("overwrites existing adapter", () => {
      registerMessageAdapter("p", createConfig());
      const b: MessageProviderAdapterConfig = {
        ...createConfig(),
        content: () => "other",
      };
      registerMessageAdapter("p", b);
      expect(getMessageAdapter("p")).toBe(b);
    });

    it("returns undefined for unregistered provider", () => {
      expect(getMessageAdapter("nope")).toBeUndefined();
    });
  });

  describe("resetMessageProviders", () => {
    it("clears the registry", () => {
      registerMessageAdapter("p1", createConfig());
      resetMessageProviders();
      expect(getMessageAdapter("p1")).toBeUndefined();
    });
  });

  describe("MessageProviderAdapterConfig fields", () => {
    it("role extracts role", () => {
      const cfg: MessageProviderAdapterConfig = {
        role: (raw) => (raw as any).role || "user",
        content: () => "",
        extractStreamDelta: () => "",
        buildMessages: () => [],
      };
      expect(cfg.role({ role: "user" })).toBe("user");
    });

    it("content extracts content", () => {
      const cfg: MessageProviderAdapterConfig = {
        role: () => "assistant",
        content: (raw) => (raw as any).text || "",
        extractStreamDelta: () => "",
        buildMessages: () => [],
      };
      expect(cfg.content({ text: "hello" })).toBe("hello");
    });

    it("extractStreamDelta extracts delta", () => {
      const cfg: MessageProviderAdapterConfig = {
        role: () => "assistant",
        content: () => "",
        extractStreamDelta: (chunk) => (chunk as any).delta.content,
        buildMessages: () => [],
      };
      expect(cfg.extractStreamDelta({ delta: { content: "x" } })).toBe("x");
    });

    it("optional thinking extracts thinking", () => {
      const cfg: MessageProviderAdapterConfig = {
        role: () => "assistant",
        content: () => "",
        thinking: (raw) => (raw as any).thinking,
        extractStreamDelta: () => "",
        buildMessages: () => [],
      };
      expect(cfg.thinking?.({ thinking: "thoughts" })).toBe("thoughts");
    });

    it("optional extractStreamThinking extracts thinking delta", () => {
      const cfg: MessageProviderAdapterConfig = {
        role: () => "assistant",
        content: () => "",
        extractStreamDelta: () => "",
        extractStreamThinking: (chunk) => (chunk as any).thinking,
        buildMessages: () => [],
      };
      expect(cfg.extractStreamThinking?.({ thinking: "th" })).toBe("th");
    });

    it("buildMessages maps history", () => {
      const cfg: MessageProviderAdapterConfig = {
        role: () => "assistant",
        content: () => "",
        extractStreamDelta: () => "",
        buildMessages: (history) =>
          history.map((h) => ({ role: h.role, content: h.content })),
      };
      const history: LLMResponse[] = [
        { id: "1", role: "user", content: "hi", createdAt: 0, updateAt: 0 },
        { id: "2", role: "assistant", content: "yo", createdAt: 0, updateAt: 0 },
      ];
      expect(cfg.buildMessages(history)).toHaveLength(2);
    });
  });
});
