import { z } from 'zod'
import { Method, type Method as MethodName, type ParamsOf } from './types.js'
import {
  ChatInputSubmitRequestSchema,
  ChatCloseRequestSchema,
  ChatOpenRequestSchema,
  ChatRunResumeRequestSchema,
} from '@chery/protocol'
import { InternalCommand } from './internalCommand.js'

/**
 * RPC 请求参数 zod schema（每 method 一个）。
 *
 * P1-5：此前 router 不校验 params，handler 内 `as XxxRequestData` 强转，
 * 非法参数静默穿透到业务逻辑致运行时崩溃。集中 schema 后 router.safeParse → INVALID_PARAMS。
 * schema 与 types.ts 的 *RequestData interface 一一对应（字段/可选性同步）。
 */

const nonEmptyString = z.string().min(1)
const chatIdSchema = z.object({ chatId: nonEmptyString })
// 注意：本文件仅定义「请求参数」zod schema（router.safeParse 校验 params，见 requestSchemas）。
// 响应数据结构一律在 types.ts 定义（*ResponseData / ChatSummary），不在此处。
const emptySchema = z.object({}).strict()

/** mcpServers 缺省 []：旧 client 不携带视为关闭所有 MCP（向后兼容） */
const mcpServersSchema = z.array(nonEmptyString).optional()
const runtimeSelectionSchema = z.object({
  brain: nonEmptyString,
  senseGroup: z.string().optional(),
  mcpServers: mcpServersSchema,
  /** 消息级溯源快照（messages.runtime / content_end.runtime）：消息发送时 brain 的 model/provider */
  brainModel: z.string().optional(),
  brainProvider: z.string().optional(),
})

// ---------- config.save schema（结构与 ConfigRaw 一一对应，除 server 段）----------

const supervisionNameSchema = z.enum(['auto', 'smart', 'manual'])
const permissionEffectSchema = z.enum(['inherit', 'allow', 'ask', 'deny'])
const rolePermissionSchema = z.object({
  template: z.enum(['read-only', 'workspace-developer', 'supervised', 'trusted']),
  tools: z.record(z.string(), permissionEffectSchema).optional(),
  filesystem: z
    .object({
      read: z.enum(['deny', 'workspace', 'any']).optional(),
      write: z.enum(['deny', 'workspace', 'any-with-approval']).optional(),
    })
    .optional(),
  commands: z
    .object({
      shells: z.array(z.enum(['bash', 'powershell'])).optional(),
      maxSandboxMode: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
      categories: z.record(z.string(), permissionEffectSchema).optional(),
    })
    .optional(),
  mcp: z
    .object({
      default: permissionEffectSchema.optional(),
      tools: z.record(z.string(), permissionEffectSchema).optional(),
    })
    .optional(),
  spawn: z
    .object({
      allowedRoles: z.array(z.string()).optional(),
      effect: permissionEffectSchema.optional(),
    })
    .optional(),
})

