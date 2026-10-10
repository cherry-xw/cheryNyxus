import type { ServerConfig } from './platform'
import type {
  ActiveRunFact as ProtocolActiveRunFact,
  ConversationBranchSummary as ProtocolConversationBranchSummary,
  ExecutionEdgeFact as ProtocolExecutionEdgeFact,
  GenerationEntry as ProtocolGenerationEntry,
  GraphToolCall as ProtocolGraphToolCall,
  PendingInputSnapshot as ProtocolPendingInputSnapshot,
  RootTimelineSnapshot as ProtocolRootTimelineSnapshot,
  TimelineActor as ProtocolTimelineActor,
  TimelineDirection as ProtocolTimelineDirection,
  TimelineNode as ProtocolTimelineNode,
  TreeControlOperationStatus as ProtocolTreeControlOperationStatus,
  TreeControlTarget as ProtocolTreeControlTarget,
  TreeControlTargetStatus as ProtocolTreeControlTargetStatus,
  TreeControlState as ProtocolTreeControlState,
  ChatInputSubmitResponse,
  ChatTimelineResponse,
  TerminationFact as ProtocolTerminationFact,
  LlmProtocol,
} from '@chery/protocol'
import type { ContextBreakdown } from '@/domain/chat/context'
import type {
  RuntimeProvenance,
  RuntimeSelection,
  SessionRuntimeSelection,
} from '@/domain/chat/runtime'
import type { CommandConfigDataDto, CommandConfigDto } from '@/domain/chat/commands'

export type { ContextBreakdown, ContextSegment } from '@/domain/chat/context'
export type {
  RuntimeProvenance,
  RuntimeSelection,
  SessionRuntimeSelection,
} from '@/domain/chat/runtime'
export type { CommandConfigDataDto, CommandConfigDto, ThresholdDto } from '@/domain/chat/commands'



export interface WorkspaceFileEntry {
  name: string
  path: string
  kind: 'file' | 'directory'
  size?: number
  modifiedAt?: number
  extension?: string
}
export interface WorkspaceFilesList {
  chatId: string
  workspace: string
  path: string
  entries: WorkspaceFileEntry[]
  nextOffset?: number
}
export interface WorkspaceFileContent {
  chatId: string
  path: string
  kind: 'text' | 'image' | 'binary'
  mimeType?: string
  content?: string
  size: number
  truncated?: boolean
}
export interface WorkspaceGitStatus { chatId: string; branch: string; branches: string[]; dirty: boolean; files: Array<{ path: string; status: 'added' | 'modified' }> }
export interface TerminalSessionInfo {
  sessionId: string
  target: { kind: 'local' | 'ssh'; label: string }
  cols: number
  rows: number
}

/** 上下文用量单段（镜像后端 utils/token.ts Segment）：tokens = 段 token 估算；count = 条目数（记忆/技能/工具/消息）；thinking = 用户对话段思考拆分（仅 conversation，已含在 tokens 内）。 */
/** 单个工具定义快照（镜像后端 PromptSnapshotTool；统一 OpenAI 形状，剥离 provider 差异）。 */
export interface PromptSnapshotTool {
  name: string
  description: string
  /** 参数 JSON schema；前端弱化展示（折叠 + 字段名/类型/required）。 */
  parameters?: {
    type: 'object'
    properties: Record<string, unknown>
    required: string[]
    additionalProperties: boolean
  }
}

/**
 * 当前态快照（镜像后端 src/service/message/types.ts CurrentStateData）。
 * chat.get / chat.sync / chat.attach response 携带；前端 applyCurrentState 权威 replace StreamState 字段。
 * - pendingApproval：仍存活的挂起审批（approvalManager 内存命中）。run 已 paused 时省略 → 前端显继续按钮。
 *   含 waitTime/createdAt 用于前端算倒计时。
 * - runningTools：已发 sense_end/sense_started 但无 accept/rejected 的工具（含 confirm/manual 待审批）。
 * - currentTodo：最近一条 update_todo 的结构化 todos；无则省略。
 */
export interface CurrentStateData {
  pendingApproval?: {
    approvalId: string
    senseName: string
    arguments: string
    supervisionLevel: number
    waitTime: number
    createdAt: number
    security?: ToolAuthorizationDto
  }
  runningTools: { id: string; senseName: string; security?: ToolAuthorizationDto }[]
  /** 当前 run 的模型/工具计时事实；旧服务端可能省略。 */
  executionSteps?: ExecutionStep[]
  /** 当前活动 run 的持久开始时间；旧服务端可能省略。 */
  runTiming?: { runId: string; startedAt: number }
  currentTodo?: unknown[]
}

/** 可从持久事件重建的执行计时步骤。 */
export interface ExecutionStep {
  id: string
  runId: string
  chatId: string
  kind: 'model' | 'tool'
  name: string
  status: 'running' | 'completed' | 'failed' | 'rejected' | 'cancelled'
  startedAt: number
  completedAt?: number
}

