import type { Sense } from "../senseCreator.js";
import type { SenseFunction } from "../adapter.js";
import type { ZodType } from "zod";

/**
 * 构建基础感官函数定义
 * 提供共享的感官构建逻辑，Provider 可在此基础上添加特定字段
 */
export function buildBaseSenseFunction(
  sense: Sense<ZodType>,
): SenseFunction["function"] {
  return {
    name: sense.definition.function.name,
    description: sense.definition.function.description,
    parameters: sense.definition.function.parameters,
  };
}