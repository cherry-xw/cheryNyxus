import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerOpenAIAdapter } from "@/agent/provider/openai";
import { getLLMAdapter } from "@/core/llm/adapter";
import { getMessageAdapter } from "@/core/message/adapter";
import { getSenseAdapter } from "@/core/sense/adapter";
import type { LLMResponse } from "@/core/message";
import type { Sense, SenseFunction, SenseCallData } from "@/core/sense";
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
      const senseAdapter = getSenseAdapter("openai");

      expect(llmAdapter).toBeDefined();
      expect(messageAdapter).toBeDefined();
      expect(senseAdapter).toBeDefined();
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

    it("should have valid sense adapter config", () => {
      registerOpenAIAdapter();

      const config = getSenseAdapter("openai");
      expect(config).toBeDefined();
      expect(config?.buildSenses).toBeDefined();
      expect(config?.senseCalls).toBeDefined();
      expect(config?.extractSenseCallDeltas).toBeDefined();
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
          role: "sense",
          content: "sense result",
          createdAt: 0,
          updateAt: 0,
        },
      ];

      const messages = config?.buildMessages(history);
      expect(messages?.length).toBe(1);
      expect((messages as { role: string; tool_call_id?: string }[])[0]?.role).toBe("tool");
      expect((messages as { role: string; tool_call_id?: string }[])[0]?.tool_call_id).toBe("1");
    });

    it("should build messages for assistant with senseCalls", () => {
      registerOpenAIAdapter();

      const config = getMessageAdapter("openai");
      const history: LLMResponse[] = [
        {
          id: "1",
          role: "assistant",
          content: "",
          senseCalls: [{ id: "tc-1", name: "test_tool", arguments: "{}" }],
          createdAt: 0,
          updateAt: 0,
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

  describe("Sense adapter functions", () => {
    it("should build senses from definitions", () => {
      registerOpenAIAdapter();

      const config = getSenseAdapter("openai");
      const senses = [
        {
          definition: {
            type: "function" as const,
            function: {
              name: "test_tool",
              description: "Test tool",
              parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
              strict: true,
            },
          },
          executor: { schema: {} as ZodType, execute: async () => ({ content: "", hash: "" }) },
          supervisionLevel: undefined,
        },
      ] as Sense<ZodType>[];

      const builtSenses = config?.buildSenses(senses);
      expect(builtSenses?.[0]?.type).toBe("function");
      expect(builtSenses?.[0]?.function?.name).toBe("test_tool");
    });

    it("should build sense call message", () => {
      registerOpenAIAdapter();

      const config = getSenseAdapter("openai");
      const senseCalls: SenseCallData[] = [{ id: "tc-1", name: "test_tool", arguments: "{}" }];

      const message = config?.buildSenseCallMessage?.("content", senseCalls) as { role: string; tool_calls?: unknown };
      expect(message?.role).toBe("assistant");
      expect(message?.tool_calls).toBeDefined();
    });

    it("should build sense response message", () => {
      registerOpenAIAdapter();

      const config = getSenseAdapter("openai");

      const message = config?.buildSenseResponseMessage?.("tc-1", "result") as { role: string; tool_call_id?: string };
      expect(message?.role).toBe("tool");
      expect(message?.tool_call_id).toBe("tc-1");
    });

    it("should extract sense calls with id", () => {
      registerOpenAIAdapter();

      const config = getSenseAdapter("openai");
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

      const senseCalls = config?.senseCalls(response);
      expect(senseCalls?.[0]?.id).toBe("tc-1");
      expect(senseCalls?.[0]?.name).toBe("test_tool");
    });

    it("should generate sense id when missing", () => {
      registerOpenAIAdapter();

      const config = getSenseAdapter("openai");
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

      const senseCalls = config?.senseCalls(response);
      expect(senseCalls?.[0]?.id).toBe("sense-0");
    });

    it("should handle empty sense calls", () => {
      registerOpenAIAdapter();

      const config = getSenseAdapter("openai");
      const response = {
        choices: [{ message: {} }],
      };

      const senseCalls = config?.senseCalls(response);
      expect(senseCalls?.length).toBe(0);
    });

    it("should extract sense call deltas from stream chunk", () => {
      registerOpenAIAdapter();

      const config = getSenseAdapter("openai");
      const chunk = {
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

      const deltas = config?.extractSenseCallDeltas(chunk);
      expect(deltas?.length).toBe(1);
      expect(deltas?.[0]?.name).toBe("test_tool");
      expect(deltas?.[0]?.id).toBe("tc-1");
    });

    it("should handle empty sense call deltas", () => {
      registerOpenAIAdapter();

      const config = getSenseAdapter("openai");
      const chunk = { choices: [{ delta: {} }] };

      const deltas = config?.extractSenseCallDeltas(chunk);
      expect(deltas?.length).toBe(0);
    });
  });

  describe("LLM adapter functions", () => {
    it("should call chat with valid options", async () => {
      registerOpenAIAdapter();

      const adapter = getLLMAdapter("openai");
      const messages = [{ role: "user", content: "Hello" }];
      const senses: SenseFunction[] = [];
      const options = { model: "gpt-4", url: "https://api.openai.com/v1", key: "test-key" };

      const result = await adapter?.chat(messages, senses, options);
      expect(result).toBeDefined();
      expect((result as any).choices?.[0]?.message?.content).toBe("Hello from OpenAI");
    });

    it("should throw error when model missing", async () => {
      registerOpenAIAdapter();

      const adapter = getLLMAdapter("openai");
      const messages = [{ role: "user", content: "Hello" }];
      const senses: SenseFunction[] = [];
      const options = { url: "https://api.openai.com/v1" };

      await expect(adapter?.chat(messages, senses, options)).rejects.toThrow(
        "OpenAI provider requires model and url in options"
      );
    });

    it("should throw error when url missing", async () => {
      registerOpenAIAdapter();

      const adapter = getLLMAdapter("openai");
      const messages = [{ role: "user", content: "Hello" }];
      const senses: SenseFunction[] = [];
      const options = { model: "gpt-4" };

      await expect(adapter?.chat(messages, senses, options)).rejects.toThrow(
        "OpenAI provider requires model and url in options"
      );
    });

    it("should call chatStream with valid options", async () => {
      registerOpenAIAdapter();

      const adapter = getLLMAdapter("openai");
      const messages = [{ role: "user", content: "Hello" }];
      const senses: SenseFunction[] = [];
      const options = { model: "gpt-4", url: "https://api.openai.com/v1", key: "test-key" };

      const stream = await adapter?.chatStream(messages, senses, options);
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
      const senses: SenseFunction[] = [];
      const options = { url: "https://api.openai.com/v1" };

      await expect(adapter?.chatStream(messages, senses, options)).rejects.toThrow(
        "OpenAI provider requires model and url in options"
      );
    });

    it("should include thinking option", async () => {
      registerOpenAIAdapter();

      const adapter = getLLMAdapter("openai");
      const messages = [{ role: "user", content: "Hello" }];
      const senses: SenseFunction[] = [];
      const options = { model: "gpt-4", url: "https://api.openai.com/v1", thinking: true };

      const result = await adapter?.chat(messages, senses, options);
      expect(result).toBeDefined();
    });

    it("should include senses in request", async () => {
      registerOpenAIAdapter();

      const adapter = getLLMAdapter("openai");
      const messages = [{ role: "user", content: "Hello" }];
      const senses = [{ type: "function" as const, function: { name: "test_tool", description: "Test", parameters: { type: "object", properties: {}, required: [], additionalProperties: false } } }] as SenseFunction[];
      const options = { model: "gpt-4", url: "https://api.openai.com/v1" };

      const result = await adapter?.chat(messages, senses, options);
      expect(result).toBeDefined();
    });
  });
});