/** chat.list 返回的单条 chat 摘要（对齐后端 listAllChats）。brain/senseGroups 在 metadata.runtime 不暴露于 list。 */
export interface ChatSummary {
  chatId: string
  presetId?: string
  lastUserActivityAt?: number
  /** ms 时间戳（后端 created_at） */
  createdAt?: number
  /** ms 时间戳（后端 updated_at）= 最后运行时间，stage top-5 排序 + 会话列表 last-run 用 */
  updatedAt?: number
  messageCount?: number
  /** 子 chat 关联主 chat；主 chat 为 null。后端 parent_chat_id 列。 */
  parentChatId?: string | null
  activeEpochId?: string
  epochCount?: number
  lifecycle?: 'active' | 'retired' | 'abandoned' | 'archived'
  /** 子 chat 的角色 type 与头像；主 chat 缺省。 */
  agentType?: string
  avatar?: string
  /** 仅 includePreview=true 返：首条 user 消息截断（≤40），会话列表辨识用。CP8 */
  preview?: string
  /** 仅 includePreview=true 返：user 消息数 = 会话轮次。CP8 */
  turnCount?: number
  /** 子 agent 是否已完成（后端 metadata.finished）。前端据 finished===true 重建子 pet 为 ghost。主 chat 恒 undefined。 */
  finished?: boolean
  /** chat 当前是否正在运行（后端 chatRuntimes.get(chatId)?.builder.isRunning()）。前端据此判断子 agent 是否还活着、主 chat 是否卡死。 */
  running?: boolean
  /** 子 chat 唤醒策略（后端 metadata.wake）。immediate/deferred/barrier 三值都表示主本轮 yieldTurn 停等子；前端重连识别等待态子。主 chat 恒 undefined。 */
  wake?: 'immediate' | 'deferred' | 'barrier'
  /** 主 chat 有已持久化但尚未处理的角色回复；前端据此提供显式“继续”入口。 */
  resumePending?: boolean
  /** idle chat 末条非 revoked 消息为未完成周期；前端据此提供显式“继续”入口，不在刷新时自动 resume。 */
  canResume?: boolean
  taskId?: string
  branchId?: string
  branchKind?: 'original' | 'continuation' | 'detail'
  /** 主 chat 创建时所选预设；用于恢复小组角色临时配置面板。 */
  preset?: string
  /** 当前 chat 关联的项目工作目录绝对路径（metadata.workspace 快照）。缺省 → 未配置。 */
  workspace?: string
  /** workspace 路径当前是否为可访问目录。workspace 缺省时 undefined。 */
  workspaceValid?: boolean
  /**
   * 该 chat 当前是否有待用户审批的 sense 调用（后端 ApprovalManager chatId 索引；list 廉价读取，覆盖未 hydrate 会话）。
   * null/缺省 = 无；非空 = 有 in-flight 审批。钢琴键据此跨所有会话闪烁。args 不含（由 active 会话 hydrated interaction.approval 提供）。
   */
  pendingApproval?: {
    approvalId: string
    senseName: string
    waitTime: number
    createdAt: number
  } | null
  /** 待回答问题数量；完整批次仅在打开该根会话后加载。 */
  pendingQuestionCount?: number
  pendingQuestions?: Array<{
    batchId: string
    questionId: string
    header?: string
    question: string
    createdAt: number
  }>
}

export interface ChatEpochSummary {
  epochId: string
  ordinal: number
  label: string
  status: 'active' | 'historical' | 'archived'
  snapshotQuality: 'exact' | 'partial' | 'reconstructed'
  transitionReason: string
  handoffSummary?: string
  executable: boolean
  createdAt: number
  closedAt?: number
}

export interface ConversationRouteTarget {
  chatId: string | null
  confidence: number
  reason: string
}

export interface ConversationRouteTrace {
  context: {
    draft: string
    candidates: Array<{ chatId: string; preview: string; lastUserActivityAt: number }>
  }
  response: {
    content?: string
    toolCall: { name: 'select_conversation'; arguments: ConversationRouteTarget }
  }
}

export interface ConversationRouteSuggestion {
  requestVersion: number
  target: ConversationRouteTarget
  trace: ConversationRouteTrace
}

export interface InteractionRecord {
  interactionId: string
  kind: 'approval' | 'question_batch'
  chatId: string
  rootChatId: string
  presetId?: string
  anchorNodeId?: string
  status: 'pending' | 'resolving' | 'completed' | 'expired' | 'cancelled' | 'blocked'
  payload: Record<string, unknown>
  deadlineAt?: number
  result?: Record<string, unknown>
  revision: number
  createdAt: number
  updatedAt: number
  completedAt?: number
}

export type TaskOverviewStatus =
  'idle' | 'needs_user' | 'running' | 'paused' | 'stopped' | 'failed' | 'completed'

export type TaskResultStatus = 'paused' | 'stopped' | 'failed' | 'completed'

export interface TaskLatestResult {
  resultId: string
  status: TaskResultStatus
  completedAt: number
  content?: string
}

export interface TaskSearchMatch {
  source: 'title' | 'user_prompt' | 'result'
  text: string
  highlights: Array<{ start: number; end: number }>
  branchChatId?: string
}

export interface TaskCatalogItem {
  taskKey: string
  taskId?: string
  originalChatId: string
  openChatId: string
  title: string
  lastUserPrompt?: string
  status: TaskOverviewStatus
  currentStep?: string
  latestResult?: TaskLatestResult
  unreadResult: boolean
  attentionKey: string
  createdAt: number
  updatedAt: number
  branchCount: number
  matches: TaskSearchMatch[]
}

export interface TaskCatalogQuery {
  presetId?: string
  preset?: string
  query?: string
  statuses?: TaskOverviewStatus[]
  updatedFrom?: number
  updatedTo?: number
  sort?: 'updated_desc' | 'created_desc' | 'relevance'
  limit?: number
  cursor?: string
}

