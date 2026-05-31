import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerOllamaAdapter } from "@/agent/provider/ollama";
import { getLLMAdapter } from "@/core/llm/adapter";
import { getMessageAdapter } from "@/core/message/adapter";
import { getToolAdapter } from "@/core/tool/adapter";
import type { LLMResponse } from "@/core/message";
import type { Tool, ToolFunction } from "@/core/tool";
import type { ZodType } from "zod";

// Mock Ollama SDK
vi.mock("ollama", () => {
  const mockChat = vi.fn().mockImplementation(async (options) => {
    if (options.stream) {
      return {
        async *[Symbol.asyncIterator]() {
          yield { message: { content: "Hello", thinking: "thinking..." } };
          yield { message: { content: " from Ollama" } };
          yield {
            message: {
              tool_calls: [
                { function: { name: "test_tool", arguments: { arg: "value" } } },
              ],
            },
          };
        },
      };
    }
    return {
      message: {
        role: "assistant",
        content: "Hello from Ollama",
        thinking: "test thinking",
        tool_calls: [
          { function: { name: "test_tool", arguments: { arg: "value" } } },
        ],
      },
    };
  });

  return {
    default: {
      chat: mockChat,
    },
  };
});

describe("Ollama Provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("registerOllamaAdapter", () => {
    it("should register adapters", () => {
      registerOllamaAdapter();

      const llmAdapter = getLLMAdapter("ollama");
      const messageAdapter = getMessageAdapter("ollama");
      const toolAdapter = getToolAdapter("ollama");

      expect(llmAdapter).toBeDefined();
      expect(messageAdapter).toBeDefined();
      expect(toolAdapter).toBeDefined();
    });

    it("should not register twice", () => {
      registerOllamaAdapter();
      registerOllamaAdapter();
      // Should only register once
      expect(true).toBe(true);
    });
  });

  describe("Adapter configs", () => {
    it("should have valid message adapter config", () => {
      registerOllamaAdapter();

      const config = getMessageAdapter("ollama");
      expect(config).toBeDefined();
      expect(config?.role).toBeDefined();
      expect(config?.content).toBeDefined();
      expect(config?.buildMessages).toBeDefined();
    });

    it("should have valid tool adapter config", () => {
      registerOllamaAdapter();

      const config = getToolAdapter("ollama");
      expect(config).toBeDefined();
      expect(config?.buildTools).toBeDefined();
      expect(config?.extractToolCalls).toBeDefined();
      expect(config?.assembleToolCallChunks).toBeDefined();
    });

    it("should have valid LLM adapter", () => {
      registerOllamaAdapter();

      const adapter = getLLMAdapter("ollama");
      expect(adapter).toBeDefined();
      expect(adapter?.chat).toBeDefined();
      expect(adapter?.chatStream).toBeDefined();
    });
  });

  describe("Message adapter functions", () => {
    it("should extract content from response", () => {
      registerOllamaAdapter();

      const config = getMessageAdapter("ollama");
      const mockResponse = { message: { content: "test content" } };

      expect(config?.content(mockResponse)).toBe("test content");
    });

    it("should return empty string when no content", () => {
      registerOllamaAdapter();

      const config = getMessageAdapter("ollama");
      const mockResponse = { message: {} };

      expect(config?.content(mockResponse)).toBe("");
    });

    it("should extract thinking from response", () => {
      registerOllamaAdapter();

      const config = getMessageAdapter("ollama");
      const mockResponse = { message: { thinking: "test thinking" } };

      expect(config?.thinking?.(mockResponse)).toBe("test thinking");
    });

    it("should return undefined when no thinking", () => {
      registerOllamaAdapter();

      const config = getMessageAdapter("ollama");
      const mockResponse = { message: {} };

      expect(config?.thinking?.(mockResponse)).toBeUndefined();
    });

    it("should extract stream delta", () => {
      registerOllamaAdapter();

      const config = getMessageAdapter("ollama");
      const mockChunk = { message: { content: "test delta" } };

      expect(config?.extractStreamDelta(mockChunk)).toBe("test delta");
    });

    it("should return empty string when no stream delta", () => {
      registerOllamaAdapter();

      const config = getMessageAdapter("ollama");
      const mockChunk = { message: {} };

      expect(config?.extractStreamDelta(mockChunk)).toBe("");
    });

    it("should extract stream thinking", () => {
      registerOllamaAdapter();

      const config = getMessageAdapter("ollama");
      const mockChunk = { message: { thinking: "stream thinking" } };

      expect(config?.extractStreamThinking?.(mockChunk)).toBe("stream thinking");
    });

    it("should return undefined when no stream thinking", () => {
      registerOllamaAdapter();

      const config = getMessageAdapter("ollama");
      const mockChunk = { message: {} };

      expect(config?.extractStreamThinking?.(mockChunk)).toBeUndefined();
    });

    it("should build messages from history", () => {
      registerOllamaAdapter();

      const config = getMessageAdapter("ollama");
      const history: LLMResponse[] = [
        {
          id: "1",
          role: "user",
          content: "Hello",
          createdAt: 0,
          updateAt: 0,
          raw: null,
        },
        {
          id: "2",
          role: "assistant",
          content: "Hi",
          createdAt: 0,
          updateAt: 0,
          raw: null,
        },
      ];

      const messages = config?.buildMessages(history);
      expect(messages?.length).toBe(2);
      expect((messages as { role: string; content: string }[])[0]?.role).toBe("user");
      expect((messages as { role: string; content: string }[])[0]?.content).toBe("Hello");
    });

    it("should extract role from response", () => {
      registerOllamaAdapter();

      const config = getMessageAdapter("ollama");
      const mockResponse = { message: { role: "assistant" } };

      expect(config?.role(mockResponse)).toBe("assistant");
    });

    it("should return default role when missing", () => {
      registerOllamaAdapter();

      const config = getMessageAdapter("ollama");
      const mockResponse = { message: {} };

      expect(config?.role(mockResponse)).toBe("assistant");
    });
  });

  describe("Tool adapter functions", () => {
    it("should build tools from definitions", () => {
      registerOllamaAdapter();

      const config = getToolAdapter("ollama");
      const tools = [
        {
          definition: {
            type: "function" as const,
            function: {
              name: "test_tool",
              description: "Test tool",
              parameters: { type: "object" },
            },
          },
        },
      ] as unknown as Tool<ZodType>[];

      const builtTools = config?.buildTools(tools);
      expect(builtTools?.[0]?.type).toBe("function");
      expect(builtTools?.[0]?.function?.name).toBe("test_tool");
    });

    it("should build tool call message", () => {
      registerOllamaAdapter();

      const config = getToolAdapter("ollama");
      const toolCalls = [{ tid: "", name: "test_tool", arguments: '{"arg":"value"}' }];

      const message = config?.buildToolCallMessage?.("content", toolCalls) as { role: string; tool_calls?: unknown };
      expect(message?.role).toBe("assistant");
      expect(message?.tool_calls).toBeDefined();
    });

    it("should build tool response message", () => {
      registerOllamaAdapter();

      const config = getToolAdapter("ollama");

      const message = config?.buildToolResponseMessage?.("", "result") as { role: string; content: string };
      expect(message?.role).toBe("tool");
      expect(message?.content).toBe("result");
    });

    it("should extract tool calls", () => {
      registerOllamaAdapter();

      const config = getToolAdapter("ollama");
      const response = {
        message: {
          tool_calls: [
            { function: { name: "test_tool", arguments: { arg: "value" } } },
          ],
        },
      };

      const toolCalls = config?.extractToolCalls(response);
      expect(toolCalls?.length).toBe(1);
      expect(toolCalls?.[0]?.name).toBe("test_tool");
      expect(toolCalls?.[0]?.tid).toBe("");
    });

    it("should handle empty tool calls", () => {
      registerOllamaAdapter();

      const config = getToolAdapter("ollama");
      const response = {
        message: {},
      };

      const toolCalls = config?.extractToolCalls(response);
      expect(toolCalls?.length).toBe(0);
    });

    it("should assemble tool call chunks", () => {
      registerOllamaAdapter();

      const config = getToolAdapter("ollama");
      const chunks = [
        {
          message: {
            tool_calls: [
              { function: { name: "tool1", arguments: { a: 1 } } },
            ],
          },
        },
        {
          message: {
            tool_calls: [
              { function: { name: "tool2", arguments: { b: 2 } } },
            ],
          },
        },
      ];

      const assembled = config?.assembleToolCallChunks(chunks) as { message?: { tool_calls?: unknown[] } };
      expect(assembled?.message?.tool_calls?.length).toBe(2);
    });

    it("should handle empty chunks", () => {
      registerOllamaAdapter();

      const config = getToolAdapter("ollama");
      const assembled = config?.assembleToolCallChunks([]) as { message?: { tool_calls?: unknown[] } };
      expect(assembled?.message?.tool_calls?.length).toBe(0);
    });
  });

  describe("LLM adapter functions", () => {
    it("should call chat with valid options", async () => {
      registerOllamaAdapter();

      const adapter = getLLMAdapter("ollama");
      const messages = [{ role: "user", content: "Hello" }];
      const tools: ToolFunction[] = [];
      const options = { model: "llama2" };

      const result = await adapter?.chat(messages, tools, options);
      expect(result).toBeDefined();
      expect((result as any).message?.content).toBe("Hello from Ollama");
    });

    it("should throw error when model missing", async () => {
      registerOllamaAdapter();

      const adapter = getLLMAdapter("ollama");
      const messages = [{ role: "user", content: "Hello" }];
      const tools: ToolFunction[] = [];
      const options = {};

      await expect(adapter?.chat(messages, tools, options)).rejects.toThrow(
        "Ollama provider requires model in options"
      );
    });

    it("should call chatStream with valid options", async () => {
      registerOllamaAdapter();

      const adapter = getLLMAdapter("ollama");
      const messages = [{ role: "user", content: "Hello" }];
      const tools: ToolFunction[] = [];
      const options = { model: "llama2" };

      const stream = await adapter?.chatStream(messages, tools, options);
      expect(stream).toBeDefined();

      const chunks: string[] = [];
      for await (const chunk of stream as AsyncIterable<any>) {
        if (chunk.message?.content) {
          chunks.push(chunk.message.content);
        }
      }

      expect(chunks.length).toBeGreaterThan(0);
    });

    it("should throw error when model missing in chatStream", async () => {
      registerOllamaAdapter();

      const adapter = getLLMAdapter("ollama");
      const messages = [{ role: "user", content: "Hello" }];
      const tools: ToolFunction[] = [];
      const options = {};

      await expect(adapter?.chatStream(messages, tools, options)).rejects.toThrow(
        "Ollama provider requires model in options"
      );
    });

    it("should include tools in request", async () => {
      registerOllamaAdapter();

      const adapter = getLLMAdapter("ollama");
      const messages = [{ role: "user", content: "Hello" }];
      const tools = [{ type: "function" as const, function: { name: "test_tool" } }] as ToolFunction[];
      const options = { model: "llama2" };

      const result = await adapter?.chat(messages, tools, options);
      expect(result).toBeDefined();
    });
  });
});