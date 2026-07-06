import { z } from "zod";
import { Method } from "./types.js";

/**
 * RPC 请求参数 zod schema（每 method 一个）。
 *
 * P1-5：此前 router 不校验 params，handler 内 `as XxxRequestData` 强转，
 * 非法参数静默穿透到业务逻辑致运行时崩溃。集中 schema 后 router.safeParse → INVALID_PARAMS。
 * schema 与 types.ts 的 *RequestData interface 一一对应（字段/可选性同步）。
 */

const chatIdSchema = z.object({ chatId: z.string() });
const emptySchema = z.object({}).strict();

/** mcpServers 缺省 []：旧 client 不携带视为关闭所有 MCP（向后兼容） */
const mcpServersSchema = z.array(z.string()).optional();

export const requestSchemas = {
  [Method.BRAIN_LIST]: emptySchema,
  [Method.SENSE_LIST]: emptySchema,
  [Method.RUNTIME_SET]: z.object({
    chatId: z.string(),
    brain: z.string(),
    senseGroups: z.array(z.string()),
    mcpServers: mcpServersSchema,
  }),
  [Method.CHAT_CREATE]: z.object({
    chatId: z.string().optional(),
    brain: z.string(),
    senseGroups: z.array(z.string()),
    mcpServers: mcpServersSchema,
  }),
  [Method.CHAT_LIST]: emptySchema,
  [Method.CHAT_GET]: chatIdSchema,
  [Method.CHAT_DELETE]: chatIdSchema,
  [Method.CHAT_SEND]: z.object({
    chatId: z.string(),
    prompt: z.string(),
  }),
  [Method.CHAT_RESUME]: chatIdSchema,
  [Method.SENSE_APPROVAL]: z.object({
    approvalId: z.string(),
    action: z.enum(["accept", "reject"]),
    reason: z.string().optional(),
  }),
  [Method.CHAT_ABORT]: chatIdSchema,
  [Method.BASH_LIST]: chatIdSchema,
  [Method.BASH_KILL]: z.object({
    chatId: z.string(),
    pid: z.number(),
  }),
  [Method.MCP_LIST]: emptySchema,
  [Method.MCP_GET]: z.object({ name: z.string() }),
  [Method.MCP_CONNECT]: z.object({ name: z.string() }),
  [Method.MCP_DISCONNECT]: z.object({ name: z.string() }),
  [Method.MCP_RELOAD]: z.object({ name: z.string().optional() }),
} as const satisfies Record<Method, z.ZodTypeAny>;

/**
 * 按 method 取请求 schema。未知 method 返回 undefined（router 先查 handler 存在性，再校验）。
 */
export function requestSchemaFor(method: string): z.ZodTypeAny | undefined {
  return requestSchemas[method as Method];
}