export interface TaskAgentOverview {
  chatId: string
  role: string
  status: TaskOverviewStatus | 'idle'
  currentStep?: string
  /** 当前活动步骤类型（标题栏会话状态条 icon 映射：model=思考动画 / tool=sense 图标）。activeStep 存在时透出。 */
  currentStepKind?: 'model' | 'tool'
  startedAt?: number
}

export interface TaskActivityEvent {
  id: string
  rootChatId: string
  chatId: string
  kind:
    | 'run_started'
    | 'model_started'
    | 'tool_started'
    | 'tool_completed'
    | 'agent_spawned'
    | 'agent_completed'
    | 'waiting_user'
    | 'resumed'
    | 'paused'
    | 'failed'
    | 'completed'
  label: string
  at: number
}

export interface TaskOverview {
  rootChatId: string
  taskKey: string
  taskId?: string
  presetId?: string
  preset?: string
  title: string
  /** 末条 user 消息（截断 ≤40，复用 preview 规范化）；无 user 消息时省略。 */
  lastUserPrompt?: string
  status: TaskOverviewStatus
  startedAt?: number
  updatedAt: number
  pendingCount: number
  hasFailure: boolean
  agents: TaskAgentOverview[]
  recentEvents: TaskActivityEvent[]
  originalChatId: string
  openChatId: string
  branchCount: number
  currentStep?: string
  latestResult?: TaskLatestResult
  unreadResult: boolean
  attentionKey: string
}

export interface TaskOverviewSubscription {
  subscriptionId: string
  revision: number
  tasks: TaskOverview[]
}

/** chat.create 参数。预设路径（T6）：preset 给出则后端从预设解析编制，brain/senseGroup 可省；
 * 显式路径：主 agent brain + senseGroup（+ mcpServers?）；子 agent：额外 parentChatId。 */
export interface CreateAgentOptions {
  /** 预设名（T6）：给出则后端从 config.presets[preset].main 解析编制快照，忽略 brain/senseGroup */
  preset?: string
  brain?: string
  senseGroup?: string
  mcpServers?: string[]
  /** 可选，未给则后端生成 */
  chatId?: string
  /** 子 agent 关联主 chat（CP3 子 agent 用） */
  parentChatId?: string
}

/** chat.create 响应：chatId + 实际生效的编制（预设路径由后端解析回填，供前端记 pet.runtime）。 */
export interface CreateAgentResult {
  chatId: string
  presetId?: string
  brain: string
  senseGroup: string
  mcpServers: string[]
  /** 预设创建时的工作区快照；缺省表示未限定。 */
  workspace?: string
  /** workspace 当前是否有效；workspace 缺省时不返回。 */
  workspaceValid?: boolean
  /** 空白复用命中：true = 后端未新建，直接返回了同预设既有的空会话。新建路径缺省。 */
  reused?: boolean
}

export type ApprovalAction = 'accept' | 'reject'

/**
 * brain.list 单条 brain 信息（对齐后端 Agent 1 契约）。
 * contextLimit（token）用于 ContextBar 显示用量。
 */
export interface BrainInfo {
  name: string
  contextLimit?: number
  /** 是否为 config.default.brain（AgentDialog 无 runtime 时预选） */
  default?: boolean
  capabilities?: BrainCapabilitiesDto
  [k: string]: unknown
}

export interface MediaCapabilitiesDto {
  image?: boolean
  video?: boolean
  audio?: boolean
}
export interface BrainCapabilitiesDto {
  toolCall?: boolean
  input?: MediaCapabilitiesDto
  generate?: MediaCapabilitiesDto
}

export interface ModelRecommendationDto {
  matched: boolean
  id?: string
  confidence: 'exact' | 'pattern' | 'unknown'
  facts?: {
    contextWindow?: number
    protocols?: LlmProtocol[]
    capabilities?: BrainCapabilitiesDto
  }
  recommend?: {
    provider?: string
    protocol?: LlmProtocol
    contextLimit?: number
    thinking?: ThinkingLevel
    capabilities?: BrainCapabilitiesDto
  }
  thinkingLevels: ThinkingLevel[]
  unknown: {
    recommend?: {
      protocol?: LlmProtocol
      contextLimit?: number
      thinking?: ThinkingLevel
      capabilities?: BrainCapabilitiesDto
    }
    capabilities?: BrainCapabilitiesDto
  }
}

/** brain.list 响应形状。 */
export interface BrainListResponse {
  brains: BrainInfo[]
  mcpServers: string[]
}

/** sense.tools 响应单项：内置工具元信息（name=原名/key，label=中文名/显示，description=解释/tooltip，icon=glyph/emoji 供 pet bar 运行中工具显示；accepts/produces/preprocess 为工具能力声明）。 */
export interface SenseToolInfo {
  name: string
  label: string
  description: string
  icon: string
  /** 接收的媒体类型（image/video/audio）或文件后缀（doc/docx/pdf…）；供发送门控判断。 */
  accepts?: string[]
  /** 产出的媒体类型（image/video/audio）或 text */
  produces?: string[]
  /** 是否前置执行（缺省 false = 普通后置工具） */
  preprocess?: boolean
}

