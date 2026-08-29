import { z } from 'zod'

/**
 * Canonical public RPC surface.
 *
 * This is intentionally the only place where wire method names are declared.
 * Internal journal/command names must live outside this catalog so they can
 * never become callable merely because a service type references them.
 */
export const Method = {
  BRAIN_LIST: 'brain.list',
  SENSE_LIST: 'sense.list',
  SENSE_TOOLS: 'sense.tools',
  SENSE_TOOLS_DOCS: 'sense.tools.docs',
  SKILLS_LIST: 'skills.list',
  SKILLS_LIST_NAMES: 'skills.listNames',
  SKILLS_PRE_IMPORT_URL: 'skills.preImportUrl',
  SKILLS_IMPORT_URL: 'skills.importUrl',
  SKILLS_COMMIT: 'skills.commit',
  SKILLS_DELETE: 'skills.delete',
  SKILLS_LIST_SOURCES: 'skills.listSources',
  SKILLS_CHECK_SOURCE: 'skills.checkSource',
  SKILLS_CHECK_ALL_SOURCES: 'skills.checkAllSources',
  SKILLS_RESYNC_SOURCE: 'skills.resyncSource',
  SKILLS_DELETE_SOURCE: 'skills.deleteSource',
  SKILLS_RESYNC_ALL_SOURCES: 'skills.resyncAllSources',
  PROMPTS_LIST: 'prompts.list',
  RULES_LIST: 'rules.list',
  RUNTIME_SET: 'runtime.set',
  SESSION_RUNTIME_SET: 'session.runtime.set',
  CHAT_CREATE: 'chat.create',
  CHAT_LIST: 'chat.list',
  CHAT_ROUTE_SUGGEST: 'chat.route.suggest',
  CHAT_DELETE: 'chat.delete',
  CHAT_BRANCH_PREVIEW: 'chat.branch.preview',
  CHAT_BRANCH_CREATE: 'chat.branch.create',
  CHAT_BRANCH_ACTIVATE: 'chat.branch.activate',
  CHAT_ABORT_TASK: 'chat.abortTask',
  CHAT_CONTEXT_USAGE: 'chat.contextUsage',
  CHAT_PROMPT_SNAPSHOT: 'chat.promptSnapshot',
  CHAT_EPOCH_LIST: 'chat.epoch.list',
  CHAT_INPUT_SUBMIT: 'chat.input.submit',
  CHAT_TIMELINE_GET: 'chat.timeline.get',
  CHAT_TIMELINE_GENERATION_GET: 'chat.timeline.generation.get',
  CHAT_TIMELINE_NODE_GET: 'chat.timeline.node.get',
  CHAT_RUN_RESUME: 'chat.run.resume',
  CHAT_RESUME_TREE: 'chat.resumeTree',
  CHAT_OPEN: 'chat.open',
  CHAT_CLOSE: 'chat.close',
  CHAT_STOP_CHILD: 'chat.stopChild',
  CHAT_ABORT: 'chat.abort',
  INTERACTION_LIST: 'interaction.list',
  INTERACTION_APPROVAL_DECIDE: 'interaction.approval.decide',
  INTERACTION_QUESTION_ANSWER: 'interaction.question.answer',
  BASH_LIST: 'bash.list',
  BASH_KILL: 'bash.kill',
  MCP_LIST: 'mcp.list',
  MCP_GET: 'mcp.get',
  MCP_CONNECT: 'mcp.connect',
  MCP_DISCONNECT: 'mcp.disconnect',
  MCP_RELOAD: 'mcp.reload',
  CONFIG_GET: 'config.get',
  CONFIG_WORKSPACE_VALIDATE: 'config.workspace.validate',
  CONFIG_WORKSPACE_BROWSE_START: 'config.workspace.browse.start',
  CONFIG_WORKSPACE_BROWSE_LIST: 'config.workspace.browse.list',
  CONFIG_SAVE: 'config.save',
  HOOKS_GET: 'hooks.get',
  HOOKS_SAVE: 'hooks.save',
  HOOKS_EVENTS: 'hooks.events',
  UTILS_MODELS: 'utils.models',
  UTILS_TEST_CONNECTION: 'utils.testConnection',
  ENV_LIST: 'env.list',
  UTILS_OPEN_FILE: 'utils.openFile',
  UTILS_OPEN_CONFIG_DIR: 'utils.openConfigDir',
  UTILS_EDITORS: 'utils.editors',
  UTILS_THINKING_LEVELS: 'utils.thinkingLevels',
  COMMAND_LIST: 'command.list',
  PLUGINS_LIST: 'plugins.list',
  PLUGINS_PRE_IMPORT_URL: 'plugins.preImportUrl',
  PLUGINS_IMPORT_URL: 'plugins.importUrl',
  PLUGINS_COMMIT: 'plugins.commit',
  PLUGINS_CHECK_UPDATE: 'plugins.checkUpdate',
  PLUGINS_CHECK_ALL_UPDATES: 'plugins.checkAllUpdates',
  PLUGINS_UPDATE: 'plugins.update',
  PLUGINS_UNINSTALL: 'plugins.uninstall',
  CREDENTIALS_LIST: 'credentials.list',
  CREDENTIALS_SAVE: 'credentials.save',
  CREDENTIALS_DELETE: 'credentials.delete',
} as const

