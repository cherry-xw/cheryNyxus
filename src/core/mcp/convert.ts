import { z } from "zod";
import type { ZodType } from "zod";
import type { Sense, SenseFunction, SenseResult } from "@/core/sense";
import type { McpSenseContext } from "./types.js";
import { MCP_PREFIX, RESOURCE_SENSE_SUFFIX, PROMPT_SENSE_SUFFIX } from "./types.js";

/**
 * MCP 能力 → Sense 转换器。
 *
 * 设计要点：
 * - 绕过 sense() 工厂：MCP tool 自带 JSON Schema（inputSchema），反向转 zod 易丢精度；
 *   直接构造 Sense<ZodType>，definition 用 MCP 的 inputSchema，executor 调 MCP client。
 * - schema 占位：运行期 doExecuteSense 用 safeJsonParse 得 args 直传 execute，不 parse schema；
 *   参数校验由 MCP server 侧负责。
 * - hash 恒空：MCP 调用无"内容未变"语义，不参与历史去重（与 write_file 一致）。
 */

type ToolLike = {
  name: string;
  description?: string;
  inputSchema?: { type?: string; properties?: Record<string, unknown>; required?: string[] };
};
type ResourceLike = { uri: string; name?: string; description?: string };
type PromptLike = {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
};

/** 占位 schema（运行期不 parse，仅满足 SenseExecutor 结构） */
const PLACEHOLDER_SCHEMA: ZodType = z.record(z.string(), z.unknown());

/** MCP inputSchema（部分 JSON Schema）→ SenseFunction.parameters 形态 */
function normalizeParameters(
  inputSchema: ToolLike["inputSchema"],
): SenseFunction["function"]["parameters"] {
  return {
    type: "object",
    properties: (inputSchema?.properties ?? {}) as SenseFunction["function"]["parameters"]["properties"],
    required: inputSchema?.required ?? [],
    additionalProperties: false,
  };
}

/** 提取 MCP callTool 返回的 content 数组为纯文本；非 text 类型降级为占位说明 */
function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      const c = item as { type?: string; text?: string; resource?: { text?: string; uri?: string } };
      if (c.type === "text" && typeof c.text === "string") return c.text;
      if (c.type === "resource" && c.resource) {
        return c.resource.text ?? `[resource: ${c.resource.uri ?? "unknown"}]`;
      }
      return `[unsupported content type: ${c.type ?? "unknown"}]`;
    })
    .join("\n");
}

/** 单个 MCP tool → Sense（命名 mcp__<server>__<tool>） */
export function toolToSense(tool: ToolLike, ctx: McpSenseContext): Sense<ZodType> {
  const senseName = `${MCP_PREFIX}${ctx.serverName}__${tool.name}`;
  return {
    definition: {
      type: "function",
      function: {
        name: senseName,
        description: tool.description ?? `MCP tool ${tool.name} (server: ${ctx.serverName})`,
        parameters: normalizeParameters(tool.inputSchema),
      },
    },
    executor: {
      schema: PLACEHOLDER_SCHEMA,
      execute: async (input): Promise<SenseResult> => {
        try {
          const result = await ctx.client.callTool({ name: tool.name, arguments: input as Record<string, unknown> });
          const text = extractText((result as { content?: unknown }).content);
          if ((result as { isError?: boolean }).isError) {
            return { content: `MCP tool "${tool.name}" 返回错误:\n${text}`, hash: "" };
          }
          return { content: text, hash: "" };
        } catch (err) {
          return { content: `MCP call failed: ${(err as Error).message}`, hash: "" };
        }
      },
    },
    supervisionLevel: ctx.defaultSupervision,
  };
}

/** server 全部 resources → 单个 read_resource sense */
export function resourceToSense(resources: ResourceLike[], ctx: McpSenseContext): Sense<ZodType> {
  const senseName = `${MCP_PREFIX}${ctx.serverName}__${RESOURCE_SENSE_SUFFIX}`;
  const list = resources.map((r) => `- ${r.uri}${r.description ? `：${r.description}` : ""}`).join("\n");
  return {
    definition: {
      type: "function",
      function: {
        name: senseName,
        description:
          `读取 MCP server "${ctx.serverName}" 的 resource（URI 寻址，只读）。\n可用 resources:\n` +
          (list || "（server 未声明 resources）"),
        parameters: {
          type: "object",
          properties: { uri: { type: "string", description: "resource URI" } },
          required: ["uri"],
          additionalProperties: false,
        },
      },
    },
    executor: {
      schema: z.object({ uri: z.string() }),
      execute: async (input): Promise<SenseResult> => {
        const { uri } = input as { uri: string };
        try {
          const result = await ctx.client.readResource({ uri });
          const text = (result.contents as Array<{ uri: string; text?: string; blob?: string }>)
            .map((c) => c.text ?? `[binary resource: ${c.uri}]`)
            .join("\n");
          return { content: text, hash: "" };
        } catch (err) {
          return { content: `MCP readResource failed: ${(err as Error).message}`, hash: "" };
        }
      },
    },
    supervisionLevel: ctx.defaultSupervision,
  };
}

/** server 全部 prompts → 单个 get_prompt sense */
export function promptToSense(prompts: PromptLike[], ctx: McpSenseContext): Sense<ZodType> {
  const senseName = `${MCP_PREFIX}${ctx.serverName}__${PROMPT_SENSE_SUFFIX}`;
  const list = prompts.map((p) => `- ${p.name}${p.description ? `：${p.description}` : ""}`).join("\n");
  return {
    definition: {
      type: "function",
      function: {
        name: senseName,
        description:
          `获取 MCP server "${ctx.serverName}" 的 prompt 模板。\n可用 prompts:\n` +
          (list || "（server 未声明 prompts）"),
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "prompt 名称" },
            arguments: { type: "object", description: "prompt 参数（可选）" },
          },
          required: ["name"],
          additionalProperties: false,
        },
      },
    },
    executor: {
      schema: z.object({ name: z.string(), arguments: z.record(z.string(), z.string()).optional() }),
      execute: async (input): Promise<SenseResult> => {
        const { name, arguments: promptArgs } = input as {
          name: string;
          arguments?: Record<string, string>;
        };
        try {
          const result = await ctx.client.getPrompt({ name, arguments: promptArgs });
          const text = (
            result.messages as Array<{ role: string; content: { type: string; text?: string } }>
          )
            .map((m) =>
              m.content.type === "text" && m.content.text
                ? `[${m.role}] ${m.content.text}`
                : `[${m.role} ${m.content.type}]`,
            )
            .join("\n");
          return { content: text, hash: "" };
        } catch (err) {
          return { content: `MCP getPrompt failed: ${(err as Error).message}`, hash: "" };
        }
      },
    },
    supervisionLevel: ctx.defaultSupervision,
  };
}