/** sense.tools.docs 响应单项：内置工具完整说明文档（【作用】【能力】【边界】【注意】分节，换行分隔，hover 展示）。 */
export interface SenseToolDocInfo {
  name: string
  doc: string
}

/**
 * 命令元信息（command.list / command.read 通用）。
 * 后端读 .chery/command/<name>.md frontmatter + 正文；
 * 缺少 frontmatter 时 description === ""，但 name 仍可填（取 basename）。
 */
export interface CommandInfo {
  name: string
  description: string
  content: string
}

/** skills.list 单项：用户 `.chery/skills/` 独立技能 + `.chery/plugins/` 插件技能元数据（不含正文 content）。 */
export interface SkillInfo {
  name: string
  description: string
  trigger?: string
  /** SKILL.md frontmatter 中用户自定义字段（version 等），key 为原字段名。 */
  extra?: Record<string, unknown>
  /** 激活完整技能指令后预计新增的上下文 token（= 系统提示词 + 内容提示词之和）。 */
  contextTokens: number
  /** 系统提示词占用：注入 system prompt `<skills>` XML 的 name+description token。 */
  nameDescTokens: number
  /** 系统提示词占用：trigger 行 token（无 trigger 则缺省）。 */
  triggerTokens?: number
  /** 内容提示词占用：激活后加载的技能正文 token。 */
  contentTokens: number
  /** JSON 序列化全字段（含 extra）的 token（按设计用作正文段 token 计算）。 */
  promptTokens?: number
  /** 来源插件名（undefined = 独立 skill；否则插件技能，name 形如 `<plugin>__<skill>`）。 */
  plugin?: string
}

/** skill 导入候选（两阶段 stage 产物；conflict=true 需前端逐项确认覆盖/跳过）。 */
export interface SkillCandidate {
  name: string
  description: string
  trigger?: string
  conflict: boolean
}

/** skill 导入 stage 结果（ZIP HTTP 与 skills.importUrl 共用）。 */
export interface SkillStageResult {
  stagingId: string
  candidates: SkillCandidate[]
}

/** skills.commit 单项选择：import=false 跳过；true 导入（冲突则覆盖）。 */
export interface SkillCommitSelection {
  name: string
  import: boolean
}

/** skills.preImportUrl 响应（拉分支 + needsAuth/gitNotInstalled 探测；无 suggestedName/nameConflict）。 */
export interface SkillPreImportResult {
  gitNotInstalled: boolean
  needsAuth: boolean
  branches: string[]
  defaultBranch?: string
}
/** skills.importUrl 入参（分支 required；credentialId 与 inline username/password 互斥）。 */
export interface SkillImportRequest {
  url: string
  branch: string
  credentialId?: string
  username?: string
  password?: string
  remember?: boolean
  label?: string
  /** 网络代理（http(s)://host:port）；缺省直连，填则注入 git http(s).proxy。 */
  proxy?: string
}
/** skills.importUrl 响应（stage 候选 + 分支/SHA/日期/savedCredentialId；zip 上传无后四项）。 */
export interface SkillImportResponse extends SkillStageResult {
  branch?: string
  commitSha?: string
  commitDate?: string
  savedCredentialId?: string
}
/** skills git 来源索引项（.chery/.skill-sources.json 单条；skills 实时读 skills_dir 元数据）。 */
export interface SkillSource {
  id: string
  cloneUrl: string
  branch: string
  credentialId?: string
  commitSha: string
  commitDate: string
  lastSyncedAt: string
  /** 最近一次 resyncAllSources 失败信息（成功时清除）。来源索引持久化，跨 Settings 重开仍可见。 */
  lastSyncError?: string
  lastCheckedAt?: string
  latestSha?: string
  latestDate?: string
  updateAvailable?: boolean
  lastCheckError?: string
  skillCount: number
}
/** skills.resyncSource 响应（重 clone + 重弹候选；前端预勾选原已导入）。 */
export interface SkillResyncResult extends SkillStageResult {
  branch: string
  commitSha: string
  commitDate: string
  sourceId: string
  selected: string[]
}

/** 插件内技能元信息（plugins.list 展示；name 为对外名 `<plugin>__<skill>`）。 */
export interface PluginSkillInfo {
  name: string
  description: string
  trigger?: string
  /** 系统提示词占用：name+description（≈ 常驻）。 */
  nameDescTokens: number
  /** 系统提示词占用：trigger 行（命中内置工具才会计）。 */
  triggerTokens?: number
  /** 内容提示词占用：激活后正文 token（正文最大/最小由此聚合）。 */
  contentTokens: number
}

