import type {
  ClientConfigBase,
  SendResult,
  ToolCallAccumulator,
} from "./types";
import { SupervisionLevel } from "./types";
import { MessageAdapter, type LLMStreamChunk } from "@/message/index";
import { ToolManager } from "@/tool/index";

/**
 * LLM Client 抽象基类
 * 使用模板方法模式，封装公共逻辑，子类实现特定API调用
 */
export abstract class BaseLLMClient<TConfig extends ClientConfigBase> {
  readonly config: TConfig;
  protected sessionId: string;
  readonly tool: ToolManager;
  readonly message: MessageAdapter;
  /** 消息历史快照（用于两阶段执行恢复） */
  protected messageSnapshot: unknown[] = [];
  /** 待确认的tool调用（用于两阶段执行恢复） */
  protected pendingToolCall:
    | {
        toolCallId: string;
        toolName: string;
        args: Record<string, unknown>;
        threadId: string;
      }
    | undefined;

  constructor(sessionId: string, config: TConfig) {
    this.sessionId = sessionId;
    this.config = config;
    this.tool = new ToolManager(config.provider);
    this.message = new MessageAdapter(sessionId, config.provider);
  }

  // ========== 特定抽象方法 ==========

  /**
   * 调用ai对话（非流式）
   */
  protected abstract chat(
    messages: unknown[],
    tools: unknown[],
    options?: Record<string, unknown>,
  ): Promise<unknown>;

  /**
   * 调用 调用ai对话（流式）
   */
  protected abstract chatStream(
    messages: unknown[],
    tools: unknown[],
    options?: Record<string, unknown>,
  ): Promise<AsyncIterable<unknown>>;

  // ========== 流式工具调用累积处理 ==========

  /**
   * 处理单个 chunk 的工具调用增量
   */
  protected _processToolCallDelta(
    chunk: unknown,
    accumulated: Map<string, ToolCallAccumulator>,
  ): void {
    const deltas = this.message.extractStreamToolCallDeltas(chunk) ?? [];
    for (const delta of deltas) {
      const id = this.tool.getToolCallDeltaId(delta);
      if (id && !accumulated.has(id)) {
        accumulated.set(id, { id, name: "", arguments: "" });
      }
      if (id) {
        const data = accumulated.get(id)!;
        const name = this.tool.getToolCallDeltaName(delta);
        if (name) data.name = name;
        const args = this.tool.getToolCallDeltaArguments(delta);
        if (args) data.arguments += args;
      }
    }
  }

  // ========== 模板方法（流程框架） ==========

  /**
   * 发送消息（两阶段执行）
   */
  async send(threadId: string, input: string): Promise<SendResult> {
    const history = this.message.accumulate(
      this.message.createUserMessage(threadId, input),
    );
    const messages = this.message.buildMessages(history);
    const tools = this.tool.getAll().length > 0 ? this.tool.buildTools() : [];
    const options = this.config.thinking ? { thinking: true } : undefined;

    let response = await this.chat(messages, tools, options);

    let toolCalls = this.message.extractToolCalls(response);
    while (toolCalls.length > 0) {
      const content = this.message.content(response);
      messages.push(this.tool.buildToolCallMessage(content, toolCalls));

      for (const tc of toolCalls) {
        const name = this.tool.getToolCallName(tc);
        const args = this.tool.parseToolCallArguments(tc);
        const id = this.tool.getToolCallId(tc);

        const toolDef = this.tool.get(name);
        const autoLevel =
          this.config.autoExecuteLevel ?? SupervisionLevel.confirm;

        if (toolDef && toolDef.supervisionLevel <= autoLevel) {
          const result = await this.tool.execute(name, args);
          messages.push(this.tool.buildToolResponseMessage(id, result));
        } else {
          this.messageSnapshot = messages.slice();
          this.pendingToolCall = {
            toolCallId: id,
            toolName: name,
            args,
            threadId,
          };

          return {
            status: "pending",
            role: "assistant",
            content: "",
            threadId,
            pendingTool: { toolCallId: id, toolName: name, args },
          };
        }
      }

      response = await this.chat(messages, tools, options);
      toolCalls = this.message.extractToolCalls(response);
    }

    const finalContent = this.message.content(response);
    const finalThinking = this.message.thinking(response);
    const llmres = this.message.wrapFinalResponse(
      threadId,
      finalContent,
      finalThinking,
      response,
    );
    this.message.accumulate(llmres);

    return {
      status: "success",
      role: "assistant",
      content: finalContent,
      ...(finalThinking && { thinking: finalThinking }),
      threadId,
      raw: response,
    };
  }

