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
  private _adapter: ToolAdapter<any, any>;

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
    for (const tool of tools) {
      this._toolMap.set(tool.definition.function.name, tool);
    }
  }

  /**
   * 根据名称查找工具
   */
  get(name: string): Tool<ZodType> | undefined {
    return this._toolMap.get(name);
  }

  /**
   * 获取底层 Tool Adapter
   */
  getAdapter(): ToolAdapter<any, any> {
    return this._adapter;
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
