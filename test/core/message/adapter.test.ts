import { describe, it, expect, beforeEach } from "vitest";
import {
  registerMessageAdapter,
  getMessageAdapter,
  MessageAdapter,
  type MessageProviderAdapterConfig,
  type LLMResponse,
} from "@/core/message/adapter";

const createMockAdapterConfig = (): MessageProviderAdapterConfig => ({
  role: () => "assistant",
  content: () => "test content",
  extractStreamDelta: () => "delta",
  buildMessages: () => [],
});

describe("Message Adapter", () => {
  beforeEach(() => {
    // Clear registry - need to access internal registry
    // Since it's a const, we can't clear it directly
    // Tests should use unique provider names
  });

  describe("registerMessageAdapter", () => {
    it("registers adapter for provider", () => {
      const config = createMockAdapterConfig();
      registerMessageAdapter("test-msg-provider", config);

      const retrieved = getMessageAdapter("test-msg-provider");
      expect(retrieved).toBe(config);
    });

    it("allows multiple providers", () => {
      const config1 = createMockAdapterConfig();
      const config2 = createMockAdapterConfig();

      registerMessageAdapter("msg-provider-a", config1);
      registerMessageAdapter("msg-provider-b", config2);

      expect(getMessageAdapter("msg-provider-a")).toBe(config1);
      expect(getMessageAdapter("msg-provider-b")).toBe(config2);
    });
  });

  describe("getMessageAdapter", () => {
    it("returns registered adapter", () => {
      const config = createMockAdapterConfig();
      registerMessageAdapter("msg-test", config);

      expect(getMessageAdapter("msg-test")).toBe(config);
    });

    it("returns undefined for unregistered provider", () => {
      expect(getMessageAdapter("unknown-msg-provider")).toBeUndefined();
    });
  });

  describe("MessageAdapter class", () => {
    it("creates instance with registered provider", () => {
      const config = createMockAdapterConfig();
      registerMessageAdapter("msg-class-test", config);

      const adapter = new MessageAdapter("session-1", "msg-class-test");
      expect(adapter).toBeDefined();
      expect(adapter.getAdapter()).toBe(config);
    });

    it("throws error for unregistered provider", () => {
      expect(() => new MessageAdapter("session", "unknown-msg")).toThrow(
        "Provider \"unknown-msg\" adapter not registered"
      );
    });

    it("getAdapter returns correct config", () => {
      const config: MessageProviderAdapterConfig = {
        role: (raw) => (raw as any).role || "user",
        content: (raw) => (raw as any).content || "",
        extractStreamDelta: (chunk) => (chunk as any).delta || "",
        buildMessages: (history) => history.map((h) => ({ role: h.role, content: h.content })),
      };

      registerMessageAdapter("custom-msg", config);

      const adapter = new MessageAdapter("session", "custom-msg");
      expect(adapter.getAdapter()).toBe(config);
    });
  });

  describe("MessageProviderAdapterConfig interface", () => {
    it("role function extracts role", () => {
      const config: MessageProviderAdapterConfig = {
        role: (raw) => "assistant",
        content: () => "",
        extractStreamDelta: () => "",
        buildMessages: () => [],
      };

      registerMessageAdapter("role-test", config);

      const role = config.role({ role: "user" });
      expect(role).toBe("assistant");
    });

    it("content function extracts content", () => {
      const config: MessageProviderAdapterConfig = {
        role: () => "assistant",
        content: (raw) => (raw as any).text || "",
        extractStreamDelta: () => "",
        buildMessages: () => [],
      };

      registerMessageAdapter("content-test", config);

      const content = config.content({ text: "hello" });
      expect(content).toBe("hello");
    });

    it("extractStreamDelta extracts delta", () => {
      const config: MessageProviderAdapterConfig = {
        role: () => "assistant",
        content: () => "",
        extractStreamDelta: (chunk) => (chunk as any).delta.content,
        buildMessages: () => [],
      };

      registerMessageAdapter("delta-test", config);

      const delta = config.extractStreamDelta({ delta: { content: "test" } });
      expect(delta).toBe("test");
    });

    it("buildMessages creates messages array", () => {
      const config: MessageProviderAdapterConfig = {
        role: () => "assistant",
        content: () => "",
        extractStreamDelta: () => "",
        buildMessages: (history) =>
          history.map((h) => ({ role: h.role, content: h.content })),
      };

      registerMessageAdapter("build-test", config);

      const history: LLMResponse[] = [
        {
          id: "1",
          role: "user",
          content: "hello",
          createdAt: 0,
          updateAt: 0,
          raw: null,
        },
        {
          id: "2",
          role: "assistant",
          content: "hi",
          createdAt: 0,
          updateAt: 0,
          raw: null,
        },
      ];

      const messages = config.buildMessages(history);
      expect(messages).toHaveLength(2);
    });

    it("optional thinking function", () => {
      const config: MessageProviderAdapterConfig = {
        role: () => "assistant",
        content: () => "",
        thinking: (raw) => (raw as any).thinking,
        extractStreamDelta: () => "",
        buildMessages: () => [],
      };

      registerMessageAdapter("thinking-test", config);

      const thinking = config.thinking?.({ thinking: "thoughts" });
      expect(thinking).toBe("thoughts");
    });
  });
});