/** 插件信息（.chery/plugins/<name>/.chery-plugin.json manifest + 内含 skills）。 */
export interface PluginInfo {
  name: string
  sourceUrl: string
  /** clone 用的 https gitUrl（manifest.cloneUrl；旧 manifest 缺省为空串）。 */
  cloneUrl: string
  /** 所选分支名（旧 manifest 缺省为空串，update/checkUpdate 时回退 main）。 */
  branch: string
  /** 落盘时 HEAD SHA（旧 manifest 缺省为空串，checkUpdate 视为「有更新」）。 */
  commitSha: string
  /** 落盘时 HEAD 提交时间 ISO（旧 manifest 缺省为空串）。 */
  commitDate: string
  installedAt: string
  updatedAt: string
  /** 最近一次检查更新时间（manifest 持久化）；从未检查为 undefined。 */
  lastCheckedAt?: string
  /** 远端最新 HEAD 短 SHA（最近一次检查写入）；未检查为 undefined。 */
  latestSha?: string
  /** 远端最新提交时间（最近一次检查写入）；私有仓 401 或未检查为 undefined。 */
  latestDate?: string
  /** 有可用更新（最近一次检查写入）；未检查为 undefined。前端据此显隐 refresh 按钮。 */
  updateAvailable?: boolean
  /** 最近一次 checkUpdate 失败信息（成功时清除）；manifest 持久化，跨 Settings 重开仍可见。 */
  lastCheckError?: string
  /** 全部技能的系统提示词消耗合计（Σ nameDescTokens + triggerTokens）。 */
  totalSystemTokens: number
  /** 全部技能的正文 token 最小值（min contentTokens）。 */
  minContentTokens: number
  /** 全部技能的正文 token 最大值（max contentTokens）。 */
  maxContentTokens: number
  skills: PluginSkillInfo[]
}

/** 凭据池条目（密令永不回前端；镜像后端 CredentialListItemDTO）。 */
export interface CredentialListItemDTO {
  id: string
  label: string
  username: string
  createdAt: string
}

/** plugins.preImportUrl 响应（解析 URL + 拉 branches + needsAuth/gitNotInstalled 探测）。 */
export interface PluginPreImportResult {
  gitNotInstalled: boolean
  needsAuth: boolean
  branches: string[]
  defaultBranch?: string
  owner: string
  repo: string
  /** 建议的插件文件夹名（= sanitizeName(repo)）；前端预填「文件夹名」输入框。 */
  suggestedName: string
  /** 该文件夹名已存在 → 前端展示「文件夹名」输入框供改名。 */
  nameConflict: boolean
}

/** plugins.importUrl 入参（分支 required；credentialId 与 inline username/password 互斥）。 */
export interface PluginImportRequest {
  url: string
  branch: string
  /** 选用凭据池 id（与 username/password 互斥）。 */
  credentialId?: string
  /** inline 鉴权（与 credentialId 互斥）。 */
  username?: string
  password?: string
  /** inline 鉴权时是否加密入池（响应返 savedCredentialId）。 */
  remember?: boolean
  /** inline + remember 时新凭据的 label（缺省后端用 owner/repo 派生）。 */
  label?: string
  /** 插件文件夹名覆盖（preImport nameConflict=true 时由前端提供）。 */
  pluginName?: string
  /** 网络代理（http(s)://host:port）；缺省直连，填则注入 git http(s).proxy。 */
  proxy?: string
}

/** plugins.importUrl 响应（staging 预览：分支 + SHA + 日期 + 冲突标记）。 */
export interface PluginImportPreview {
  stagingId: string
  pluginName: string
  existing: boolean
  sourceUrl: string
  branch: string
  commitSha: string
  commitDate: string
  /** inline + remember 成功入池时回填的新凭据 id。 */
  savedCredentialId?: string
  skills: PluginSkillInfo[]
}

/** plugins.checkUpdate 响应（manifest HEAD vs 远端分支 HEAD 对比）。 */
export interface PluginCheckUpdateResult {
  gitNotInstalled: boolean
  needsAuth: boolean
  currentSha: string
  currentDate: string
  latestSha: string
  /** 私有仓或 GitHub API 不可达时缺省。 */
  latestDate?: string
  lastUpgrade: string
  updateAvailable: boolean
}

/** /api/config 返回形状（FAB default + AgentDialog senseGroups 全名单 + default 标记，后端 Agent B 暴露）。 */
export interface SenseGroupOption {
  name: string
  /** 是否在 config.default.senseGroups 内（AgentDialog 无 runtime 时预选） */
  default: boolean
}

/** /api/config 暴露的预设项（T6，FAB 预设选择用）。 */
export interface PresetOption {
  name: string
  /** 组长角色名（leader） */
  leader: string
  /** leader 角色的 brain（默认 brain，每轮可覆盖） */
  brain: string
  /** 角色类型键（能力体现） */
  roles: string[]
}

export interface ConfigDefault extends ServerConfig {
  /** 派生自「默认」预设 leader 角色（AgentDialog 无 runtime 时预选用；FAB 不再用） */
  default?: RuntimeSelection
  /** 可用 senseGroups 全名单 + default 标记（= 是否在「默认」预设 main.senseGroups 内；缺省回退 [{name:"default", default:true}]） */
  senseGroups?: SenseGroupOption[]
  /** 可用预设名单（T6 FAB 预设选择用；缺省 = 无预设） */
  presets?: PresetOption[]
  sessionToken?: string
}

export interface UploadedMediaAsset {
  id: string
  kind: 'image' | 'video' | 'audio'
  mimeType: string
  filename: string
  size: number
  url: string
}

/** P4：chat.send 结构化附件（与后端 ChatSendAttachment 对齐）。assetId=UploadedMediaAsset.id。 */
export interface ChatSendAttachment {
  assetId: string
  kind: 'image' | 'video' | 'audio'
  mimeType: string
}

/** Chat Protocol V2：后端已构建完成的权威时间线消息。 */
export interface CanonicalSenseCall {
  id: string
  name: string
  arguments?: string
  result?: string
  status?: 'pending' | 'accepted' | 'rejected' | 'completed'
  /** 工具调用的安全授权判定（历史时间线渲染风险徽章；缺省 = 无判定） */
  security?: ToolAuthorizationDto
  [key: string]: unknown
}

