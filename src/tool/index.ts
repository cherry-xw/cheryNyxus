import type { ZodType } from "zod";
import type { Tool } from "./base/toolCreator";
import read from "./handle/read";
import skill from "./handle/skill";

export {
  tool,
} from "./base/toolCreator";
export type { Tool };
export * from "./adapter.ts";
export { ToolManager } from "./base/toolManager";

/**
 * 工具注册表：工具名 → Tool 实例
 * 用于按名称获取工具实例
 */
const toolRegistry: Record<string, Tool<ZodType>> = {
  read_file: read,
  Skill: skill,
};

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
