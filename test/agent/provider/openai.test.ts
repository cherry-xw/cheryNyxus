import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerOpenAIAdapter } from "@/agent/provider/openai";
import { getLLMAdapter } from "@/core/llm/adapter";
import { getMessageAdapter } from "@/core/message/adapter";
import { getToolAdapter } from "@/core/tool/adapter";
import type { LLMResponse } from "@/core/message";
import type { Tool, ToolFunction } from "@/core/tool";
import type { ZodType } from "zod";

// Mock OpenAI SDK
vi.mock("openai", () => {
  const mockCreate = vi.fn().mockImplementation(async (options) => {
    if (options.stream) {
      return {
        async *[Symbol.asyncIterator]() {
          yield { choices: [{ delta: { content: "Hello" } }] };
          yield { choices: [{ delta: { content: " from OpenAI" } }] };
          yield {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: "tc-1", function: { name: "test_tool", arguments: '{"a":' } },
                  ],
                },
              },
            ],
          };
          yield {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, function: { arguments: '"b"}' } },
                  ],
                },
              },
            ],
          };
        },
      };
    }
    return {
      choices: [
        {
          message: {
            role: "assistant",
            content: "Hello from OpenAI",
            reasoning_content: "test reasoning",
            tool_calls: [
              { id: "tc-1", type: "function", function: { name: "test_tool", arguments: "{}" } },
            ],
          },
        },
      ],
    };
  });

  return {
    default: class MockOpenAI {
      constructor() {
        return {
          chat: {
            completions: {
              create: mockCreate,
            },
          },
        };
      }
    },
  };
});

