import { z } from "zod";
import { SupervisionLevel } from "../config";

/**
 * 感官执行结果
 */
export interface SenseResult {
  content: string;
  hash: string;
}

export interface SenseFunction {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: {
        [key: string]: {
          type?: string | string[];
          items?: unknown;
          description?: string;
          enum?: unknown[];
        };
      };
      required: string[];
      additionalProperties: boolean;
    };
  };
}

/** Sense间共享数据结构 */
export type SenseSharedData = Map<string, Map<string, unknown>>;

/**
 * 感官运行时上下文（P2-11：注入边界，取代 sharedData 注入 chatId 的临时方案）。
 *
 * executor 第 3 参数（optional，向后兼容 2-param handler）。当前仅 chatId；
 * workspaceRoot/config/logger/abortSignal 待产品决策后扩展（多 workspace / 热重载场景）。
 */
export interface SenseRuntimeContext {
  /** 当前 chatId（bash 等需按会话归属的 sense 读取） */
  chatId: string;
}

export interface SenseExecutor<T extends z.ZodType> {
  schema: T;
  /** execute：第 3 参数 ctx 为运行时上下文（optional，2-param handler 向后兼容） */
  execute: (input: z.infer<T>, senseSharedData: SenseSharedData, ctx?: SenseRuntimeContext) => Promise<SenseResult>;
}

export interface Sense<T extends z.ZodType> {
  definition: SenseFunction;
  executor: SenseExecutor<T>;
  /** Sense自身声明的监管等级（未声明时由外部 fallback 到 global || confirm） */
  supervisionLevel: SupervisionLevel | undefined;
}

export function sense<T extends z.ZodType>(
  name: string,
  description: string,
  schema: T,
  handler: (input: z.infer<T>, senseSharedData: SenseSharedData, ctx?: SenseRuntimeContext) => Promise<SenseResult>,
  supervisionLevel?: SupervisionLevel,
): Sense<T> {
  const jsonSchema = (schema as any).toJSONSchema();

  const definition: SenseFunction = {
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: jsonSchema.type ?? "object",
        properties: jsonSchema.properties ?? {},
        required: jsonSchema.required ?? [],
        additionalProperties: false,
      },
    },
  };

  const executor: SenseExecutor<T> = {
    schema,
    execute: handler,
  };

  return {
    definition,
    executor,
    supervisionLevel,
  };
}