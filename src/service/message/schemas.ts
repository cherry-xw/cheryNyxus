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
const runtimeSelectionSchema = z.object({
  brain: z.string(),
  senseGroup: z.string().optional(),
  mcpServers: mcpServersSchema,
});

// ---------- config.save schema（结构与 ConfigRaw 一一对应，除 server 段）----------

const supervisionNameSchema = z.enum(["auto", "confirm", "manual"]);

const brainSchema = z.object({
  url: z.string().optional(),
  model: z.string(),
  key: z.string().optional(),
  thinking: z.boolean().optional(),
  provider: z.string(),
  rpm: z.number().optional(),
  mock: z.object({ enabled: z.boolean().optional(), file: z.string() }).optional(),
  contextLimit: z.number().optional(),
  capabilities: z.object({
    toolCall: z.boolean().optional(),
    input: z.object({ image: z.boolean().optional(), video: z.boolean().optional(), audio: z.boolean().optional() }).optional(),
    generate: z.object({ image: z.boolean().optional(), video: z.boolean().optional(), audio: z.boolean().optional() }).optional(),
  }).optional(),
});

const mediaServiceSchema = z.object({
  url: z.string(),
  model: z.string().optional(),
  key: z.string().optional(),
  enabled: z.boolean().optional(),
});

const mediaSchema = z.object({
  image: mediaServiceSchema.optional(),
  video: mediaServiceSchema.optional(),
  audio: mediaServiceSchema.optional(),
  maxUploadMb: z.number().positive().optional(),
}).optional();

const loggerSchema = z.object({
  level: z.enum(["debug", "info", "warn", "error", "silent"]).optional(),
  output: z.array(z.enum(["console", "file"])).optional(),
  timestamp: z.boolean().optional(),
  location: z.boolean().optional(),
  format: z.enum(["plain", "json"]).optional(),
});

const fileCompressionSchema = z.object({
  truncate_threshold: z.number().optional(),
  truncate_preview_lines: z.number().optional(),
  log_file_extensions: z.array(z.string()).optional(),
  drain_preview_count: z.number().optional(),
});

const globalSchema = z.object({
  thinking: z.boolean(),
  supervision: supervisionNameSchema,
  stream: z.boolean(),
  sense_execute_timeout: z.number().optional(),
  approval_timeout: z.number().optional(),
  maxLoopCount: z.number().optional(),
  bash_log_retention_hours: z.number().optional(),
  file_compression: fileCompressionSchema.optional(),
  logger: loggerSchema.optional(),
});

const mcpServerConfigSchema = z.object({
  transport: z.enum(["stdio", "streamable-http"]),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().optional(),
  supervision: supervisionNameSchema.optional(),
});

/** config.save 入参：除 server 外全部字段；顶层 strict 拒 server 等多余键 */
const configSaveSchema = z
  .object({
    global: globalSchema,
    llm: z.object({ brain: z.record(z.string(), brainSchema) }),
    media: mediaSchema,
    sense_groups: z.record(z.string(), z.array(z.string())).optional(),
    mcp_servers: z.record(z.string(), mcpServerConfigSchema).optional(),
    roles: z
      .record(
        z.string(),
        z.object({
          brain: z.string(),
          senseGroup: z.string(),
          mcpServers: z.array(z.string()).optional(),
          systemPrompt: z.string().optional(),
        }),
      )
      .optional(),
    presets: z
      .record(
        z.string(),
        z.object({
          leader: z.string(),
          roles: z.array(z.string()).optional(),
        }),
      )
      .optional(),
  })
  .strict();

export const requestSchemas = {
  [Method.BRAIN_LIST]: emptySchema,
  [Method.SENSE_LIST]: emptySchema,
  [Method.SENSE_TOOLS]: emptySchema,
  [Method.PROMPTS_LIST]: emptySchema,
  [Method.RUNTIME_SET]: z.object({
    chatId: z.string(),
    brain: z.string(),
    senseGroup: z.string().optional(),
    mcpServers: mcpServersSchema,
  }),
  [Method.SESSION_RUNTIME_SET]: z.object({
    chatId: z.string(),
    primary: runtimeSelectionSchema,
    roles: z.record(z.string(), runtimeSelectionSchema),
  }),
  [Method.CHAT_CREATE]: z.object({
    chatId: z.string().optional(),
    /** T6 预设：给出则从 config.presets 解析编制，忽略 brain/senseGroup */
    preset: z.string().optional(),
    brain: z.string().optional(),
    senseGroup: z.string().optional(),
    mcpServers: mcpServersSchema,
    parentChatId: z.string().optional(),
  }),
  [Method.CHAT_LIST]: z.object({
    /** CP8：true 增返 preview/turnCount（会话列表用）；省略=lean（初始化重建 pet 树用） */
    includePreview: z.boolean().optional(),
  }),
  [Method.CHAT_GET]: chatIdSchema,
  [Method.CHAT_DELETE]: chatIdSchema,
  [Method.CHAT_SEND]: z.object({
    chatId: z.string(),
    prompt: z.string(),
    /** P4：结构化附件（替代 [[media:filename]] 文本标记）。旧客户端不发该字段 → 走 marker 兼容路径。 */
    attachments: z
      .array(
        z.object({
          assetId: z.string(),
          kind: z.enum(["image", "video", "audio"]),
          mimeType: z.string(),
        }),
      )
      .optional(),
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
  [Method.CONFIG_GET]: emptySchema,
  [Method.CONFIG_SAVE]: configSaveSchema,
  // Utils 工具：provider/url 必填，key 可选（ollama 通常无需）
  [Method.UTILS_MODELS]: z.object({
    provider: z.string(),
    url: z.string(),
    key: z.string().optional(),
  }),
} as const satisfies Record<Method, z.ZodTypeAny>;

/**
 * 按 method 取请求 schema。未知 method 返回 undefined（router 先查 handler 存在性，再校验）。
 */
export function requestSchemaFor(method: string): z.ZodTypeAny | undefined {
  return requestSchemas[method as Method];
}
