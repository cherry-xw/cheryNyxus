import { z } from "zod";
import { SupervisionLevel } from "../config";

/**
 * 工具执行结果
 */
export interface ToolResult {
  content: string;
  hash: string;
}

export interface ToolFunction {
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
    /** 严格模式（可选，部分 provider 不支持） */
    strict?: boolean;
  };
}

/** Tool间共享数据结构 */
export type ToolSharedData = Map<string, Map<string, unknown>>;

export interface ToolExecutor<T extends z.ZodType> {
  schema: T;
  /** execute支持可选toolSharedData参数，需共享数据的tool可声明第二个参数 */
  execute: (input: z.infer<T>, toolSharedData: ToolSharedData) => Promise<ToolResult>;
}

export interface Tool<T extends z.ZodType> {
  definition: ToolFunction;
  executor: ToolExecutor<T>;
  /** Tool监管等级（默认confirm） */
  supervisionLevel: SupervisionLevel;
}

export function tool<T extends z.ZodType>(
  name: string,
  description: string,
  schema: T,
  handler: (input: z.infer<T>, toolSharedData: ToolSharedData) => Promise<ToolResult>,
  supervisionLevel: SupervisionLevel = SupervisionLevel.confirm,
): Tool<T> {
  const jsonSchema = (schema as any).toJSONSchema();

  const definition: ToolFunction = {
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
      strict: true,
    },
  };

  const executor: ToolExecutor<T> = {
    schema,
    execute: handler,
  };

  return {
    definition,
    executor,
    supervisionLevel,
  };
}
