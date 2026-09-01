import { z } from 'zod'
import { Method, type Method as MethodName } from '@chery/protocol'
import { configSaveSchema } from './schemas.js'
import type { ResultOf } from './types.js'

// Response schemas intentionally keep objects loose so additive server fields
// remain wire-compatible. Required fields and discriminators are nevertheless
// checked for every public RPC; only the two explicitly empty responses are
// strict objects.
const id = z.string().min(1)
const stringArray = z.array(z.string())
const nonNegativeInt = z.number().int().nonnegative()
const positiveInt = z.number().int().positive()
const object = z.looseObject({})
const objectArray = z.array(object)
const trueResult = z.looseObject({ ok: z.literal(true) })
const emptyResult = z.object({}).strict()

const runtimeSchema = z.looseObject({
  chatId: id,
  brain: id,
  senseGroup: z.string(),
  mcpServers: stringArray,
})

const inputAcceptedSchema = z.looseObject({
  chatId: id,
  inputId: id,
  clientMessageId: id,
  messageId: id,
  runId: id,
  state: z.enum(['started', 'queued']),
  queueSequence: positiveInt,
  acceptedAt: z.number(),
})

const branchSummarySchema = z.looseObject({
  branchId: id,
  taskId: id,
  chatId: id,
  kind: z.enum(['original', 'continuation', 'detail']),
  createdAt: z.number(),
})

const childControlResultSchema = z.looseObject({
  chatId: id,
  previousState: z.enum(['running', 'paused', 'finished', 'failed', 'redirected']),
  state: z.enum(['running', 'paused', 'finished', 'failed', 'redirected']),
  outcome: z.enum(['stopped', 'queued', 'resumed', 'unchanged', 'rejected', 'failed']),
})

const treeControlStatusSchema = z.enum([
  'pausing',
  'paused',
  'resuming',
  'partial',
  'completed',
  'superseded',
])

const treeControlTargetSchema = z.looseObject({
  chatId: id,
  pausedRunId: id,
  status: z.enum(['paused', 'resuming', 'resumed', 'delegated', 'skipped', 'failed']),
})

const interactionSchema = z.looseObject({
  interactionId: id,
  kind: z.enum(['approval', 'question_batch']),
  chatId: id,
  rootChatId: id,
  status: z.enum(['pending', 'resolving', 'completed', 'expired', 'cancelled', 'blocked']),
  payload: z.record(z.string(), z.unknown()),
  revision: positiveInt,
  createdAt: z.number(),
  updatedAt: z.number(),
})

const timelineNodeSchema = z.looseObject({
  id,
  rootChatId: id,
  sourceChatId: id,
  kind: z.enum(['message', 'tool-batch', 'return', 'dispatch', 'system', 'tool-group', 'spawn']),
  actor: z.unknown(),
  direction: z.unknown(),
  visibility: z.enum(['conversation', 'detail', 'internal']),
  content: z.string(),
  orderKey: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
  status: z.enum(['committed', 'revoked']),
})

const generationSchema = z.looseObject({
  index: positiveInt,
  boundaryMessageId: id,
  boundaryNodeId: id,
  boundaryOrderKey: z.number(),
  fromOrderKey: z.number(),
  summary: z.string(),
  nodeCount: nonNegativeInt,
  createdAt: z.number(),
  trigger: z.enum(['manual', 'auto']),
})

const promptToolSchema = z.looseObject({
  name: id,
  description: z.string(),
})

const epochSchema = z.looseObject({
  epochId: id,
  ordinal: nonNegativeInt,
  label: z.string(),
  status: z.enum(['active', 'historical', 'archived']),
  snapshotQuality: z.enum(['exact', 'partial', 'reconstructed']),
  transitionReason: z.string(),
  executable: z.boolean(),
  createdAt: z.number(),
})

const credentialSchema = z.looseObject({
  id,
  label: z.string(),
  username: z.string(),
  createdAt: z.string(),
})

const pluginInfoSchema = z.looseObject({
  name: id,
  sourceUrl: z.string(),
  cloneUrl: z.string(),
  branch: z.string(),
  commitSha: z.string(),
  commitDate: z.string(),
  installedAt: z.string(),
  updatedAt: z.string(),
  totalSystemTokens: nonNegativeInt,
  minContentTokens: nonNegativeInt,
  maxContentTokens: nonNegativeInt,
  skills: objectArray,
})

const importStageSchema = {
  stagingId: id,
  candidates: objectArray,
}

