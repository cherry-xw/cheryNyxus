import type { ToolAdapter } from "./toolAdapter";
import type { Tool } from "../base/toolCreator";
import type { ZodType } from "zod";
import type { ChatCompletionTool, ChatCompletionMessageParam, ChatCompletionMessageToolCall } from "openai/resources/chat/completions";

/**
 * OpenAI Tool Adapter
 * 处理 OpenAI/LongCat 的工具调用格式
 */
export class OpenAIAdapter implements ToolAdapter {
  buildTools(tools: Tool<ZodType>[]): unknown[] {
    return tools.map((t) => ({
      type: "function",
      function: {
        name: t.definition.function.name,
        description: t.definition.function.description,
        parameters: t.definition.function.parameters,
        strict: t.definition.function.strict,
      },
    })) as ChatCompletionTool[];
  }

  buildToolCallMessage(content: string, toolCalls: unknown[]): unknown {
    return {
      role: "assistant",
      content,
      tool_calls: toolCalls as ChatCompletionMessageToolCall[],
    } as ChatCompletionMessageParam;
  }

  buildToolResponseMessage(toolCallId: string, result: string): unknown {
    return {
      role: "tool",
      tool_call_id: toolCallId,
      content: result,
    } as ChatCompletionMessageParam;
  }

  parseToolCallArguments(raw: unknown): Record<string, unknown> {
    const tc = raw as { function?: { arguments?: string } };
    const argsJson = tc.function?.arguments ?? "{}";
    return JSON.parse(argsJson) as Record<string, unknown>;
  }

  getToolCallName(raw: unknown): string {
    const tc = raw as { function?: { name?: string } };
    return tc.function?.name ?? "";
  }

  getToolCallId(raw: unknown): string {
    const tc = raw as { id?: string };
    return tc.id ?? "";
  }

  extractToolCalls(response: unknown): unknown[] {
    const completion = response as { choices?: Array<{ message?: { tool_calls?: unknown[] } }> };
    return (completion.choices?.[0]?.message?.tool_calls ?? []) as unknown[];
  }

  extractToolCallDeltas(chunk: unknown): unknown[] {
    const streamChunk = chunk as { choices?: Array<{ delta?: { tool_calls?: unknown[] } }> };
    return (streamChunk.choices?.[0]?.delta?.tool_calls ?? []) as unknown[];
  }

  getToolCallDeltaId(delta: unknown): string {
    const tc = delta as { id?: string };
    return tc.id ?? "";
  }

  getToolCallDeltaName(delta: unknown): string | undefined {
    const tc = delta as { function?: { name?: string } };
    return tc.function?.name;
  }

  getToolCallDeltaArguments(delta: unknown): string | undefined {
    const tc = delta as { function?: { arguments?: string } };
    return tc.function?.arguments;
  }
}