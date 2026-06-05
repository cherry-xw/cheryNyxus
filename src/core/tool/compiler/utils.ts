import type { Tool } from "../toolCreator.js";
import type { ToolFunction } from "../adapter.js";
import type { ZodType } from "zod";

/**
 * 构建基础工具函数定义
 * 提供共享的工具构建逻辑，Provider 可在此基础上添加特定字段
 */
export function buildBaseToolFunction(
  tool: Tool<ZodType>,
): ToolFunction["function"] {
  return {
    name: tool.definition.function.name,
    description: tool.definition.function.description,
    parameters: tool.definition.function.parameters,
  };
}