const brainSchema = z.object({
  url: z.string().optional(),
  model: z.string(),
  key: z.string().optional(),
  /** thinking 显示词（任意非空字符串，由 model-thinking.yaml 翻译成请求参数）；兼容 legacy boolean，由 normalizeBrainThinking 归一。对齐 BrainConfig.thinking */
  thinking: z.union([z.string().min(1), z.boolean()]).optional(),
  provider: z.string(),
  rpm: z.number().optional(),
  mock: z.object({ enabled: z.boolean().optional(), file: z.string() }).optional(),
  contextLimit: z.number().optional(),
  capabilities: z
    .object({
      toolCall: z.boolean().optional(),
      input: z
        .object({
          image: z.boolean().optional(),
          video: z.boolean().optional(),
          audio: z.boolean().optional(),
        })
        .optional(),
      generate: z
        .object({
          image: z.boolean().optional(),
          video: z.boolean().optional(),
          audio: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
})

const mediaServiceSchema = z.object({
  type: z.enum(['image', 'video', 'audio']),
  url: z.string(),
  model: z.string().optional(),
  key: z.string().optional(),
  enabled: z.boolean().optional(),
  maxUploadMb: z.number().positive().optional(),
})

/** media：命名实体集合（name → 配置），非旧 3-slot 结构。 */
const mediaSchema = z.record(z.string(), mediaServiceSchema).optional()

/** 项目记忆双层配置（global 跨 chat 共享 · workspace per chat）；字段均 optional。沿用 utils/config.ts MemoryLimits/MemoryConfig 形状 */
const memoryLimitsSchema = z
  .object({
    max_count: z.number().min(1).optional(),
    max_chars: z.number().min(1).optional(),
  })
  .optional()

const memorySchema = z
  .object({
    global: memoryLimitsSchema,
    workspace: memoryLimitsSchema,
  })
  .optional()

const loggerSchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error', 'silent']).optional(),
  output: z.array(z.enum(['console', 'file'])).optional(),
  timestamp: z.boolean().optional(),
  location: z.boolean().optional(),
  format: z.enum(['plain', 'json']).optional(),
})

const fileCompressionSchema = z.object({
  truncate_threshold: z.number().optional(),
  truncate_preview_lines: z.number().optional(),
  log_file_extensions: z.array(z.string()).optional(),
  drain_preview_count: z.number().optional(),
})

/** Threshold{unit,value}：percent value ∈ [0,1]、tokens value ≥ 0（对齐 utils/config.ts Threshold） */
const thresholdSchema = z.discriminatedUnion('unit', [
  z.object({ unit: z.literal('tokens'), value: z.number().nonnegative() }),
  z.object({ unit: z.literal('percent'), value: z.number().min(0).max(1) }),
])

/** command 配置（compact 阈值等）；对齐 utils/config.ts CommandConfig */
const commandConfigSchema = z.object({
  warn: thresholdSchema.optional(),
  auto: thresholdSchema.optional(),
  min_context_limit: z.number().optional(),
  safety_margin: z.number().optional(),
})

const globalSchema = z.object({
  thinking: z.boolean(),
  supervision: supervisionNameSchema,
  stream: z.boolean(),
  sense_execute_timeout: z.number().optional(),
  approval_timeout: z.number().min(0).optional(),
  // 审批等待期间的内存资源上限；到点只 park runtime，不终结持久交互。
  approval_hard_timeout: z.number().min(0).optional(),
  // 断连宽限期（毫秒，>= 0；0 = 不等待）；缺省 15000 由 utils/config 兜底
  disconnect_grace_ms: z.number().min(0).optional(),
  // history_recall 感官单次返回硬字符上限（> 0）；缺省 4000 由 utils/config 兜底
  history_recall: z
    .object({
      max_output_chars: z.number().min(1).optional(),
    })
    .optional(),
  watchdog: z
    .object({
      timeout_ms: z.number().min(0).optional(),
      wake_on_timeout: z.boolean().optional(),
    })
    .optional(),
  maxLoopCount: z.number().optional(),
  bash_log_retention_hours: z.number().optional(),
  textEditor: z.string().optional(), // 文本编辑器路径
  file_compression: fileCompressionSchema.optional(),
  logger: loggerSchema.optional(),
  command: commandConfigSchema.optional(),
})

const mcpServerConfigSchema = z.object({
  transport: z.enum(['stdio', 'streamable-http']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().optional(),
  supervision: supervisionNameSchema.optional(),
})

/** config.save 入参：除 server 外全部字段；顶层 strict 拒 server 等多余键 */
export const configSaveSchema = z
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
          kind: z.enum(['role', 'shadow']).optional(),
          brain: z.string(),
          avatar: z.string().max(24).optional(),
          description: z.string().optional(),
          mentionable: z.boolean().optional(),
          senseGroup: z.string(),
          mcpServers: z.array(z.string()).optional(),
          systemPrompt: z.string().optional(),
          skills: z.array(z.string()).optional(),
          plugins: z.array(z.string()).optional(),
          permissions: rolePermissionSchema.optional(),
          lock: z.boolean().optional(),
        }),
      )
      .optional(),
    presets: z
      .record(
        z.string(),
        z.object({
          id: z
            .string()
            .regex(/^preset-[a-zA-Z0-9_-]{8,}$/)
            .optional(),
          shadows: z
            .object({
              conversationRouting: z.string().optional(),
            })
            .optional(),
          detailRole: z.string().optional(),
          leader: z.string(),
          roles: z.array(z.string()).optional(),
          mediaImage: z.string().optional(),
          mediaVideo: z.string().optional(),
          mediaAudio: z.string().optional(),
          /** 项目工作目录绝对路径（对齐 PresetConfig.workspace；缺省 → 不注入 <workspace> 段） */
          workspace: z.string().optional(),
          /** smart 监管规则覆盖文件名（对齐 PresetConfig.rule；缺省 → 仅用基准 base.yaml） */
          rule: z.string().optional(),
        }),
      )
      .optional(),
    memory: memorySchema,
  })
  .strict()

