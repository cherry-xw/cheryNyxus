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

export interface SenseExecutor<T extends z.ZodType> {
  schema: T;
  /** execute支持可选senseSharedData参数，需共享数据的sense可声明第二个参数 */
  execute: (input: z.infer<T>, senseSharedData: SenseSharedData) => Promise<SenseResult>;
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
  handler: (input: z.infer<T>, senseSharedData: SenseSharedData) => Promise<SenseResult>,
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