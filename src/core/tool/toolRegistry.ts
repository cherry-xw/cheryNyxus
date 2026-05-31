import type { ZodType } from "zod";
import type { Tool } from "./toolCreator";
import { SupervisionLevel } from "../config";

/**
 * 工具注册表：工具名 → Tool 实例
 */
const toolRegistry: Record<string, Tool<ZodType>> = {};

/**
 * 工具监管等级注册表：工具名 → SupervisionLevel
 */
const supervisionRegistry: Record<string, SupervisionLevel> = {};

/**
 * 注册单个工具
 */
export function registerTool(tool: Tool<ZodType>): void {
  if (tool?.definition?.function?.name) {
    const toolName = tool.definition.function.name;
    toolRegistry[toolName] = tool;
    supervisionRegistry[toolName] = tool.supervisionLevel;
  }
}

/**
 * 批量注册工具
 */
export function registerTools(tools: Tool<ZodType>[]): void {
  for (const tool of tools) {
    registerTool(tool);
  }
}

/**
 * 获取单个工具实例
 */
export function getTool(name: string): Tool<ZodType> | undefined {
  return toolRegistry[name];
}

/**
 * 批量获取工具实例
 */
export function getTools(names: string[]): Tool<ZodType>[] {
  return names
    .map(name => toolRegistry[name])
    .filter((tool): tool is Tool<ZodType> => tool !== undefined);
}

/**
 * 获取工具监管等级
 */
export function getToolSupervision(name: string): SupervisionLevel | undefined {
  return supervisionRegistry[name];
}

/**
 * 获取所有已注册工具名称
 */
export function getAllToolNames(): string[] {
  return Object.keys(toolRegistry);
}