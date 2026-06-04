import type { Tool, ToolResult, ToolSharedData } from "./toolCreator";
import type { ZodType } from "zod";
import type { ToolGroupConfig } from "@/utils/config";
import { SupervisionLevel } from "../config";
import { getTools } from "./toolRegistry";
import { getToolAdapter, type ToolAdapter } from "./adapter";

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
   * 覆盖指定工具的监管等级（由 tool_group 配置注入）
   */
  setSupervision(toolName: string, level: import("../config").SupervisionLevel): void {
    const tool = this._toolMap.get(toolName);
    if (tool) {
      tool.supervisionLevel = level;
    }
  }

  /**
   * 批量加载工具组（封装完整的加载、去重、监管注入流程）
   * @param groupNames - 工具组名称列表
   * @param toolGroups - 工具组配置（来自 config.tool_groups）
   * @param globalSupervision - 全局监管等级（用于 fallback）
   */
  loadFromGroups(
    groupNames: string[],
    toolGroups: Record<string, ToolGroupConfig> | undefined,
    globalSupervision: SupervisionLevel,
  ): void {
    const result = new Map<string, Tool<ZodType>>();

    for (const groupName of groupNames) {
      const group = toolGroups?.[groupName];
      if (!group) {
        console.warn(`Tool group "${groupName}" not found, skipping`);
        continue;
      }

      for (const tool of getTools(group.tools)) {
        const name = tool.definition.function.name;
        const prev = result.get(name);
        if (prev) {
          console.warn(`Tool "${name}" already loaded, overriding with group "${groupName}"`);
        }
        // 优先级：组监管 > 前组已解析监管 > 工具内置监管 > 全局默认
        tool.supervisionLevel =
          group.supervision ?? prev?.supervisionLevel ?? tool.supervisionLevel ?? globalSupervision;
        result.set(name, tool);
      }
    }

    if (result.size > 0) {
      this.add([...result.values()]);
    }
  }

  /**
   * 执行工具
   * @param name - 工具名称
   * @param args - 工具参数
   * @param toolSharedData - 可选的toolSharedData参数，仅needsSession为true的工具需要
   */
  async execute(
    name: string,
    args: Record<string, unknown>,
    toolSharedData: ToolSharedData,
  ): Promise<ToolResult> {
    const tool = this._toolMap.get(name);
    if (!tool) {
      return {
        content: `Error: Tool "${name}" not found`,
        hash: "", // 错误情况不参与去重
      };
    }
    return tool.executor.execute(
      args as Parameters<typeof tool.executor.execute>[0],
      toolSharedData,
    );
  }
}