describe("OpenAI Provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("registerOpenAIAdapter", () => {
    it("should register adapters", () => {
      registerOpenAIAdapter();

      const llmAdapter = getLLMAdapter("openai");
      const messageAdapter = getMessageAdapter("openai");
      const toolAdapter = getToolAdapter("openai");

      expect(llmAdapter).toBeDefined();
      expect(messageAdapter).toBeDefined();
      expect(toolAdapter).toBeDefined();
    });

    it("should not register twice", () => {
      registerOpenAIAdapter();
      registerOpenAIAdapter();

      // Should only register once
      expect(true).toBe(true);
    });
  });

  describe("Adapter configs", () => {
    it("should have valid message adapter config", () => {
      registerOpenAIAdapter();

      const config = getMessageAdapter("openai");
      expect(config).toBeDefined();
      expect(config?.role).toBeDefined();
      expect(config?.content).toBeDefined();
      expect(config?.buildMessages).toBeDefined();
    });

    it("should have valid tool adapter config", () => {
      registerOpenAIAdapter();

      const config = getToolAdapter("openai");
      expect(config).toBeDefined();
      expect(config?.buildTools).toBeDefined();
      expect(config?.extractToolCalls).toBeDefined();
      expect(config?.assembleToolCallChunks).toBeDefined();
    });

    it("should have valid LLM adapter", () => {
      registerOpenAIAdapter();

      const adapter = getLLMAdapter("openai");
      expect(adapter).toBeDefined();
      expect(adapter?.chat).toBeDefined();
      expect(adapter?.chatStream).toBeDefined();
    });
  });

  describe("Message adapter functions", () => {
    it("should extract content from response", () => {
      registerOpenAIAdapter();

      const config = getMessageAdapter("openai");
      const mockResponse = { choices: [{ message: { content: "test content" } }] };

      expect(config?.content(mockResponse)).toBe("test content");
    });

    it("should return empty string when no content", () => {
      registerOpenAIAdapter();

      const config = getMessageAdapter("openai");
      const mockResponse = { choices: [{ message: {} }] };

      expect(config?.content(mockResponse)).toBe("");
    });

    it("should extract reasoning_content as thinking", () => {
      registerOpenAIAdapter();

      const config = getMessageAdapter("openai");
      const mockResponse = { choices: [{ message: { reasoning_content: "test reasoning" } }] };

      expect(config?.thinking?.(mockResponse)).toBe("test reasoning");
    });

    it("should return undefined when no reasoning_content", () => {
      registerOpenAIAdapter();

      const config = getMessageAdapter("openai");
      const mockResponse = { choices: [{ message: {} }] };

      expect(config?.thinking?.(mockResponse)).toBeUndefined();
    });

    it("should extract stream delta", () => {
      registerOpenAIAdapter();

      const config = getMessageAdapter("openai");
      const mockChunk = { choices: [{ delta: { content: "test delta" } }] };

      expect(config?.extractStreamDelta(mockChunk)).toBe("test delta");
    });

    it("should return empty string when no stream delta", () => {
      registerOpenAIAdapter();

      const config = getMessageAdapter("openai");
      const mockChunk = { choices: [{ delta: {} }] };

      expect(config?.extractStreamDelta(mockChunk)).toBe("");
    });

    it("should extract stream thinking", () => {
      registerOpenAIAdapter();

      const config = getMessageAdapter("openai");
      const mockChunk = { choices: [{ delta: { reasoning_content: "stream reasoning" } }] };

      expect(config?.extractStreamThinking?.(mockChunk)).toBe("stream reasoning");
    });

    it("should return undefined when no stream thinking", () => {
      registerOpenAIAdapter();

      const config = getMessageAdapter("openai");
      const mockChunk = { choices: [{ delta: {} }] };

      expect(config?.extractStreamThinking?.(mockChunk)).toBeUndefined();
    });

    it("should build messages for tool role", () => {
      registerOpenAIAdapter();

      const config = getMessageAdapter("openai");
      const history: LLMResponse[] = [
        {
          id: "1",
          role: "tool",
          content: "tool result",
          createdAt: 0,
          updateAt: 0,
          raw: { toolCallId: "tc-1" },
        },
      ];

      const messages = config?.buildMessages(history);
      expect(messages?.length).toBe(1);
      expect((messages as { role: string; tool_call_id?: string }[])[0]?.role).toBe("tool");
      expect((messages as { role: string; tool_call_id?: string }[])[0]?.tool_call_id).toBe("tc-1");
    });

    it("should build messages for assistant with toolCalls", () => {
      registerOpenAIAdapter();

      const config = getMessageAdapter("openai");
      const history: LLMResponse[] = [
        {
          id: "1",
          role: "assistant",
          content: "",
          toolCalls: [{ tid: "tc-1", name: "test_tool", arguments: "{}" }],
          createdAt: 0,
          updateAt: 0,
          raw: null,
        },
      ];

      const messages = config?.buildMessages(history);
      expect(messages?.length).toBe(1);
      expect((messages as { role: string; tool_calls?: { id: string }[] }[])[0]?.role).toBe("assistant");
      expect((messages as { role: string; tool_calls?: { id: string }[] }[])[0]?.tool_calls).toBeDefined();
      expect((messages as { role: string; tool_calls?: { id: string }[] }[])[0]?.tool_calls?.[0]?.id).toBe("tc-1");
    });

    it("should build messages for assistant with thinking", () => {
      registerOpenAIAdapter();

      const config = getMessageAdapter("openai");
      const history: LLMResponse[] = [
        {
          id: "1",
          role: "assistant",
          content: "response",
          thinking: "reasoning",
          createdAt: 0,
          updateAt: 0,
          raw: null,
        },
      ];

      const messages = config?.buildMessages(history);
      expect(messages?.length).toBe(1);
      expect((messages as { role: string; reasoning_content?: string }[])[0]?.role).toBe("assistant");
      expect((messages as { role: string; reasoning_content?: string }[])[0]?.reasoning_content).toBe("reasoning");
    });

    it("should build messages for simple assistant", () => {
      registerOpenAIAdapter();

      const config = getMessageAdapter("openai");
      const history: LLMResponse[] = [
        {
          id: "1",
          role: "assistant",
          content: "simple response",
          createdAt: 0,
          updateAt: 0,
          raw: null,
        },
      ];

      const messages = config?.buildMessages(history);
      expect(messages?.length).toBe(1);
      expect((messages as { role: string; content: string }[])[0]?.role).toBe("assistant");
      expect((messages as { role: string; content: string }[])[0]?.content).toBe("simple response");
    });

    it("should build messages for user role", () => {
      registerOpenAIAdapter();

      const config = getMessageAdapter("openai");
      const history: LLMResponse[] = [
        {
          id: "1",
          role: "user",
          content: "user message",
          createdAt: 0,
          updateAt: 0,
          raw: null,
        },
      ];

      const messages = config?.buildMessages(history);
      expect(messages?.length).toBe(1);
      expect((messages as { role: string; content: string }[])[0]?.role).toBe("user");
      expect((messages as { role: string; content: string }[])[0]?.content).toBe("user message");
    });

    it("should return assistant role", () => {
      registerOpenAIAdapter();

      const config = getMessageAdapter("openai");
      expect(config?.role({})).toBe("assistant");
    });
  });

  describe("Tool adapter functions", () => {
    it("should build tools from definitions", () => {
      registerOpenAIAdapter();

      const config = getToolAdapter("openai");
      const tools = [
        {
          definition: {
            type: "function" as const,
            function: {
              name: "test_tool",
              description: "Test tool",
              parameters: { type: "object" },
              strict: true,
            },
          },
        },
      ] as unknown as Tool<ZodType>[];

      const builtTools = config?.buildTools(tools);
      expect(builtTools?.[0]?.type).toBe("function");
      expect(builtTools?.[0]?.function?.name).toBe("test_tool");
    });

    it("should build tool call message", () => {
      registerOpenAIAdapter();

      const config = getToolAdapter("openai");
      const toolCalls = [{ tid: "tc-1", name: "test_tool", arguments: "{}" }];

      const message = config?.buildToolCallMessage?.("content", toolCalls) as { role: string; tool_calls?: unknown };
      expect(message?.role).toBe("assistant");
      expect(message?.tool_calls).toBeDefined();
    });

    it("should build tool response message", () => {
      registerOpenAIAdapter();

      const config = getToolAdapter("openai");

      const message = config?.buildToolResponseMessage?.("tc-1", "result") as { role: string; tool_call_id?: string };
      expect(message?.role).toBe("tool");
      expect(message?.tool_call_id).toBe("tc-1");
    });

    it("should extract tool calls with id", () => {
      registerOpenAIAdapter();

      const config = getToolAdapter("openai");
      const response = {
        choices: [
          {
            message: {
              tool_calls: [
                { id: "tc-1", type: "function", function: { name: "test_tool", arguments: "{}" } },
              ],
            },
          },
        ],
      };

      const toolCalls = config?.extractToolCalls(response);
      expect(toolCalls?.[0]?.tid).toBe("tc-1");
      expect(toolCalls?.[0]?.name).toBe("test_tool");
    });

    it("should generate tool id when missing", () => {
      registerOpenAIAdapter();

      const config = getToolAdapter("openai");
      const response = {
        choices: [
          {
            message: {
              tool_calls: [
                { type: "function", function: { name: "test_tool", arguments: "{}" } },
              ],
            },
          },
        ],
      };

      const toolCalls = config?.extractToolCalls(response);
      expect(toolCalls?.[0]?.tid).toBe("tool-0");
    });

    it("should handle empty tool calls", () => {
      registerOpenAIAdapter();

      const config = getToolAdapter("openai");
      const response = {
        choices: [{ message: {} }],
      };

      const toolCalls = config?.extractToolCalls(response);
      expect(toolCalls?.length).toBe(0);
    });

    it("should assemble tool call chunks", () => {
      registerOpenAIAdapter();

      const config = getToolAdapter("openai");
      const chunks = [
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "tc-1", function: { name: "test_tool", arguments: '{"a":' } },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: '"b"}' } },
                ],
              },
            },
          ],
        },
      ];

      const assembled = config?.assembleToolCallChunks(chunks) as { choices?: Array<{ message?: { tool_calls?: Array<{ id?: string; function?: { arguments?: string } }> } }> };
      expect(assembled?.choices?.[0]?.message?.tool_calls?.[0]?.id).toBe("tc-1");
      expect(assembled?.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments).toBe('{"a":"b"}');
    });

    it("should assemble multiple tool calls by index", () => {
      registerOpenAIAdapter();

      const config = getToolAdapter("openai");
      const chunks = [
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "tc-1", function: { name: "tool1" } },
                  { index: 1, id: "tc-2", function: { name: "tool2" } },
                ],
              },
            },
          ],
        },
      ];

      const assembled = config?.assembleToolCallChunks(chunks) as { choices?: Array<{ message?: { tool_calls?: unknown[] } }> };
      expect(assembled?.choices?.[0]?.message?.tool_calls?.length).toBe(2);
    });

    it("should handle empty chunks", () => {
      registerOpenAIAdapter();

      const config = getToolAdapter("openai");
      const assembled = config?.assembleToolCallChunks([]) as { choices?: Array<{ message?: { tool_calls?: unknown[] } }> };
      expect(assembled?.choices?.[0]?.message?.tool_calls?.length).toBe(0);
    });
  });

  describe("LLM adapter functions", () => {
    it("should call chat with valid options", async () => {
      registerOpenAIAdapter();

      const adapter = getLLMAdapter("openai");
      const messages = [{ role: "user", content: "Hello" }];
      const tools: ToolFunction[] = [];
      const options = { model: "gpt-4", url: "https://api.openai.com/v1", key: "test-key" };

      const result = await adapter?.chat(messages, tools, options);
      expect(result).toBeDefined();
      expect((result as any).choices?.[0]?.message?.content).toBe("Hello from OpenAI");
    });

    it("should throw error when model missing", async () => {
      registerOpenAIAdapter();

      const adapter = getLLMAdapter("openai");
      const messages = [{ role: "user", content: "Hello" }];
      const tools: ToolFunction[] = [];
      const options = { url: "https://api.openai.com/v1" };

      await expect(adapter?.chat(messages, tools, options)).rejects.toThrow(
        "OpenAI provider requires model and url in options"
      );
    });

    it("should throw error when url missing", async () => {
      registerOpenAIAdapter();

      const adapter = getLLMAdapter("openai");
      const messages = [{ role: "user", content: "Hello" }];
      const tools: ToolFunction[] = [];
      const options = { model: "gpt-4" };

      await expect(adapter?.chat(messages, tools, options)).rejects.toThrow(
        "OpenAI provider requires model and url in options"
      );
    });

    it("should call chatStream with valid options", async () => {
      registerOpenAIAdapter();

      const adapter = getLLMAdapter("openai");
      const messages = [{ role: "user", content: "Hello" }];
      const tools: ToolFunction[] = [];
      const options = { model: "gpt-4", url: "https://api.openai.com/v1", key: "test-key" };

      const stream = await adapter?.chatStream(messages, tools, options);
      expect(stream).toBeDefined();

      const chunks: string[] = [];
      for await (const chunk of stream as AsyncIterable<any>) {
        if (chunk.choices?.[0]?.delta?.content) {
          chunks.push(chunk.choices[0].delta.content);
        }
      }

      expect(chunks.length).toBeGreaterThan(0);
    });

    it("should throw error when model missing in chatStream", async () => {
      registerOpenAIAdapter();

      const adapter = getLLMAdapter("openai");
      const messages = [{ role: "user", content: "Hello" }];
      const tools: ToolFunction[] = [];
      const options = { url: "https://api.openai.com/v1" };

      await expect(adapter?.chatStream(messages, tools, options)).rejects.toThrow(
        "OpenAI provider requires model and url in options"
      );
    });

    it("should include thinking option", async () => {
      registerOpenAIAdapter();

      const adapter = getLLMAdapter("openai");
      const messages = [{ role: "user", content: "Hello" }];
      const tools: ToolFunction[] = [];
      const options = { model: "gpt-4", url: "https://api.openai.com/v1", thinking: true };

      const result = await adapter?.chat(messages, tools, options);
      expect(result).toBeDefined();
    });

    it("should include tools in request", async () => {
      registerOpenAIAdapter();

      const adapter = getLLMAdapter("openai");
      const messages = [{ role: "user", content: "Hello" }];
      const tools = [{ type: "function" as const, function: { name: "test_tool" } }] as ToolFunction[];
      const options = { model: "gpt-4", url: "https://api.openai.com/v1" };

      const result = await adapter?.chat(messages, tools, options);
      expect(result).toBeDefined();
    });
  });
});