const configSaveResponseSchema = z.discriminatedUnion('needRestart', [
  z.looseObject({
    needRestart: z.literal(true),
    restart: z.enum(['immediate', 'scheduled', 'manual']),
    warnings: stringArray.optional(),
  }),
  z.looseObject({
    needRestart: z.literal(false),
    restart: z.literal('manual'),
    validationErrors: stringArray,
    validationWarnings: stringArray,
    rollbackBackup: id,
  }),
])

const testConnectionResponseSchema = z.discriminatedUnion('ok', [
  z.looseObject({ ok: z.literal(true), error: z.never().optional() }),
  z.looseObject({ ok: z.literal(false), error: id }),
])

const schemas = {
  [Method.BRAIN_LIST]: z.looseObject({ brains: objectArray, mcpServers: stringArray }),
  [Method.SENSE_LIST]: z.looseObject({ senseGroups: objectArray }),
  [Method.SENSE_TOOLS]: z.looseObject({ tools: objectArray }),
  [Method.SENSE_TOOLS_DOCS]: z.looseObject({ docs: objectArray }),
  [Method.SKILLS_LIST]: z.looseObject({
    skills: objectArray,
    total: nonNegativeInt,
    page: positiveInt,
    pageSize: nonNegativeInt,
  }),
  [Method.SKILLS_LIST_NAMES]: z.looseObject({
    skills: stringArray,
    plugins: stringArray,
    skillTokens: z.record(z.string(), nonNegativeInt),
    pluginTokens: z.record(z.string(), nonNegativeInt),
  }),
  [Method.SKILLS_PRE_IMPORT_URL]: z.looseObject({
    gitNotInstalled: z.boolean(),
    needsAuth: z.boolean(),
    branches: stringArray,
  }),
  [Method.SKILLS_IMPORT_URL]: z.looseObject(importStageSchema),
  [Method.SKILLS_COMMIT]: z.looseObject({ imported: stringArray, skipped: stringArray }),
  [Method.SKILLS_DELETE]: trueResult,
  [Method.SKILLS_LIST_SOURCES]: z.looseObject({ sources: objectArray }),
  [Method.SKILLS_CHECK_SOURCE]: z.looseObject({
    sourceId: id,
    latestSha: id,
    updateAvailable: z.boolean(),
  }),
  [Method.SKILLS_CHECK_ALL_SOURCES]: z.looseObject({
    checked: nonNegativeInt,
    updatesAvailable: nonNegativeInt,
    failed: objectArray,
  }),
  [Method.SKILLS_RESYNC_SOURCE]: z.looseObject({
    ...importStageSchema,
    branch: id,
    commitSha: id,
    commitDate: id,
    sourceId: id,
    selected: stringArray,
  }),
  [Method.SKILLS_DELETE_SOURCE]: trueResult,
  [Method.SKILLS_RESYNC_ALL_SOURCES]: z.looseObject({
    results: objectArray,
    successes: nonNegativeInt,
    failures: nonNegativeInt,
  }),
  [Method.PROMPTS_LIST]: z.looseObject({ prompts: stringArray }),
  [Method.RULES_LIST]: z.looseObject({ rules: stringArray }),
  [Method.RUNTIME_SET]: runtimeSchema,
  [Method.SESSION_RUNTIME_SET]: z.looseObject({
    chatId: id,
    applied: stringArray,
    deferredRunning: stringArray,
  }),
  [Method.CHAT_CREATE]: runtimeSchema.extend({ presetId: id.optional() }),
  [Method.CHAT_LIST]: z.looseObject({ chats: objectArray }),
  [Method.CHAT_ROUTE_SUGGEST]: z.looseObject({
    requestVersion: nonNegativeInt,
    target: z.looseObject({
      chatId: id.nullable(),
      confidence: z.number(),
      reason: z.string(),
    }),
    trace: z.looseObject({
      context: object,
      response: z.looseObject({
        toolCall: z.looseObject({
          name: z.literal('select_conversation'),
          arguments: object,
        }),
      }),
    }),
  }),
  [Method.CHAT_DELETE]: z.looseObject({ chatId: id, deletedChatIds: z.array(id) }),
  [Method.CHAT_BRANCH_PREVIEW]: z.looseObject({
    taskId: id,
    sourceBranchId: id,
    eligible: z.boolean(),
    sideEffects: objectArray,
    effectDigest: z.string(),
    inheritedCompletedTasks: objectArray,
    inheritedPausedTasks: objectArray,
  }),
  [Method.CHAT_BRANCH_CREATE]: branchSummarySchema.extend({ input: inputAcceptedSchema }),
  [Method.CHAT_BRANCH_ACTIVATE]: z.looseObject({
    taskId: id,
    activeBranchId: id,
    activeChatId: id,
    deliveryGeneration: nonNegativeInt,
  }),
  [Method.CHAT_ABORT_TASK]: z.looseObject({ taskId: id, abortedBranches: z.array(id) }),
  [Method.CHAT_CONTEXT_USAGE]: z.looseObject({
    chatId: id,
    contextUsage: z.number(),
    contextUsed: nonNegativeInt,
    contextTotal: nonNegativeInt,
    contextBreakdown: object,
  }),
  [Method.CHAT_PROMPT_SNAPSHOT]: z.looseObject({
    chatId: id,
    epochId: id.optional(),
    epochOrdinal: nonNegativeInt.optional(),
    epochStatus: z.enum(['active', 'historical', 'archived']).optional(),
    snapshotQuality: z.enum(['exact', 'partial', 'reconstructed']).optional(),
    systemPrompt: z.string(),
    tools: z.array(promptToolSchema),
  }),
  [Method.CHAT_EPOCH_LIST]: z.looseObject({
    chatId: id,
    rootChatId: id,
    activeEpochId: id.optional(),
    epochs: z.array(epochSchema),
  }),
  [Method.CHAT_INPUT_SUBMIT]: inputAcceptedSchema,
  [Method.CHAT_TIMELINE_GET]: z.looseObject({
    chatId: id,
    revision: nonNegativeInt,
    messages: objectArray.optional(),
    rootTimeline: object.optional(),
    unchanged: z.boolean().optional(),
  }),
  [Method.CHAT_TIMELINE_GENERATION_GET]: z.looseObject({
    rootChatId: id,
    generation: generationSchema,
    nodes: z.array(timelineNodeSchema),
    edges: objectArray,
  }),
  [Method.CHAT_TIMELINE_NODE_GET]: z.looseObject({
    rootChatId: id,
    node: timelineNodeSchema,
    refs: objectArray,
    hasMore: z.boolean(),
    page: object.optional(),
  }),
  [Method.CHAT_RUN_RESUME]: z.looseObject({
    chatId: id,
    commandId: id,
    runId: id,
    status: z.enum(['started', 'already-running']),
  }),
  [Method.CHAT_RESUME_TREE]: z.looseObject({
    rootChatId: id,
    pauseId: id,
    commandId: id,
    status: treeControlStatusSchema,
    results: z.array(treeControlTargetSchema),
  }),
  [Method.CHAT_OPEN]: z.looseObject({
    chatId: id,
    subscriptionId: id,
    eventSeq: nonNegativeInt,
    timelineRevision: nonNegativeInt,
    timelineChanged: z.boolean(),
    state: z.looseObject({
      pendingInputs: objectArray,
      activeTurns: objectArray,
      questionBatches: objectArray,
      runningTools: objectArray,
      executionSteps: objectArray,
      roles: objectArray,
      run: z
        .looseObject({
          runId: id,
          state: z.enum(['running', 'paused', 'completed', 'failed']),
        })
        .optional(),
      runs: z
        .array(
          z.looseObject({
            chatId: id,
            runId: id,
            state: z.enum(['running', 'paused', 'completed', 'failed']),
          }),
        )
        .optional(),
    }),
  }),
  [Method.CHAT_CLOSE]: z.looseObject({
    subscriptionId: id,
    chatId: id.optional(),
    closed: z.boolean(),
  }),
  [Method.CHAT_STOP_CHILD]: z.looseObject({
    rootChatId: id,
    commandId: id,
    results: z.array(childControlResultSchema),
  }),
  [Method.CHAT_ABORT]: z.looseObject({
    chatId: id,
    status: treeControlStatusSchema.optional(),
    aborted: z.boolean(),
    results: z.array(childControlResultSchema).optional(),
  }),
  [Method.INTERACTION_LIST]: z.looseObject({ interactions: z.array(interactionSchema) }),
  [Method.INTERACTION_APPROVAL_DECIDE]: z.looseObject({ interaction: interactionSchema }),
  [Method.INTERACTION_QUESTION_ANSWER]: z.looseObject({ interaction: interactionSchema }),
  [Method.BASH_LIST]: z.looseObject({ chatId: id, processes: objectArray }),
  [Method.BASH_KILL]: z.looseObject({ chatId: id, pid: positiveInt, killed: z.boolean() }),
  [Method.MCP_LIST]: z.looseObject({ servers: objectArray }),
  [Method.MCP_GET]: z.looseObject({ server: object }),
  [Method.MCP_CONNECT]: z.looseObject({ server: object }),
  [Method.MCP_DISCONNECT]: z.looseObject({ server: object }),
  [Method.MCP_RELOAD]: z.looseObject({
    servers: objectArray,
    connected: nonNegativeInt,
    failed: nonNegativeInt,
    totalSenses: nonNegativeInt,
  }),
  [Method.CONFIG_GET]: configSaveSchema,
  [Method.CONFIG_WORKSPACE_VALIDATE]: z.looseObject({ valid: z.boolean() }),
  [Method.CONFIG_WORKSPACE_BROWSE_START]: z.looseObject({
    sessionId: id,
    ttlMs: positiveInt,
    platform: id,
    sep: z.enum(['/', '\\']),
    roots: objectArray,
    initialPath: z.string(),
    includeFiles: z.boolean(),
  }),
  [Method.CONFIG_WORKSPACE_BROWSE_LIST]: z.looseObject({ nonce: id, encData: z.string() }),
  [Method.CONFIG_SAVE]: configSaveResponseSchema,
  [Method.HOOKS_GET]: z.looseObject({
    handlers: z.record(z.string(), objectArray),
    brainHooks: z.record(z.string(), z.record(z.string(), objectArray)),
    shellInfo: object,
  }),
  [Method.HOOKS_SAVE]: trueResult,
  [Method.HOOKS_EVENTS]: z.looseObject({ events: objectArray }),
  [Method.UTILS_MODELS]: z.looseObject({ models: objectArray }),
  [Method.UTILS_TEST_CONNECTION]: testConnectionResponseSchema,
  [Method.ENV_LIST]: z.looseObject({ vars: stringArray }),
  [Method.UTILS_OPEN_FILE]: emptyResult,
  [Method.UTILS_OPEN_CONFIG_DIR]: emptyResult,
  [Method.UTILS_EDITORS]: z.looseObject({ editors: objectArray }),
  [Method.UTILS_MODEL_RECOMMENDATION]: z.looseObject({
    matched: z.boolean(),
    confidence: z.enum(['exact', 'pattern', 'unknown']),
    thinkingLevels: stringArray,
    unknown: object,
  }),
  [Method.COMMAND_LIST]: z.looseObject({ commands: objectArray }),
  [Method.PLUGINS_LIST]: z.looseObject({ plugins: z.array(pluginInfoSchema) }),
  [Method.PLUGINS_PRE_IMPORT_URL]: z.looseObject({
    gitNotInstalled: z.boolean(),
    needsAuth: z.boolean(),
    branches: stringArray,
    owner: z.string(),
    repo: z.string(),
    suggestedName: id,
    nameConflict: z.boolean(),
  }),
  [Method.PLUGINS_IMPORT_URL]: z.looseObject({
    stagingId: id,
    pluginName: id,
    existing: z.boolean(),
    sourceUrl: z.string(),
    branch: id,
    commitSha: id,
    commitDate: id,
    skills: objectArray,
  }),
  [Method.PLUGINS_COMMIT]: z.looseObject({ plugin: pluginInfoSchema }),
  [Method.PLUGINS_CHECK_UPDATE]: z.looseObject({
    gitNotInstalled: z.boolean(),
    needsAuth: z.boolean(),
    currentSha: z.string(),
    currentDate: z.string(),
    latestSha: z.string(),
    lastUpgrade: z.string(),
    updateAvailable: z.boolean(),
  }),
  [Method.PLUGINS_CHECK_ALL_UPDATES]: z.looseObject({
    checked: nonNegativeInt,
    updatesAvailable: nonNegativeInt,
    failed: objectArray,
  }),
  [Method.PLUGINS_UPDATE]: z.looseObject({ plugin: pluginInfoSchema }),
  [Method.PLUGINS_UNINSTALL]: trueResult,
  [Method.CREDENTIALS_LIST]: z.looseObject({ credentials: z.array(credentialSchema) }),
  [Method.CREDENTIALS_SAVE]: z.looseObject({ credential: credentialSchema }),
  [Method.CREDENTIALS_DELETE]: trueResult,
} satisfies Record<MethodName, z.ZodTypeAny>

export const responseSchemas: Readonly<Record<MethodName, z.ZodTypeAny>> = Object.freeze(schemas)

export function responseSchemaFor<M extends MethodName>(method: M): z.ZodType<ResultOf<M>> {
  return responseSchemas[method] as z.ZodType<ResultOf<M>>
}
