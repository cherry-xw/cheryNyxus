import type { ToolAdapter } from "./toolAdapter";
import type { Tool } from "../base/toolCreator";
import type { ZodType } from "zod";
import type { Message, ToolCall, Tool as OllamaTool } from "ollama";

/**
 * Ollama Tool Adapter
 * 处理 Ollama 的工具调用格式
 */
export class OllamaAdapter implements ToolAdapter {
  buildTools(tools: Tool<ZodType>[]): unknown[] {
    return tools.map((t) => ({
      type: "function",
      function: {
        name: t.definition.function.name,
        description: t.definition.function.description,
        parameters: t.definition.function.parameters,
      },
    })) as OllamaTool[];
  }

  buildToolCallMessage(content: string, toolCalls: unknown[]): unknown {
    return {
      role: "assistant",
      content,
      tool_calls: toolCalls as ToolCall[],
    } as Message;
  }

  buildToolResponseMessage(_toolCallId: string, result: string): unknown {
    return {
      role: "tool",
      content: result,
    } as Message;
  }

  parseToolCallArguments(raw: unknown): Record<string, unknown> {
    const tc = raw as ToolCall;
    return (tc.function?.arguments as Record<string, unknown>) ?? {};
  }

  getToolCallName(raw: unknown): string {
    const tc = raw as ToolCall;
    return tc.function?.name ?? "";
  }

  getToolCallId(_raw: unknown): string {
    return ""; // Ollama 不需要 tool_call_id
  }

  extractToolCalls(response: unknown): unknown[] {
    const chatResponse = response as { message?: { tool_calls?: unknown[] } };
    return (chatResponse.message?.tool_calls ?? []) as ToolCall[];
  }

  extractToolCallDeltas(chunk: unknown): unknown[] {
    const streamChunk = chunk as { message?: { tool_calls?: unknown[] } };
    return (streamChunk.message?.tool_calls ?? []) as ToolCall[];
  }

  getToolCallDeltaId(_delta: unknown): string {
    return ""; // Ollama 不需要 tool_call_id
  }

  getToolCallDeltaName(delta: unknown): string | undefined {
    const tc = delta as ToolCall;
    return tc.function?.name;
  }

  getToolCallDeltaArguments(delta: unknown): string | undefined {
    const tc = delta as ToolCall;
    // Ollama 的 arguments 是对象，需转为 JSON 字符串
    const args = tc.function?.arguments as Record<string, unknown> | undefined;
    return args ? JSON.stringify(args) : undefined;
  }
}