import { describe, expect, it } from 'vitest'
import { Method, PUBLIC_METHODS, QQResponseSchemas, QQDefaultConfig } from '@chery/protocol'
import { responseSchemas } from '@/service/message/responseSchemas.js'

const runtime = { chatId: 'chat-1', brain: 'brain-1', senseGroup: 'tools', mcpServers: [] }
const metric = { value: 0, source: 'provider', coverage: 'complete', knownCount: 0, totalCount: 0 }
const requestUsage = {
  attemptId: 'attempt-1',
  taskKey: 'chat-1',
  chatId: 'chat-1',
  model: 'mock',
  provider: 'mock',
  protocol: 'mock',
  startedAt: 1,
  status: 'completed',
  usage: {},
  context: { system: 0, tools: 0, conversation: 0, limit: null },
}
const input = {
  chatId: 'chat-1',
  inputId: 'input-1',
  clientMessageId: 'client-1',
  messageId: 'message-1',
  runId: 'run-1',
  state: 'started',
  queueSequence: 1,
  acceptedAt: 1,
}
const interaction = {
  interactionId: 'interaction-1',
  kind: 'approval',
  chatId: 'chat-1',
  rootChatId: 'chat-1',
  status: 'pending',
  payload: {},
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
}
const node = {
  id: 'node-1',
  rootChatId: 'chat-1',
  sourceChatId: 'chat-1',
  kind: 'message',
  actor: { kind: 'user' },
  direction: 'self',
  visibility: 'conversation',
  content: 'hello',
  orderKey: 1,
  createdAt: 1,
  updatedAt: 1,
  status: 'committed',
}
const generation = {
  index: 1,
  boundaryMessageId: 'message-1',
  boundaryNodeId: 'node-1',
  boundaryOrderKey: 1,
  fromOrderKey: 0,
  summary: 'summary',
  nodeCount: 1,
  createdAt: 1,
  trigger: 'manual',
}
const epoch = {
  epochId: 'epoch-1',
  ordinal: 0,
  label: 'Epoch 0',
  status: 'active',
  snapshotQuality: 'exact',
  transitionReason: 'created',
  executable: true,
  createdAt: 1,
}
const childResult = {
  chatId: 'child-1',
  previousState: 'running',
  state: 'paused',
  outcome: 'stopped',
}
const credential = {
  id: 'credential-1',
  label: 'GitHub',
  username: 'git',
  createdAt: '2026-08-28T00:00:00.000Z',
}
const plugin = {
  name: 'plugin-1',
  sourceUrl: 'https://example.test/plugin',
  cloneUrl: 'https://example.test/plugin.git',
  branch: 'main',
  commitSha: 'abc123',
  commitDate: '2026-08-28T00:00:00.000Z',
  installedAt: '2026-08-28T00:00:00.000Z',
  updatedAt: '2026-08-28T00:00:00.000Z',
  totalSystemTokens: 0,
  minContentTokens: 0,
  maxContentTokens: 0,
  skills: [],
}
const config = {
  global: {
    thinking: false,
    supervision: 'auto',
    stream: true,
    command: {
      warn: { unit: 'percent', value: 0.8 },
      auto: { unit: 'tokens', value: 1000 },
    },
  },
  llm: { brain: { mock: { model: 'mock-model', provider: 'mock' } } },
}

const ingressStatus = { id: 'sample', apiVersion: 2, installed: true, enabled: false, savedVersion: '1.0.0', activeVersion: null, state: 'inactive', requiresRestart: true, savedRevision: 0, appliedRevision: null, apply: 'pending', grantedCapabilities: [], dependencies: [] }
const mutation = { contractVersion: 2, requestId: 'fixture', registryRevision: 0, saved: true, status: ingressStatus }
const ingressConfig = { contractVersion: 2, id: 'sample', config: {}, baseRevision: 0, apply: { state: 'pending', revision: 0 } }
const qqConfig = { config: QQDefaultConfig, baseRevision: 0, apply: { state: 'pending', revision: 0 } }
const responseFor = (method: Method) => responseSchemas[method] ?? QQResponseSchemas[method as keyof typeof QQResponseSchemas]