export const requestSchemas = {
  [Method.BRAIN_LIST]: emptySchema,
  [Method.SENSE_LIST]: emptySchema,
  [Method.SENSE_TOOLS]: emptySchema,
  [Method.SENSE_TOOLS_DOCS]: z.object({
    tools: z.array(z.string()).optional(),
  }),
  [Method.SKILLS_LIST]: z.object({
    page: z.number().int().positive().optional(),
    pageSize: z.number().int().positive().max(200).optional(),
    search: z.string().optional(),
    plugin: z.string().optional(),
  }),
  [Method.SKILLS_LIST_NAMES]: emptySchema,
  [Method.PROMPTS_LIST]: emptySchema,
  [Method.RULES_LIST]: emptySchema,
  [Method.RUNTIME_SET]: z.object({
    chatId: nonEmptyString,
    brain: nonEmptyString,
    senseGroup: z.string().optional(),
    mcpServers: mcpServersSchema,
  }),
  [Method.SESSION_RUNTIME_SET]: z.object({
    chatId: nonEmptyString,
    primary: runtimeSelectionSchema,
    roles: z.record(nonEmptyString, runtimeSelectionSchema),
  }),
  [Method.CHAT_CREATE]: z.object({
    chatId: nonEmptyString.optional(),
    /** T6 预设：给出则从 config.presets 解析编制，忽略 brain/senseGroup */
    preset: nonEmptyString.optional(),
    brain: nonEmptyString.optional(),
    senseGroup: z.string().optional(),
    mcpServers: mcpServersSchema,
    parentChatId: nonEmptyString.optional(),
  }).superRefine((value, ctx) => {
    if (!value.preset && !value.brain) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['brain'],
        message: 'preset 或 brain 至少提供一个',
      })
    }
    if (
      value.preset &&
      (value.brain !== undefined || value.senseGroup !== undefined || value.mcpServers !== undefined)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['preset'],
        message: 'preset 与显式 runtime 字段互斥',
      })
    }
  }),
  [Method.CHAT_LIST]: z
    .object({
      scope: z.enum(['stage', 'preset', 'history']),
      presetId: z.string().min(1).optional(),
      preset: z.string().min(1).optional(),
      includePreview: z.boolean().optional(),
    })
    .refine((value) => value.scope !== 'preset' || !!value.presetId || !!value.preset, {
      message: 'preset scope 需要 presetId 或 preset',
    }),
  [Method.CHAT_ROUTE_SUGGEST]: z.object({
    presetId: z.string().min(1),
    draft: z.string().trim().min(1).max(12000),
    requestVersion: z.number().int().nonnegative(),
  }),
  [InternalCommand.CHAT_GET]: chatIdSchema,
  [Method.CHAT_DELETE]: chatIdSchema,
  [Method.CHAT_BRANCH_PREVIEW]: z.object({
    rootChatId: z.string().min(1),
    anchorNodeId: z.string().min(1),
  }),
  [Method.CHAT_BRANCH_CREATE]: z.object({
    rootChatId: z.string().min(1),
    anchorNodeId: z.string().min(1),
    branchType: z.enum(['continuation', 'detail']),
    prompt: z.string().trim().min(1),
    commandId: z.string().min(1),
    clientMessageId: z.string().min(1),
    messageId: z.string().min(1),
    effectDigest: z.string().optional(),
  }),
  [Method.CHAT_BRANCH_ACTIVATE]: z.object({
    branchId: z.string().min(1),
    commandId: z.string().min(1),
  }),
  [Method.CHAT_ABORT_TASK]: z.object({ taskId: z.string().min(1), commandId: z.string().min(1) }),
  [Method.CHAT_CONTEXT_USAGE]: chatIdSchema,
  [Method.CHAT_PROMPT_SNAPSHOT]: z.object({
    chatId: z.string().min(1),
    epochId: z.string().min(1).optional(),
  }),
  [Method.CHAT_EPOCH_LIST]: chatIdSchema,
  [InternalCommand.CHAT_SEND]: z.object({
    chatId: z.string(),
    prompt: z.string(),
    /** P4：结构化附件（替代 [[media:filename]] 文本标记）。旧客户端不发该字段 → 走 marker 兼容路径。 */
    attachments: z
      .array(
        z.object({
          assetId: z.string(),
          kind: z.enum(['image', 'video', 'audio']),
          mimeType: z.string(),
        }),
      )
      .optional(),
  }),
  [Method.CHAT_INPUT_SUBMIT]: ChatInputSubmitRequestSchema,
  [Method.CHAT_TIMELINE_GET]: z
    .object({
      chatId: nonEmptyString.optional(),
      rootChatId: nonEmptyString.optional(),
      taskId: nonEmptyString.optional(),
      view: z.enum(['conversation', 'tree', 'audit']).optional(),
      // before：legacy chat.get 路径为字符串复合游标（createdAt/id 编码）；lite P1-② 为 number（orderKey 排他下界）。两者按类型分流，handler/投影层各自消费。
      before: z.union([z.string(), z.number()]).optional(),
      limit: z.number().int().positive().max(500).optional(),
      knownRevision: z.number().int().nonnegative().optional(),
    })
    .refine((value) => !!value.chatId || !!value.rootChatId || !!value.taskId, {
      message: 'chatId、rootChatId 或 taskId 至少提供一个',
    }),
  [Method.CHAT_TIMELINE_GENERATION_GET]: z.object({
    rootChatId: z.string().min(1),
    generationIndex: z.number().int().positive(),
  }),
  // lite profile：按需单节点详情（canonical §3.6.3）。offset/limit 为 UTF-16 code unit 分段。
  [Method.CHAT_TIMELINE_NODE_GET]: z
    .object({
      rootChatId: z.string().min(1),
      nodeId: z.string().min(1),
      sections: z.array(z.enum(['content', 'thinking', 'toolCalls'])).optional(),
      offset: z.number().int().min(0).max(0x7fffffff).optional(),
      limit: z.number().int().positive().max(32000).optional(),
      toolCursor: z
        .object({
          callIndex: z.number().int().min(0).max(0x7fffffff),
          field: z.enum(['arguments', 'result']),
          offset: z.number().int().min(0).max(0x7fffffff),
        })
        .strict()
        .optional(),
    })
    .superRefine((value, ctx) => {
      if (!value.toolCursor) return
      if (value.offset !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['offset'],
          message: 'toolCursor 不能与 offset 同时使用',
        })
      }
      if (value.sections?.length !== 1 || value.sections[0] !== 'toolCalls') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sections'],
          message: "toolCursor 仅支持 sections:['toolCalls']",
        })
      }
    }),
  [InternalCommand.CHAT_RESUME]: chatIdSchema,
  [Method.CHAT_RUN_RESUME]: ChatRunResumeRequestSchema,
  [Method.CHAT_RESUME_TREE]: z.object({
    rootChatId: z.string().min(1),
    pauseId: z.string().min(1),
    commandId: z.string().min(1),
  }),
  [InternalCommand.CHAT_SYNC]: z.object({
    chatId: z.string(),
    afterSeq: z.number().int().min(0),
  }),
  [Method.CHAT_OPEN]: ChatOpenRequestSchema,
  [Method.CHAT_CLOSE]: ChatCloseRequestSchema,
  [InternalCommand.CHAT_START_SPAWN]: z.object({ taskId: z.string() }),
  [Method.CHAT_STOP_CHILD]: z.object({
    rootChatId: z.string().min(1),
    childChatId: z.string().min(1),
    commandId: z.string().min(1),
    recursive: z.boolean().optional(),
  }),
  [InternalCommand.CHAT_SEND_TO_CHILD]: z.object({
    rootChatId: z.string().min(1),
    childChatId: z.string().min(1),
    commandId: z.string().min(1),
    content: z.string().min(1),
  }),
  [InternalCommand.SENSE_APPROVAL]: z.object({
    approvalId: z.string(),
    action: z.enum(['accept', 'reject']),
    reason: z.string().optional(),
  }),
  [Method.INTERACTION_LIST]: z.object({
    presetId: z.string().min(1).optional(),
    includeActivity: z.boolean().optional(),
    // lite profile（P0，R8）：分页上限 ≤20（mcu-lite-api.md §3.7-1 maxItems≤20）
    maxItems: z.number().int().positive().max(20).optional(),
  }),
  [Method.INTERACTION_APPROVAL_DECIDE]: z.object({
    interactionId: z.string().min(1),
    action: z.enum(['accept', 'reject']),
    expectedRevision: z.number().int().positive(),
    commandId: z.string().min(1),
    reason: z.string().optional(),
  }),
  [Method.INTERACTION_QUESTION_ANSWER]: z.object({
    interactionId: z.string().min(1),
    expectedRevision: z.number().int().positive(),
    commandId: z.string().min(1),
    answers: z
      .array(
        z.object({
          questionId: z.string().min(1),
          selectedLabels: z.array(z.string()),
          optionNotes: z.record(z.string(), z.string()).optional(),
          freeText: z.string().optional(),
          cancelled: z.boolean().optional(),
        }),
      )
      .min(1),
  }),
  [InternalCommand.SENSE_QUESTION_ANSWER]: z.object({
    questionId: z.string(),
    selectedLabels: z.array(z.string()),
    optionNotes: z.record(z.string(), z.string()).optional(),
    freeText: z.string().optional(),
    cancelled: z.boolean().optional(),
  }),
  [InternalCommand.SENSE_QUESTION_BATCH_ANSWER]: z.object({
    chatId: z.string(),
    batchId: z.string(),
    answers: z
      .array(
        z.object({
          questionId: z.string(),
          selectedLabels: z.array(z.string()),
          optionNotes: z.record(z.string(), z.string()).optional(),
          freeText: z.string().optional(),
          cancelled: z.boolean().optional(),
        }),
      )
      .min(1),
  }),
  [Method.CHAT_ABORT]: z.object({
    chatId: nonEmptyString,
    runId: nonEmptyString.optional(),
    commandId: z.string().min(1).optional(),
  }),
  [InternalCommand.CHAT_ATTACH]: chatIdSchema,
  [Method.BASH_LIST]: chatIdSchema,
  [Method.BASH_KILL]: z.object({
    chatId: nonEmptyString,
    pid: z.number().int().positive(),
  }),
  [Method.MCP_LIST]: emptySchema,
  [Method.MCP_GET]: z.object({ name: nonEmptyString }),
  [Method.MCP_CONNECT]: z.object({ name: nonEmptyString }),
  [Method.MCP_DISCONNECT]: z.object({ name: nonEmptyString }),
  [Method.MCP_RELOAD]: z.object({ name: nonEmptyString.optional() }),
  [Method.CONFIG_GET]: emptySchema,
  [Method.CONFIG_WORKSPACE_VALIDATE]: z.object({ workspace: z.string().optional() }).strict(),
  [Method.CONFIG_WORKSPACE_BROWSE_START]: emptySchema,
  // encPath 不设 .min(1)：根选择层为 xorEncrypt('')='' 空串（合法语义）
  [Method.CONFIG_WORKSPACE_BROWSE_LIST]: z
    .object({
      sessionId: z.string().min(1).max(128),
      nonce: z
        .string()
        .regex(/^[0-9a-f]+$/i)
        .min(16)
        .max(128),
      encPath: z.string().max(8192),
      includeFiles: z.boolean().optional(),
    })
    .strict(),
  [Method.CONFIG_SAVE]: configSaveSchema,
  // Hooks 管理（读写 .chery/hooks/hooks.json，独立于 config.yaml）
  [Method.HOOKS_GET]: emptySchema,
  [Method.HOOKS_SAVE]: z.object({
    handlers: z.record(
      z.string(),
      z.array(
        z.object({
          matcher: z.string().optional(),
          if: z.string().optional(),
          command: z.string().min(1),
          timeout: z.number().positive().optional(),
        }),
      ),
    ),
  }),
  [Method.HOOKS_EVENTS]: emptySchema,
  // Utils 工具：provider/url 必填，key 可选（ollama 通常无需）
  [Method.UTILS_MODELS]: z.object({
    provider: nonEmptyString,
    url: nonEmptyString,
    key: z.string().optional(),
    fullUrl: z.boolean().optional(),
  }),
  // 真实最小 Provider 请求：使用未保存的 provider/url/key/model，不持久化
  [Method.UTILS_TEST_CONNECTION]: z.object({
    provider: z.string().min(1),
    url: z.string().min(1),
    key: z.string().optional(),
    model: z.string().min(1),
    fullUrl: z.boolean().optional(),
  }),
  // Env 环境变量：空参，返回 .env 变量名列表
  [Method.ENV_LIST]: emptySchema,
  // 打开文件：path 为相对 CHERY_DIR 的文件路径
  [Method.UTILS_OPEN_FILE]: z.object({
    path: nonEmptyString,
  }),
  // 打开配置目录：固定目标 CHERY_DIR/.chery，不接受客户端路径
  [Method.UTILS_OPEN_CONFIG_DIR]: emptySchema,
  // 编辑器列表：空参，返回系统可用的文本编辑器
  [Method.UTILS_EDITORS]: emptySchema,
  // 模型档位查询：1~N 个模型名，返回每模型支持的 ThinkingLevel 列表
  [Method.UTILS_THINKING_LEVELS]: z.object({
    models: z.array(z.string().min(1)),
  }),
  // 内置命令管理（settings 「指令」tab 后端；只读枚举）
  [Method.COMMAND_LIST]: emptySchema,
  // Skill 导入：GitHub URL（独立技能集合）→ staging；commit 落盘；delete 删独立 skill
  [Method.SKILLS_PRE_IMPORT_URL]: z.object({
    url: z.string().min(1),
    credentialId: z.string().optional(),
    proxy: z.string().optional(),
  }),
  [Method.SKILLS_IMPORT_URL]: z
    .object({
      url: z.string().min(1),
      branch: z.string().min(1),
      credentialId: z.string().optional(),
      username: z.string().optional(),
      password: z.string().optional(), // 字段名命中 logger 自动脱敏
      remember: z.boolean().optional(),
      label: z.string().optional(),
      proxy: z.string().optional(),
    })
    .refine((d) => !(d.credentialId && d.password), {
      message: 'credentialId 与 inline password 互斥',
    }),
  [Method.SKILLS_COMMIT]: z.object({
    stagingId: z.string().min(1),
    selections: z.array(z.object({ name: z.string().min(1), import: z.boolean() })),
  }),
  [Method.SKILLS_DELETE]: z.object({ name: z.string().min(1) }),
  // Skill git 来源中央索引（.chery/.skill-sources.json）：list/resync/deleteSource + 批量 resyncAll
  [Method.SKILLS_LIST_SOURCES]: emptySchema,
  [Method.SKILLS_CHECK_SOURCE]: z.object({ sourceId: z.string().min(1) }),
  [Method.SKILLS_CHECK_ALL_SOURCES]: emptySchema,
  [Method.SKILLS_RESYNC_SOURCE]: z.object({ sourceId: z.string().min(1) }),
  [Method.SKILLS_DELETE_SOURCE]: z.object({ sourceId: z.string().min(1) }),
  [Method.SKILLS_RESYNC_ALL_SOURCES]: emptySchema,
  // 插件管理（settings 「插件」tab）：git clone 整仓 + 分支选择 + 凭据池 + 版本检查
  [Method.PLUGINS_LIST]: emptySchema,
  [Method.PLUGINS_PRE_IMPORT_URL]: z.object({
    url: z.string().min(1),
    credentialId: z.string().optional(),
    proxy: z.string().optional(),
  }),
  [Method.PLUGINS_IMPORT_URL]: z
    .object({
      url: z.string().min(1),
      branch: z.string().min(1),
      credentialId: z.string().optional(),
      username: z.string().optional(),
      password: z.string().optional(), // 字段名命中 logger 自动脱敏
      remember: z.boolean().optional(),
      label: z.string().optional(),
      pluginName: z.string().min(1).optional(),
      proxy: z.string().optional(),
    })
    .refine((d) => !(d.credentialId && d.password), {
      message: 'credentialId 与 inline password 互斥',
    }),
  [Method.PLUGINS_COMMIT]: z.object({ stagingId: z.string().min(1), overwrite: z.boolean() }),
  [Method.PLUGINS_CHECK_UPDATE]: z.object({ name: z.string().min(1) }),
  [Method.PLUGINS_CHECK_ALL_UPDATES]: emptySchema,
  [Method.PLUGINS_UPDATE]: z.object({ name: z.string().min(1) }),
  [Method.PLUGINS_UNINSTALL]: z.object({ name: z.string().min(1) }),
  // 凭据池（通用：plugins / skills / 未来 commands 共享）
  [Method.CREDENTIALS_LIST]: emptySchema,
  [Method.CREDENTIALS_SAVE]: z.object({
    label: z.string().min(1),
    username: z.string().min(1),
    password: z.string().min(1),
  }),
  [Method.CREDENTIALS_DELETE]: z.object({ id: z.string().min(1) }),
} as const satisfies Record<Method | InternalCommand, z.ZodTypeAny>

/**
 * 按 method 取请求 schema。未知 method 返回 undefined（router 先查 handler 存在性，再校验）。
 */
export function requestSchemaFor<M extends MethodName>(
  method: M,
): z.ZodType<ParamsOf<M>> | undefined {
  return requestSchemas[method] as z.ZodType<ParamsOf<M>> | undefined
}