export interface CanonicalMessage {
  id: string
  chatId: string
  runId?: string
  role: 'user' | 'assistant' | 'sense' | 'role' | 'master'
  content: string
  thinking?: string
  createdAt: number
  updatedAt: number
  status: 'committed' | 'revoked'
  runtime?: RuntimeProvenance
  senseCalls?: CanonicalSenseCall[]
  origin?: {
    parentChatId?: string
    childChatId?: string
    spawnCallId?: string
  }
  /** wakeParent 注入的子返回（child_return 链接）；前端据此标 mergedView 从主轴过滤。 */
  childReturn?: boolean
  [key: string]: unknown
}

export interface TimelineSnapshot extends ChatTimelineResponse<
  CanonicalMessage,
  RootTimelineSnapshot
> {
  chatId: string
  revision: number
  messages: CanonicalMessage[]
  nextCursor?: string
  eventSeq?: number
  rootTimeline?: RootTimelineSnapshot
  /** root 路径 knownRevision 短路时为 true，此时无 messages/rootTimeline */
  unchanged?: boolean
}

export type TimelineActor = ProtocolTimelineActor

export type TimelineDirection = ProtocolTimelineDirection

// ---- wire 事实类型（单一事实源在 @chery/protocol/timeline；此处别名转发保持既有 import 路径） ----
export type GraphToolCall = ProtocolGraphToolCall

export type TerminationFact = ProtocolTerminationFact

export type TreeControlOperationStatus = ProtocolTreeControlOperationStatus
export type TreeControlTargetStatus = ProtocolTreeControlTargetStatus
export type TreeControlTarget = ProtocolTreeControlTarget
export type TreeControlState = ProtocolTreeControlState
export interface TreeResumeResponse {
  rootChatId: string
  pauseId: string
  commandId: string
  status: TreeControlOperationStatus
  results: TreeControlTarget[]
}
export interface ChildControlTargetResult {
  chatId: string
  previousState: 'running' | 'paused' | 'finished' | 'failed' | 'redirected'
  state: 'running' | 'paused' | 'finished' | 'failed' | 'redirected'
  outcome: 'stopped' | 'queued' | 'resumed' | 'unchanged' | 'rejected' | 'failed'
  runId?: string
  messageId?: string
  detail?: string
}
export interface ChatAbortResponse {
  chatId: string
  pauseId?: string
  status?: TreeControlOperationStatus
  runId?: string
  aborted: boolean
  cascaded?: number
  results?: ChildControlTargetResult[]
}

export type TimelineNode = ProtocolTimelineNode

export interface TimelineNodeDetailResponse {
  rootChatId: string
  node: TimelineNode
  refs: Array<{ field: string; contentLength: number; contentHash: string }>
  hasMore: boolean
  page?:
    | { section: 'content' | 'thinking'; offset: number; consumed: number; nextOffset?: number }
    | {
        section: 'toolCalls'
        cursor: { callIndex: number; field: 'arguments' | 'result'; offset: number }
        consumed: number
        nextCursor?: { callIndex: number; field: 'arguments' | 'result'; offset: number }
      }
}

export type ExecutionEdgeKind =
  | 'sequence'
  | 'spawn'
  | 'continue'
  | 'dispatch'
  | 'return'
  | 'return-continuation'
  | 'fork-continuation'
  | 'fork-detail'

export type ExecutionEdgeFact = ProtocolExecutionEdgeFact

export type ConversationBranchSummary = ProtocolConversationBranchSummary

export type ActiveRunFact = ProtocolActiveRunFact

export type GenerationEntry = ProtocolGenerationEntry

export type RootTimelineSnapshot = ProtocolRootTimelineSnapshot

/** chat.timeline.generation.get 响应：单个已打包代际的完整图。 */
export interface TimelineGenerationSnapshot {
  rootChatId: string
  generation: GenerationEntry
  nodes: TimelineNode[]
  edges: ExecutionEdgeFact[]
}

export type TimelinePatchOperation =
  | { type: 'upsert'; message: CanonicalMessage }
  | { type: 'revoke'; messageId: string }
  | { type: 'remove'; messageId: string }

export interface TimelinePatch {
  chatId: string
  baseRevision: number
  revision: number
  operations: TimelinePatchOperation[]
  eventSeq?: number
  rootPatch?: RootTimelinePatch
  rootPatches?: RootTimelinePatch[]
}

export type RootTimelinePatchOperation =
  | { type: 'upsert'; node: TimelineNode }
  | { type: 'revoke'; nodeId: string }
  | { type: 'remove'; nodeId: string }
  | { type: 'upsert-edge'; edge: ExecutionEdgeFact }
  | { type: 'remove-edge'; edgeId: string }
  | { type: 'upsert-run'; run: ActiveRunFact }
  | { type: 'remove-run'; chatId: string; runId: string }
  | { type: 'upsert-input'; input: PendingInput }
  | { type: 'remove-input'; inputId: string }

export interface RootTimelinePatch {
  rootChatId: string
  view: RootTimelineSnapshot['view']
  baseRevision: number
  revision: number
  operations: RootTimelinePatchOperation[]
  controlState?: TreeControlState
}

export type PendingInput = ProtocolPendingInputSnapshot