const validResponses: Record<Method, unknown> = {
  [Method.QQ_IMAGE_SCOPE_GET]: {schemaVersion:1,backendEpoch:'epoch',connectionGeneration:'gen',sessionId:'session',selfId:'123',appliedRevision:1,scopeDigest:'a'.repeat(64),enabled:false,allowedTargets:[],targets:[],limits:QQDefaultConfig.imageStorage},
  [Method.QQ_IMAGE_SCOPE_ACK]: {acknowledged:true},
  [Method.QQ_IMAGE_SOURCE_REGISTER]: {sourceEventId:'source',permitId:'permit'},
  [Method.QQ_IMAGE_INGEST_BEGIN]: {state:'uploading',nextOffset:0,uploadId:'upload'},
  [Method.QQ_IMAGE_INGEST_CHUNK]: {nextOffset:1},
  [Method.QQ_IMAGE_INGEST_STATUS]: {state:'registered',nextOffset:0},
  [Method.QQ_IMAGE_INGEST_COMMIT]: {state:'committed',nextOffset:1,uploadId:'upload',assetId:'asset',assetVersionId:'version'},
  [Method.QQ_IMAGE_INGEST_CANCEL]: {cancelled:true},
  [Method.INGRESS_LIST]: { contractVersion: 2, hostApiVersion: 2, registryRevision: 0, plugins: [] },
  [Method.INGRESS_INSTALL]: mutation,
  [Method.INGRESS_UPGRADE]: mutation,
  [Method.INGRESS_ENABLE]: mutation,
  [Method.INGRESS_DISABLE]: mutation,
  [Method.INGRESS_UNINSTALL]: mutation,
  [Method.INGRESS_CONFIG_GET]: ingressConfig,
  [Method.INGRESS_CONFIG_SAVE]: { ...ingressConfig, saved: true },
  [Method.INGRESS_UI_LIST]: { contractVersion: 2, registryRevision: 0, modules: [] },
  [Method.INGRESS_UI_READ]: { contractVersion: 2, contentType: 'text/html', contentBase64: '', resourceVersion: '1' },
  [Method.INGRESS_MANAGEMENT_CALL]: { contractVersion: 2, status: 200, body: { data: {} } },
  [Method.QQ_PLUGIN_HELLO]: { protocolVersion: 1, backendVersion: '1.0.0', selfId: '12345', authenticated: true, capabilities: [] },
  [Method.QQ_IDENTITY_BIND]: { bound: true, selfId: '12345', sourceType: 'napcat-action', validation: 'accepted' },
  [Method.QQ_EVENT_SUBMIT]: { eventId: 'fixture', accepted: true },
  [Method.QQ_DELIVERY_RESULT]: { eventId: 'fixture', recorded: true },
  [Method.QQ_REQUEST_RECOVER]: { events: [] },
  [Method.QQ_CONFIG_GET]: qqConfig,
  [Method.QQ_CONFIG_SAVE]: { ...qqConfig, saved: true },
  [Method.QQ_STATUS_GET]: { installed: true, enabled: false, activeVersion: null, savedVersion: '1.0.0', savedRevision: 0, appliedRevision: 0, apply: { state: 'pending', revision: 0 }, napcatConnected: false, trustedIdentity: false, qqOnline: null, paused: true, pausedTargets: 0, reasons: [], channels: { group: { enabled: false }, private: { enabled: false } }, missingBindings: [], missingResources: [] },
  [Method.QQ_QUEUE_GET]: { entries: [] },
  [Method.QQ_HISTORY_GET]: { entries: [] },
  [Method.QQ_ENTRY_GET]: { requestId: 'request', eventId: 'event', target: 'a'.repeat(64), targetId: '456', senderId: '789', senderName: 'synthetic', conversationType: 'group', state: 'completed', acceptedAt: 1, policyRevision: 0, preset: 'p', inputPreview: 'hello', replyPreview: '', messageCount: 1, attachmentCount: 0, delivery: { pending: 0, inflight: 0, sent: 0, unknown: 0, failed: 0 }, messages: [], reply: '', replyTruncated: false, deliveries: [], deliveriesTruncated: false },
  [Method.CHAT_INPUT_WITHDRAW]: { chatId: 'chat', inputId: 'input', clientMessageId: 'client', messageId: 'message', state: 'cancelled', withdrawnAt: 1 },
  [Method.WORKSPACE_GIT_STATUS]: { chatId: 'chat', branch: 'main', branches: [], dirty: false, files: [] },
  [Method.WORKSPACE_GIT_CHECKOUT]: { chatId: 'chat', branch: 'main' },
  [Method.BRAIN_LIST]: { brains: [], mcpServers: [] },
  [Method.SENSE_LIST]: { senseGroups: [] },
  [Method.SENSE_TOOLS]: { tools: [] },
  [Method.SENSE_TOOLS_DOCS]: { docs: [] },
  [Method.SKILLS_LIST]: { skills: [], total: 0, page: 1, pageSize: 0 },
  [Method.SKILLS_LIST_NAMES]: { skills: [], plugins: [], skillTokens: {}, pluginTokens: {} },
  [Method.SKILLS_PRE_IMPORT_URL]: { gitNotInstalled: false, needsAuth: false, branches: [] },
  [Method.SKILLS_IMPORT_URL]: { stagingId: 'stage-1', candidates: [] },
  [Method.SKILLS_COMMIT]: { imported: [], skipped: [] },
  [Method.SKILLS_DELETE]: { ok: true },
  [Method.SKILLS_LIST_SOURCES]: { sources: [] },
  [Method.SKILLS_CHECK_SOURCE]: {
    sourceId: 'source-1',
    latestSha: 'abc123',
    updateAvailable: false,
  },
  [Method.SKILLS_CHECK_ALL_SOURCES]: { checked: 0, updatesAvailable: 0, failed: [] },
  [Method.SKILLS_RESYNC_SOURCE]: {
    stagingId: 'stage-1',
    candidates: [],
    branch: 'main',
    commitSha: 'abc123',
    commitDate: '2026-08-28T00:00:00.000Z',
    sourceId: 'source-1',
    selected: [],
  },
  [Method.SKILLS_DELETE_SOURCE]: { ok: true },
  [Method.SKILLS_RESYNC_ALL_SOURCES]: { results: [], successes: 0, failures: 0 },
  [Method.PROMPTS_LIST]: { prompts: [] },
  [Method.RULES_LIST]: { rules: [] },
  [Method.RUNTIME_SET]: runtime,
  [Method.SESSION_RUNTIME_SET]: { chatId: 'chat-1', applied: [], deferredRunning: [] },
  [Method.CHAT_CREATE]: runtime,
  [Method.CHAT_LIST]: { chats: [] },
  [Method.CHAT_TASK_LIST]: { items: [], total: 0, snapshotAt: 1 },
  [Method.CHAT_TASK_RESULT_VIEW]: {
    taskKey: 'task-1',
    resultId: 'result-1',
    viewed: true,
    viewedAt: 1,
  },
  [Method.CHAT_ROUTE_SUGGEST]: {
    requestVersion: 0,
    target: { chatId: null, confidence: 1, reason: 'new conversation' },
    trace: {
      context: {},
      response: { toolCall: { name: 'select_conversation', arguments: {} } },
    },
  },
  [Method.CHAT_DELETE]: { chatId: 'chat-1', deletedChatIds: ['chat-1'] },
  [Method.CHAT_ARCHIVE]: { chatId: 'chat-1', archivedChatIds: ['chat-1'] },
  [Method.CHAT_ARCHIVE_LIST]: { groups: [], total: 0, page: 1, pageSize: 1, presets: [] },
  [Method.CHAT_BRANCH_PREVIEW]: {
    taskId: 'task-1',
    sourceBranchId: 'branch-1',
    eligible: true,
    sideEffects: [],
    effectDigest: 'digest',
    inheritedCompletedTasks: [],
    inheritedPausedTasks: [],
  },
  [Method.CHAT_BRANCH_CREATE]: {
    branchId: 'branch-2',
    taskId: 'task-1',
    chatId: 'chat-2',
    kind: 'continuation',
    createdAt: 1,
    input,
  },
  [Method.CHAT_BRANCH_ACTIVATE]: {
    taskId: 'task-1',
    activeBranchId: 'branch-1',
    activeChatId: 'chat-1',
    deliveryGeneration: 0,
  },
  [Method.CHAT_ABORT_TASK]: { taskId: 'task-1', abortedBranches: [] },
  [Method.CHAT_CONTEXT_USAGE]: {
    chatId: 'chat-1',
    contextUsage: 0.1,
    contextUsed: 10,
    contextTotal: 100,
    contextBreakdown: {},
  },
  [Method.CHAT_USAGE_DETAIL]: {
    asOf: 1,
    revision: '0',
    summary: {
      taskKey: 'chat-1',
      inputTokens: metric,
      outputTokens: metric,
      totalTokens: metric,
      requests: metric,
      rounds: metric,
      retryCount: metric,
      agentCount: 0,
      capturedSince: null,
      currentRequest: null,
    },
    agents: [],
    cache: {
      readTokens: metric,
      writeTokens: metric,
      reportedRequests: 0,
      hitRequests: 0,
      totalRequests: 0,
    },
    elapsedMs: metric,
    activeMs: metric,
    tools: [],
  },
  [Method.CHAT_USAGE_SUMMARIES]: { asOf: 1, items: [] },
  [Method.CHAT_USAGE_ROUNDS]: { asOf: 1, items: [requestUsage] },
  [Method.CHAT_USAGE_OPERATIONS]: { asOf: 1, items: [] },
  [Method.CHAT_USAGE_DAILY]: {
    asOf: 1,
    from: '2026-01-01',
    to: '2026-01-01',
    timezone: 'UTC',
    capturedSince: null,
    points: [{ date: '2026-01-01', tokens: metric, taskKeys: [], state: 'complete' }],
  },
  [Method.CHAT_USAGE_DAY_TASKS]: { asOf: 1, items: [] },
  [Method.CHAT_CONTEXT_CONTENT]: {
    chatId: 'chat-1',
    snapshotId: 'snapshot-1',
    origin: 'missing',
    contentState: 'missing',
    items: [],
  },
  [Method.CHAT_PROMPT_SNAPSHOT]: { chatId: 'chat-1', systemPrompt: '', tools: [] },
  [Method.CHAT_EPOCH_LIST]: {
    chatId: 'chat-1',
    rootChatId: 'chat-1',
    activeEpochId: 'epoch-1',
    epochs: [epoch],
  },
  [Method.CHAT_INPUT_SUBMIT]: input,
  [Method.CHAT_TIMELINE_GET]: { chatId: 'chat-1', revision: 1, messages: [] },
  [Method.CHAT_TIMELINE_GENERATION_GET]: {
    rootChatId: 'chat-1',
    generation,
    nodes: [node],
    edges: [],
  },
  [Method.CHAT_TIMELINE_NODE_GET]: { rootChatId: 'chat-1', node, refs: [], hasMore: false },
  [Method.CHAT_RUN_RESUME]: {
    chatId: 'chat-1',
    commandId: 'command-1',
    runId: 'run-1',
    status: 'started',
  },
  [Method.CHAT_RESUME_TREE]: {
    rootChatId: 'chat-1',
    pauseId: 'pause-1',
    commandId: 'command-1',
    status: 'completed',
    results: [],
  },
  [Method.CHAT_OPEN]: {
    chatId: 'chat-1',
    subscriptionId: 'subscription-1',
    eventSeq: 0,
    timelineRevision: 0,
    timelineChanged: false,
    state: {
      pendingInputs: [],
      activeTurns: [],
      questionBatches: [],
      runningTools: [],
      executionSteps: [],
      roles: [],
    },
  },
  [Method.CHAT_CLOSE]: { subscriptionId: 'subscription-1', chatId: 'chat-1', closed: true },
  [Method.CHAT_OVERVIEW_OPEN]: {
    subscriptionId: 'subscription-1',
    revision: 0,
    tasks: [
      {
        rootChatId: 'chat-1',
        taskKey: 'chat-1',
        originalChatId: 'chat-1',
        openChatId: 'chat-1',
        title: 'Task',
        status: 'running',
        updatedAt: 1,
        branchCount: 1,
        pendingCount: 0,
        hasFailure: false,
        agents: [],
        recentEvents: [],
        unreadResult: false,
        attentionKey: 'attention-1',
      },
    ],
  },
  [Method.CHAT_OVERVIEW_CLOSE]: { subscriptionId: 'subscription-1', closed: true },
  [Method.CHAT_STOP_CHILD]: {
    rootChatId: 'chat-1',
    commandId: 'command-1',
    results: [childResult],
  },
  [Method.CHAT_ABORT]: { chatId: 'chat-1', aborted: true },
  [Method.INTERACTION_LIST]: { interactions: [interaction] },
  [Method.INTERACTION_APPROVAL_DECIDE]: { interaction: { ...interaction, status: 'completed' } },
  [Method.INTERACTION_QUESTION_ANSWER]: { interaction: { ...interaction, kind: 'question_batch' } },
  [Method.BASH_LIST]: { chatId: 'chat-1', processes: [] },
  [Method.BASH_KILL]: { chatId: 'chat-1', pid: 1, killed: true },
  [Method.MCP_LIST]: { servers: [] },
  [Method.MCP_GET]: { server: {} },
  [Method.MCP_CONNECT]: { server: {} },
  [Method.MCP_DISCONNECT]: { server: {} },
  [Method.MCP_RELOAD]: { servers: [], connected: 0, failed: 0, totalSenses: 0 },
  [Method.CONFIG_GET]: { ...config, baseRevision: 'config-1' },
  [Method.CONFIG_WORKSPACE_VALIDATE]: { valid: true },
  [Method.CONFIG_WORKSPACE_BROWSE_START]: {
    sessionId: 'session-1',
    ttlMs: 1000,
    platform: 'win32',
    sep: '\\',
    roots: [],
    initialPath: '',
    includeFiles: false,
  },
  [Method.CONFIG_WORKSPACE_BROWSE_LIST]: { nonce: '0123456789abcdef', encData: '' },
  [Method.WORKSPACE_FILES_LIST]: { chatId: 'chat', workspace: 'workspace', path: '', entries: [] },
  [Method.WORKSPACE_FILES_READ]: { chatId: 'chat', path: 'a.ts', kind: 'text', content: '', size: 0 },
  [Method.TERMINAL_CREATE]: { sessionId: 'terminal', target: { kind: 'local', label: 'test' }, cols: 80, rows: 24 },
  [Method.TERMINAL_INPUT]: { sessionId: 'terminal', accepted: true },
  [Method.TERMINAL_RESIZE]: { sessionId: 'terminal', cols: 80, rows: 24 },
  [Method.TERMINAL_CLOSE]: { sessionId: 'terminal', closed: true },
  [Method.CONFIG_SAVE]: {
    protocolVersion: 2,
    savedRevision: 'config-1',
    appliedRevision: 'config-1',
    status: 'applied',
    impacts: [],
    restart: { required: false, status: 'none' },
    baseRevision: 'config-1',
    candidateRevisionId: 'revision-1',
    warnings: [],
  },
  [Method.CONFIG_APPLY_STATUS]: {
    protocolVersion: 2,
    savedRevision: 'config-1',
    appliedRevision: 'config-1',
    status: 'applied',
    impacts: [],
    restart: { required: false, status: 'none' },
  },
  [Method.CONFIG_PREVIEW]: {
    protocolVersion: 2,
    baseRevision: 'config-1',
    previewToken: 'preview-1',
    impacts: [],
    destructiveTargets: [],
    policy: 'wait',
  },
  [Method.HOOKS_GET]: { handlers: {}, brainHooks: {}, shellInfo: {} },
  [Method.HOOKS_SAVE]: { ok: true },
  [Method.HOOKS_EVENTS]: { events: [] },
  [Method.UTILS_MODELS]: { models: [] },
  [Method.UTILS_TEST_CONNECTION]: { ok: true },
  [Method.ENV_LIST]: { vars: [] },
  [Method.UTILS_OPEN_FILE]: {},
  [Method.UTILS_OPEN_CONFIG_DIR]: {},
  [Method.UTILS_EDITORS]: { editors: [] },
  [Method.UTILS_MODEL_RECOMMENDATION]: {
    matched: false,
    confidence: 'unknown',
    thinkingLevels: [],
    unknown: {},
  },
  [Method.COMMAND_LIST]: { commands: [] },
  [Method.PLUGINS_LIST]: { plugins: [plugin] },
  [Method.PLUGINS_PRE_IMPORT_URL]: {
    gitNotInstalled: false,
    needsAuth: false,
    branches: [],
    owner: 'owner',
    repo: 'repo',
    suggestedName: 'plugin-1',
    nameConflict: false,
  },
  [Method.PLUGINS_IMPORT_URL]: {
    stagingId: 'stage-1',
    pluginName: 'plugin-1',
    existing: false,
    sourceUrl: 'https://example.test/plugin',
    branch: 'main',
    commitSha: 'abc123',
    commitDate: '2026-08-28T00:00:00.000Z',
    skills: [],
  },
  [Method.PLUGINS_COMMIT]: { plugin },
  [Method.PLUGINS_CHECK_UPDATE]: {
    gitNotInstalled: false,
    needsAuth: false,
    currentSha: 'abc123',
    currentDate: '',
    latestSha: 'abc123',
    lastUpgrade: '',
    updateAvailable: false,
  },
  [Method.PLUGINS_CHECK_ALL_UPDATES]: { checked: 0, updatesAvailable: 0, failed: [] },
  [Method.PLUGINS_UPDATE]: { plugin },
  [Method.PLUGINS_UNINSTALL]: { ok: true },
  [Method.CREDENTIALS_LIST]: { credentials: [credential] },
  [Method.CREDENTIALS_SAVE]: { credential },
  [Method.CREDENTIALS_DELETE]: { ok: true },
}

