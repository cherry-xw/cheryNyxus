import type { ZodType } from "zod";
import type { Tool } from "./toolCreator";

/**
 * 全局工具注册表：工具名 → Tool 实例
 *
 * 所有内置工具（bash/read/write/skill）和外部自定义工具在启动时注册到此表。
 * AgentBuilder 通过 tool_group 配置按名称从中取工具子集，添加到 ToolManager 实例。
 *
 * 注意：此注册表是全局共享的，不同 agent 的工具隔离由 ToolManager 实例实现，
 * 而非此注册表。tool_group 决定每个 agent 可见哪些工具。
 *
 */
const toolRegistry: Record<string, Tool<ZodType>> = {};

/**
 * 批量注册工具到全局注册表
 */
export function registerTools(tools: Tool<ZodType>[]): void {
  for (const tool of tools) {
    if (tool?.definition?.function?.name) {
      const toolName = tool.definition.function.name;
      toolRegistry[toolName] = tool;
    }
  }
}

/**
 * 按名称批量获取工具实例
 * 自动过滤未找到的工具（不抛错）
 */
export function getTools(names: string[]): Tool<ZodType>[] {
  return names
    .map(name => toolRegistry[name])
    .filter((tool): tool is Tool<ZodType> => tool !== undefined);
}