export interface ActiveTurnSnapshot {
  chatId?: string
  turnId: string
  runId?: string
  messageId: string
  thinking: string
  content: string
  nextThinkingOffset?: number
  nextContentOffset?: number
  thinkingOffset?: number
  contentOffset?: number
  status?: 'running' | 'completed' | 'paused' | 'error'
  createdAt?: number
}

export interface RunSnapshot {
  chatId?: string
  runId: string
  status?: 'running' | 'waiting' | 'paused' | 'completed' | 'failed' | string
  state?: 'running' | 'waiting' | 'paused' | 'completed' | 'failed' | string
  /** run 第一次进入 running 的时间戳。 */
  startedAt?: number
  /** 本次 run 状态变化的时间戳。 */
  at?: number
  /** done/error 兼容事件携带的终态时间戳。 */
  completedAt?: number
  [key: string]: unknown
}

export interface ChatOpenResponse {
  chatId: string
  subscriptionId: string
  eventSeq: number
  timelineRevision: number
  timelineChanged: boolean
  /** root 路径 knownTimelineRevision 短路：省略 rootTimeline（state/subscriptionId 照常） */
  timelineUnchanged?: boolean
  rootTimeline?: RootTimelineSnapshot
  state: {
    chatIds?: string[]
    run?: RunSnapshot
    runs?: RunSnapshot[]
    pendingInputs: PendingInput[]
    activeTurns: ActiveTurnSnapshot[]
    executionSteps?: ExecutionStep[]
    pendingApproval?: unknown
    questionBatches?: unknown[]
    runningTools?: unknown[]
    roles?: unknown[]
    [key: string]: unknown
  }
}

export interface ChatSessionEvent {
  kind?: 'event' | 'session'
  type: string
  chatId: string
  subscriptionId?: string
  eventSeq: number
  data?: unknown
  [key: string]: unknown
}

export type InputAccepted = ChatInputSubmitResponse

/** 思考强度档位（对齐后端 ThinkingLevel）：
 * - off：关闭
 * - on：由模型/服务端决定（不传参）
 * - low/medium/high/xhigh：强度递增
 * - 任意字符串：来自 `.chery/model-catalog.yaml` wire 的原样档位（如 DeepSeek 的 `max`）。
 *   `(string & {})` 保留自动补全又允许任何 string 通过编译。
 */
export type ThinkingLevel = 'off' | 'on' | 'low' | 'medium' | 'high' | 'xhigh' | (string & {})

/** config.get 响应 / config.save 入参：.chery/config.yaml 原文（除 server 段）。对齐后端 ConfigRaw。 */
export interface BrainConfigDto {
  url?: string
  model: string
  key?: string
  thinking?: ThinkingLevel
  provider: string
  protocol?: LlmProtocol
  rpm?: number
  /** true=URL 已含版本段（如 /v1），provider 只拼 endpoint 不自动补全；缺省自动补全（无路径时补 /v1） */
  fullUrl?: boolean
  mock?: { enabled?: boolean; file: string }
  contextLimit?: number
  capabilities?: BrainCapabilitiesDto
  /** Anthropic provider 兼容选项：3rd-party coding-plan 代理通常不实现 redacted_thinking。
   *  默认 false（safe strip）；真官方 Anthropic 用户置 true 启用完整协议。 */
  anthropicCompat?: {
    /** true=完整协议（保留 redacted_thinking 原样回传）；false=strip（默认） */
    official?: boolean
  }
}

/** 编辑器信息（对齐后端 UtilsEditorsResponseData.editors[]） */
export interface EditorInfo {
  /** 显示名称（如 "Visual Studio Code"） */
  name: string
  /** 启动命令（如 "code"、"notepad"、"gedit"） */
  command: string
  /** 是否在系统 PATH 中可用 */
  available: boolean
}

export interface McpServerConfigDto {
  transport: 'stdio' | 'streamable-http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  supervision?: 'auto' | 'smart' | 'manual'
}

export type RolePermissionEffectDto = 'inherit' | 'allow' | 'ask' | 'deny'
export interface SecurityFindingDto {
  code: string
  category: string
  severity: 'low' | 'medium' | 'high' | 'unknown'
  message: string
  fragment?: string
  start?: number
  end?: number
}
export interface ToolAuthorizationDto {
  decision: 'allow' | 'ask' | 'deny'
  roleType: string
  policyHash: string
  requiredSandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access'
  findings: SecurityFindingDto[]
  assessmentHash: string
}
export interface RolePermissionPolicyDto {
  template: 'read-only' | 'workspace-developer' | 'supervised' | 'trusted'
  tools?: Record<string, RolePermissionEffectDto>
  filesystem?: {
    read?: 'deny' | 'workspace' | 'any'
    write?: 'deny' | 'workspace' | 'any-with-approval'
  }
  commands?: {
    shells?: Array<'bash' | 'powershell'>
    maxSandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access'
    categories?: Record<string, RolePermissionEffectDto>
  }
  mcp?: { default?: RolePermissionEffectDto; tools?: Record<string, RolePermissionEffectDto> }
  spawn?: { allowedRoles?: string[]; effect?: RolePermissionEffectDto }
}