  /**
   * 确认执行待定的 tool 调用
   */
  async confirmToolCall(approved: boolean): Promise<SendResult> {
    if (!this.pendingToolCall || !this.messageSnapshot) {
      throw new Error("没有待确认的 tool 调用");
    }

    const { toolCallId, toolName, args, threadId } = this.pendingToolCall;
    const messages = this.messageSnapshot.slice() as unknown[];
    const tools = this.tool.getAll().length > 0 ? this.tool.buildTools() : [];
    const options = this.config.thinking ? { thinking: true } : undefined;

    this.pendingToolCall = undefined;
    this.messageSnapshot = [];

    if (!approved) {
      messages.push(
        this.tool.buildToolResponseMessage(toolCallId, "用户拒绝执行该操作"),
      );

      const response = await this.chat(messages, tools, options);
      const finalContent = this.message.content(response);
      const finalThinking = this.message.thinking(response);
      const llmres = this.message.wrapFinalResponse(
        threadId,
        finalContent,
        finalThinking,
        response,
      );
      this.message.accumulate(llmres);

      return {
        status: "success",
        role: "assistant",
        content: finalContent,
        ...(finalThinking && { thinking: finalThinking }),
        threadId,
        raw: response,
      };
    }

    const result = await this.tool.execute(toolName, args);
    messages.push(this.tool.buildToolResponseMessage(toolCallId, result));

    let response = await this.chat(messages, tools, options);
    let toolCalls = this.message.extractToolCalls(response);

    while (toolCalls.length > 0) {
      const content = this.message.content(response);
      messages.push(this.tool.buildToolCallMessage(content, toolCalls));

      for (const tc of toolCalls) {
        const name = this.tool.getToolCallName(tc);
        const args = this.tool.parseToolCallArguments(tc);
        const id = this.tool.getToolCallId(tc);

        const toolDef = this.tool.get(name);
        const autoLevel =
          this.config.autoExecuteLevel ?? SupervisionLevel.confirm;

        if (toolDef && toolDef.supervisionLevel <= autoLevel) {
          const result = await this.tool.execute(name, args);
          messages.push(this.tool.buildToolResponseMessage(id, result));
        } else {
          this.messageSnapshot = messages.slice();
          this.pendingToolCall = {
            toolCallId: id,
            toolName: name,
            args,
            threadId,
          };

          return {
            status: "pending",
            role: "assistant",
            content: "",
            threadId,
            pendingTool: { toolCallId: id, toolName: name, args },
          };
        }
      }

      response = await this.chat(messages, tools, options);
      toolCalls = this.message.extractToolCalls(response);
    }

    const finalContent = this.message.content(response);
    const finalThinking = this.message.thinking(response);
    const llmres = this.message.wrapFinalResponse(
      threadId,
      finalContent,
      finalThinking,
      response,
    );
    this.message.accumulate(llmres);

    return {
      status: "success",
      role: "assistant",
      content: finalContent,
      ...(finalThinking && { thinking: finalThinking }),
      threadId,
      raw: response,
    };
  }

  async *sendStream(
    threadId: string,
    input: string,
  ): AsyncGenerator<LLMStreamChunk<unknown>> {
    const history = this.message.accumulate(
      this.message.createUserMessage(threadId, input),
    );
    const messages = this.message.buildMessages(history);
    const tools = this.tool.getAll().length > 0 ? this.tool.buildTools() : [];
    const options = this.config.thinking ? { thinking: true } : undefined;

    const streamId = `stream-${Date.now()}`;
    let accumulated = "";
    let thinkingAccumulated = "";
    const toolCallsAccumulated = new Map<string, ToolCallAccumulator>();

    const stream = await this.chatStream(messages, tools, options);
    for await (const chunk of stream) {
      const delta = this.message.extractStreamDelta(chunk);
      accumulated += delta;

      const thinkingDelta = this.message.extractStreamThinking(chunk) ?? "";
      thinkingAccumulated += thinkingDelta;

      this._processToolCallDelta(chunk, toolCallsAccumulated);

      if (delta || thinkingDelta || toolCallsAccumulated.size > 0) {
        yield {
          streamId,
          thinkingDelta,
          delta,
          thinkingAccumulated,
          accumulated,
          isDone: false,
          raw: chunk,
        };
      }
    }

    if (toolCallsAccumulated.size > 0) {
      const toolCalls = Array.from(toolCallsAccumulated.values());
      messages.push(this.tool.buildToolCallMessage(accumulated, toolCalls));

      for (const tc of toolCalls) {
        const name = this.tool.getToolCallName(tc);
        const args = this.tool.parseToolCallArguments(tc);
        const id = this.tool.getToolCallId(tc);
        const result = await this.tool.execute(name, args);
        messages.push(this.tool.buildToolResponseMessage(id, result));
      }

      const continueStream = await this.chatStream(messages, tools, options);
      for await (const chunk of continueStream) {
        const delta = this.message.extractStreamDelta(chunk);
        accumulated += delta;

        const thinkingDelta = this.message.extractStreamThinking(chunk) ?? "";
        thinkingAccumulated += thinkingDelta;

        if (delta || thinkingDelta) {
          yield {
            streamId,
            thinkingDelta,
            delta,
            thinkingAccumulated,
            accumulated,
            isDone: false,
            raw: chunk,
          };
        }
      }
    }

    yield {
      streamId,
      thinkingDelta: "",
      delta: "",
      thinkingAccumulated,
      accumulated,
      isDone: true,
      raw: null,
    };

    const finalResponse = this.message.wrapFinalResponse(
      threadId,
      accumulated,
      thinkingAccumulated,
      null,
    );
    this.message.accumulate(finalResponse);
  }
}

// ========== 工厂函数导出 ==========

import createOllamaClient from "@/provider/ollama";
import createOpenAIClient from "@/provider/openai";

export default {
  ollama: createOllamaClient,
  openai: createOpenAIClient,
};

// ========== 类型导出 ==========

export * from "./types";