export type Method = (typeof Method)[keyof typeof Method]

export const PUBLIC_METHODS = Object.freeze(Object.values(Method)) as readonly Method[]

export const ErrorCode = {
  METHOD_NOT_FOUND: 'METHOD_NOT_FOUND',
  INTERNAL: 'INTERNAL',
  TIMEOUT: 'TIMEOUT',
  NOT_FOUND: 'NOT_FOUND',
  INVALID_PARAMS: 'INVALID_PARAMS',
  CONFLICT: 'CONFLICT',
  RUNTIME_SELECTION_REQUIRED: 'RUNTIME_SELECTION_REQUIRED',
  MAINTENANCE_MODE: 'MAINTENANCE_MODE',
  INTERACTION_STALE: 'INTERACTION_STALE',
  INTERACTION_ALREADY_RESOLVED: 'INTERACTION_ALREADY_RESOLVED',
  COMMAND_CONFLICT: 'COMMAND_CONFLICT',
  INPUT_QUEUE_FULL: 'INPUT_QUEUE_FULL',
  PROFILE_VERSION_UNSUPPORTED: 'PROFILE_VERSION_UNSUPPORTED',
  RATE_LIMITED: 'RATE_LIMITED',
} as const

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode]

export const ErrorSourceSchema = z.enum([
  'brain',
  'sense',
  'media',
  'mcp',
  'chat',
  'system',
  'hook',
  'config',
  'transport',
])
export type ErrorSource = z.infer<typeof ErrorSourceSchema>

export const ProtocolErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  source: ErrorSourceSchema,
  retryable: z.boolean(),
  tracingId: z.string().min(1),
  retryAfterMs: z.number().int().nonnegative().optional(),
})
export type ProtocolError = z.infer<typeof ProtocolErrorSchema>

export const RunErrorNotificationDataSchema = ProtocolErrorSchema.extend({
  canResume: z.boolean(),
  /** 上游技术摘要（≤200 字符一行，如 `upstream 400: {...}`）；前端 error-bubble 折叠展示 */
  detail: z.string().min(1).max(200).optional(),
})
export type RunErrorNotificationData = z.infer<typeof RunErrorNotificationDataSchema>

/** Payload of a staged reverse chunk. Reverse only retracts transient messages. */
export const StagedReverseChunkDataSchema = z
  .object({
    type: z.literal('reverse'),
    messageIds: z.array(z.string().min(1)).min(1),
  })
  .loose()
export type StagedReverseChunkData = z.infer<typeof StagedReverseChunkDataSchema>

/** Closes a streamed model turn that must be discarded before a clean retry. */
export const TurnCancelledNotificationDataSchema = z
  .object({
    turnId: z.string().min(1),
    messageId: z.string().min(1),
    reason: z.literal('retry_reset'),
    cancelledAt: z.number().int().nonnegative().optional(),
  })
  .loose()
export type TurnCancelledNotificationData = z.infer<typeof TurnCancelledNotificationDataSchema>

export const ChunkEnvelopeSchema = z
  .object({
    kind: z.literal('chunk'),
    type: z.string().min(1),
    requestId: z.string().min(1),
    chatId: z.string().min(1).optional(),
    runId: z.string().min(1).optional(),
    data: z.unknown(),
  })
  .loose()
  .superRefine((chunk, ctx) => {
    if (chunk.type !== 'staged') return
    const data = chunk.data
    if (!data || typeof data !== 'object' || (data as { type?: unknown }).type !== 'reverse') {
      return
    }
    const parsed = StagedReverseChunkDataSchema.safeParse(data)
    if (parsed.success) return
    for (const issue of parsed.error.issues) {
      ctx.addIssue({ ...issue, path: ['data', ...issue.path] })
    }
  })

export const NotificationEnvelopeSchema = z
  .object({
    kind: z.literal('notification'),
    type: z.string().min(1),
    requestId: z.string().min(1).optional(),
    chatId: z.string().min(1).optional(),
    runId: z.string().min(1).optional(),
    data: z.unknown(),
  })
  .loose()
  .superRefine((notification, ctx) => {
    const schema =
      notification.type === 'error'
        ? RunErrorNotificationDataSchema
        : notification.type === 'turn.cancelled'
          ? TurnCancelledNotificationDataSchema
          : undefined
    if (schema) {
      const parsed = schema.safeParse(notification.data)
      if (parsed.success) return
      for (const issue of parsed.error.issues) {
        ctx.addIssue({ ...issue, path: ['data', ...issue.path] })
      }
    }
  })
