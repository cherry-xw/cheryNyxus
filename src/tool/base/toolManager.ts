import type { Tool } from "./toolCreator";
import type { ZodType } from "zod";
import { getToolAdapter, type ToolAdapter } from "../adapter";

/**
 * 工具管理器
 * 职责：存储工具、查找工具、Tool 适配、执行工具
 */
export class ToolManager {
  private _tools: Tool<ZodType>[] = [];
  private _toolMap: Map<string, Tool<ZodType>> = new Map();
  private _adapter: ToolAdapter;

  /**
   * 构造函数
   * @param provider - provider 名称，用于从注册表获取 adapter
   */
  constructor(provider: string) {
    const adapter = getToolAdapter(provider);
    if (!adapter) {
      throw new Error(`Tool adapter for provider "${provider}" not registered`);
    }
    this._adapter = adapter;
  }

  /**
   * 获取所有工具
   */
  getAll(): Tool<ZodType>[] {
    return this._tools;
  }

  /**
   * 添加工具（单个或数组）
   */
  add(tool: Tool<ZodType> | Tool<ZodType>[]): void {
    const tools = Array.isArray(tool) ? tool : [tool];
    this._tools.push(...tools);
    for (const t of tools) {
      this._toolMap.set(t.definition.function.name, t);
    }
  }

  /**
   * 根据名称查找工具
   */
  get(name: string): Tool<ZodType> | undefined {
    return this._toolMap.get(name);
  }

  /**
   * 获取 Tool Adapter（内部使用）
   */
  private _getAdapter(): ToolAdapter {
    return this._adapter;
  }

  // ========== Tool 特定行为（委托给 adapter） ==========

  /**
   * 构建 Tool 特定的工具数组
   */
  buildTools(): unknown[] {
    const adapter = this._getAdapter();
    return adapter.buildTools(this._tools);
  }

  /**
   * 构建工具调用消息（assistant 消息）
   */
  buildToolCallMessage(content: string, toolCalls: unknown[]): unknown {
    return this._getAdapter().buildToolCallMessage(content, toolCalls);
  }

  /**
   * 构建工具响应消息（tool 消息）
   */
  buildToolResponseMessage(toolCallId: string, result: string): unknown {
    return this._getAdapter().buildToolResponseMessage(toolCallId, result);
  }

  /**
   * 解析工具调用参数
   */
  parseToolCallArguments(raw: unknown): Record<string, unknown> {
    return this._getAdapter().parseToolCallArguments(raw);
  }

  /**
   * 获取工具调用名称
   */
  getToolCallName(raw: unknown): string {
    return this._getAdapter().getToolCallName(raw);
  }

  /**
   * 获取工具调用 ID
   */
  getToolCallId(raw: unknown): string {
    return this._getAdapter().getToolCallId(raw);
  }

  /**
   * 从响应提取工具调用列表
   */
  extractToolCalls(response: unknown): unknown[] {
    return this._getAdapter().extractToolCalls(response);
  }

  /**
   * 从流式响应提取工具调用增量列表
   */
  extractToolCallDeltas(chunk: unknown): unknown[] {
    return this._getAdapter().extractToolCallDeltas(chunk);
  }

  /**
   * 获取工具调用增量的 ID
   */
  getToolCallDeltaId(delta: unknown): string {
    return this._getAdapter().getToolCallDeltaId(delta);
  }

  /**
   * 获取工具调用增量的名称
   */
  getToolCallDeltaName(delta: unknown): string | undefined {
    return this._getAdapter().getToolCallDeltaName(delta);
  }

  /**
   * 获取工具调用增量的参数片段
   */
  getToolCallDeltaArguments(delta: unknown): string | undefined {
    return this._getAdapter().getToolCallDeltaArguments(delta);
  }

  /**
   * 执行工具
   */
  async execute(name: string, args: Record<string, unknown>): Promise<string> {
    const tool = this._toolMap.get(name);
    if (!tool) {
      return `Error: Tool "${name}" not found`;
    }
    return tool.executor.execute(
      args as Parameters<typeof tool.executor.execute>[0],
    );
  }
}