/** 阈值线型（对齐后端 utils/config.ts Threshold）：tokens 绝对值 / percent 0..1 占比。 */
export interface GlobalConfigDto {
  thinking: boolean
  supervision: 'auto' | 'smart' | 'manual'
  stream: boolean
  sense_execute_timeout?: number
  /** 审批等待超时（ms）。`>= 0`，0 = 不限时。详见 `InterruptNotificationData.waitTime`。 */
  approval_timeout?: number
  /** 单次模型请求硬限时（毫秒）；默认 600000，0 = 不限制。 */
  llm_request_timeout_ms?: number
  maxLoopCount?: number
  bash_log_retention_hours?: number
  textEditor?: string // 文本编辑器路径
  file_compression?: {
    truncate_threshold?: number
    truncate_preview_lines?: number
    log_file_extensions?: string[]
    drain_preview_count?: number
  }
  logger?: {
    level?: 'debug' | 'info' | 'warn' | 'error' | 'silent'
    output?: ('console' | 'file')[]
    timestamp?: boolean
    location?: boolean
    format?: 'plain' | 'json'
  }
  /** 内置命令（compact 等）阈值与可见性配置。 */
  command?: CommandConfigDto
  /**
   * 看门狗配置（子 agent feed-dog 监控，对应后端 global.watchdog）。
   * - timeout_ms：子无产出超此值判定卡死，默认 300000（5min）。
   * - wake_on_timeout：超时是否唤主。true=通知主；false=仅暂停子，默认 false。
   */
  watchdog?: { timeout_ms?: number; wake_on_timeout?: boolean }
  /** 节点树全量渲染阈值（节点数≤此值跳过视口裁剪避免平移卡顿；0=始终裁剪）。 */
  tree_full_render_threshold?: number
}

/** 预设（对齐后端 PresetConfig）：选中的角色 type 列表（引用 config.roles 单一源）+ 指定组长 */
export interface PresetDto {
  /** Stable preset workspace identity; generated for legacy configs when read. */
  id?: string
  shadows?: { conversationRouting?: string }
  detailRole?: string
  /** 组长角色 type 名（必填，主 pet 编制取 config.roles[leader]） */
  leader: string
  /** 选中的角色 type 名 */
  roles?: string[]
  /** 项目工作目录绝对路径（system prompt 提示词注入 <workspace> 段；不约束 sense 行为）。缺省 → 不注入 */
  workspace?: string
  /** smart 监管规则覆盖文件名（.chery/rule/ 下，不含 base.yaml；与基准深合并）。缺省 → 仅用基准 */
  rule?: string
}

export interface ConfigDto {
  global: GlobalConfigDto
  llm: { brain: Record<string, BrainConfigDto> }
  sense_groups?: Record<string, string[]>
  mcp_servers?: Record<string, McpServerConfigDto>
  roles?: Record<
    string,
    {
      kind?: 'role' | 'shadow'
      /** 角色稳定身份 id（legacyRoleId 自动补全；改名保持不变，历史 chat roleId 据此反查当前名） */
      id?: string
      brain: string
      avatar?: string
      description?: string
      mentionable?: boolean
      senseGroup: string
      mcpServers?: string[]
      systemPrompt?: string
      skills?: string[]
      plugins?: string[]
      permissions?: RolePermissionPolicyDto
      lock?: boolean
      /** 角色归属域：public 公共角色（全局共享、可被任意预设引用，组长不能是公共角色）；缺省/private 为预设内私有角色 */
      scope?: 'public' | 'private'
    }
  >
  presets?: Record<string, PresetDto>
  /** 项目记忆配置（双层：global 跨 chat 共享 · workspace per chat）；缺省 global {30,500} / workspace {15,500} */
  memory?: {
    global?: { max_count?: number; max_chars?: number }
    workspace?: { max_count?: number; max_chars?: number }
  }
}

/** config.workspace.browse.start 响应：服务端文件夹浏览会话。 */
export interface ConfigWorkspaceBrowseStart {
  sessionId: string
  ttlMs: number
  platform: string
  sep: '/' | '\\'
  roots: Array<{ path: string; name: string }>
  initialPath: string
  includeFiles: boolean
  error?: string
}

/** config.workspace.browse.list 解密后的载荷（encData 明文形态）。 */
export interface BrowseListPayload {
  path: string
  accessible: boolean
  error?: string
  entries: Array<{ name: string; path: string; isDir: boolean; accessible: boolean }>
}

/** hooks handler 传输对象（对齐后端 HooksHandlerDTO）*/
export interface HookHandlerDTO {
  matcher?: string
  if?: string
  command: string
  timeout?: number
}

/** hooks.get 响应：全局 hooks + brain 级只读 hooks + handler 执行器平台状态 */
export interface HooksShellInfo {
  /** 服务进程平台（process.platform）*/
  platform: string
  /** 是否解析到可用 POSIX shell */
  available: boolean
  /** available=true 时解析到的 shell（PATH 名或绝对路径）*/
  executable?: string
  /** available=false 时的安装指引 */
  hint?: string
}

export interface HooksGetResult {
  handlers: Record<string, HookHandlerDTO[]>
  brainHooks: Record<string, Record<string, HookHandlerDTO[]>>
  shellInfo: HooksShellInfo
}

/** hooks.events 响应：事件元数据 */
export interface HookEventMeta {
  name: string
  label?: string
  description: string
  /** 该事件 handler 能做的能力（前端 chip 展示）*/
  capabilities: string[]
  /** matcher 比对的 payload 字段名（提示用户 matcher 匹配什么）*/
  matcherField?: string
}

/** RPC 错误构造：完整透传公共结构化错误，供 store/reducer 和通知层可靠分支。 */
