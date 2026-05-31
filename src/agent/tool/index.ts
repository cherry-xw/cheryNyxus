import type { ZodType } from "zod";
import type { Tool } from "@/core/tool";
import { SupervisionLevel } from "@/core/config";

// 显式导入所有工具模块
import bashTool from "./bash";
import readTool from "./read";
import writeTool from "./write";
import skillTool from "./skill";

export { tool, ToolManager } from "@/core/tool";
export type { Tool, ToolResult } from "@/core/tool";
export { SupervisionLevel } from "@/core/config";

/**
 * 工具注册表：工具名 → Tool 实例
 * 用于按名称获取工具实例
 */
const toolRegistry: Record<string, Tool<ZodType>> = {};

/**
 * 工具监管等级注册表：工具名 → SupervisionLevel
 * 用于按名称获取工具的监管等级
 */
const supervisionRegistry: Record<string, SupervisionLevel> = {};

/**
 * 注册所有工具（静态导入，无需动态扫描）
 */
function registerTools(): void {
  const tools = [bashTool, readTool, writeTool, skillTool];

  for (const tool of tools) {
    if (tool?.definition?.function?.name) {
      const toolName = tool.definition.function.name;
      toolRegistry[toolName] = tool;
      supervisionRegistry[toolName] = tool.supervisionLevel;
    }
  }
}

// 启动时立即注册
registerTools();

/**
 * 确保工具已加载完成（静态注册后立即完成）
 */
export async function ensureToolsLoaded(): Promise<void> {
  // 静态导入已完成，无需等待
}

/**
 * 获取单个工具实例
 * @param name 工具名称
 * @returns Tool 实例或 undefined
 */
export function getTool(name: string): Tool<ZodType> | undefined {
  return toolRegistry[name];
}

/**
 * 批量获取工具实例
 * @param names 工具名称列表
 * @returns Tool 实例数组（过滤掉未找到的工具）
 */
export function getTools(names: string[]): Tool<ZodType>[] {
  return names.map(name => toolRegistry[name]).filter((tool): tool is Tool<ZodType> => tool !== undefined);
}

/**
 * 获取工具监管等级
 * @param name 工具名称
 * @returns 监管等级或 undefined（未找到）
 */
export function getToolSupervision(name: string): SupervisionLevel | undefined {
  return supervisionRegistry[name];
}