const explicitlyEmpty = new Set<Method>([Method.UTILS_OPEN_FILE, Method.UTILS_OPEN_CONFIG_DIR])

describe('public RPC response parameter matrix', () => {
  it('defines a valid minimal response for every public method', () => {
    expect(Object.keys(validResponses).sort()).toEqual([...PUBLIC_METHODS].sort())
  })

  it.each(PUBLIC_METHODS)('%s accepts its minimal valid response', (method) => {
    expect(responseFor(method).safeParse(validResponses[method]).success).toBe(true)
  })

  it.each(PUBLIC_METHODS.filter((method) => !explicitlyEmpty.has(method)))(
    '%s rejects a response missing every required field',
    (method) => expect(responseFor(method).safeParse({}).success).toBe(false),
  )

  it('rejects wrong primitive types in representative response families', () => {
    expect(responseSchemas[Method.CHAT_LIST].safeParse({ chats: {} }).success).toBe(false)
    expect(
      responseSchemas[Method.SESSION_RUNTIME_SET].safeParse({
        chatId: 'chat-1',
        applied: 'child-1',
        deferredRunning: [],
      }).success,
    ).toBe(false)
    expect(
      responseSchemas[Method.CREDENTIALS_SAVE].safeParse({ credential: { ...credential, id: 1 } })
        .success,
    ).toBe(false)
  })

  it('rejects invalid lifecycle and interaction discriminators', () => {
    expect(
      responseSchemas[Method.CHAT_INPUT_SUBMIT].safeParse({
        ...input,
        queueSequence: 0,
      }).success,
    ).toBe(false)
    expect(
      responseSchemas[Method.CHAT_RUN_RESUME].safeParse({
        chatId: 'chat-1',
        commandId: 'command-1',
        runId: 'run-1',
        status: 'resumed',
      }).success,
    ).toBe(false)
    expect(
      responseSchemas[Method.INTERACTION_LIST].safeParse({
        interactions: [{ ...interaction, status: 'unknown' }],
      }).success,
    ).toBe(false)
    expect(
      responseSchemas[Method.CHAT_EPOCH_LIST].safeParse({
        chatId: 'chat-1',
        rootChatId: 'chat-1',
        epochs: [
          {
            ...epoch,
            status: 'deleted',
          },
        ],
      }).success,
    ).toBe(false)
    expect(
      responseSchemas[Method.CHAT_EPOCH_LIST].safeParse({
        chatId: 'chat-1',
        rootChatId: 'chat-1',
        epochs: [{ ...epoch, ordinal: -1 }],
      }).success,
    ).toBe(false)
    expect(
      responseSchemas[Method.CHAT_OVERVIEW_OPEN].safeParse({
        subscriptionId: 'subscription-1',
        revision: 0,
        tasks: [
          {
            rootChatId: 'chat-1',
            title: 'Task',
            status: 'unknown',
            updatedAt: 1,
            pendingCount: 0,
            hasFailure: false,
            agents: [],
            recentEvents: [],
          },
        ],
      }).success,
    ).toBe(false)
  })

  it('enforces mutually exclusive response states', () => {
    expect(
      responseSchemas[Method.UTILS_TEST_CONNECTION].safeParse({ ok: true, error: 'unexpected' })
        .success,
    ).toBe(false)
    expect(responseSchemas[Method.UTILS_TEST_CONNECTION].safeParse({ ok: false }).success).toBe(
      false,
    )
    expect(
      responseSchemas[Method.CONFIG_SAVE].safeParse({
        needRestart: false,
        restart: 'immediate',
        validationErrors: [],
        validationWarnings: [],
        rollbackBackup: 'backup.yaml',
      }).success,
    ).toBe(false)
  })

  it('keeps additive fields compatible but strict-empty responses strict', () => {
    expect(
      responseSchemas[Method.CHAT_CREATE].safeParse({ ...runtime, futureField: true }).success,
    ).toBe(true)
    expect(responseSchemas[Method.UTILS_OPEN_FILE].safeParse({ futureField: true }).success).toBe(
      false,
    )
  })
})
