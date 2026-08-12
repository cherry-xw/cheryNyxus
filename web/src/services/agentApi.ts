/**
 * agentApi：基于 wsClient.rpc / rpcTrack 的高层 RPC 封装。
 * CP1 骨架：方法签名定好，错误抛出由调用方（agents store）处理。
 * 流式方法（sendMessage/getHistory）暴露 requestId 供 chunk 路由。
 *
 * 协议见 docs/protocol.md。方法：chat.* / runtime.set / sense.approval / brain.list。
 */
import { wsClient } from './ws'
import type { RpcResponse } from './ws'
import { httpUrl } from './http'

/**
 * 凭据类 .env 变量名后缀白名单：仅 API_KEY / APIKEY / TOKEN / SECRET(_KEY) /
 * PASSWORD / PASSWD / ACCESS_KEY(_ID) 视为可作密钥占位（`$VAR`）的凭据。
 * 运行时配置（CHERY_DIR / *_HOST / *_URL / PORT / NODE_ENV 等）不进密钥下拉。
 */
const SECRET_SUFFIX =
  /(?:^|_)(?:API_?KEY|TOKEN|SECRET(?:_KEY)?|PASSWORD|PASSWD|ACCESS_?KEY(?:_ID)?)$/
function isSecretEnvVarName(name: string): boolean {
  return SECRET_SUFFIX.test(name)
}

/** 上下文用量单段（镜像后端 utils/token.ts Segment）：tokens = 段 token 估算；count = 条目数（记忆/技能/工具/消息）；thinking = 用户对话段思考拆分（仅 conversation，已含在 tokens 内）。 */
export interface ContextSegment {
  tokens: number
  count?: number
  thinking?: number
}

/** 上下文用量 6 段分解（镜像后端 utils/token.ts ContextBreakdown）。 */
export interface ContextBreakdown {
  system: ContextSegment
  userSystem: ContextSegment
  memory: ContextSegment
  skills: ContextSegment
  tools: ContextSegment
  conversation: ContextSegment
  total: number
  usage: number
}

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
  }
  runningTools: { id: string; senseName: string }[]
  currentTodo?: unknown[]
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
  /** 子 chat 的角色 type 与头像；主 chat 缺省。 */
  agentType?: string
  avatar?: string
  /** 仅 includePreview=true 返：首条 user 消息截断（≤40），会话列表辨识用。CP8 */
  preview?: string
  /** 仅 includePreview=true 返：user 消息数 = 会话轮次。CP8 */
  turnCount?: number
  /** 仅 includePreview=true 返：上下文 token 用量比例（0-1）。SessionList 渲染用。 */
  contextUsage?: number
  /** 仅 includePreview=true 返：已用 token 数（估算值）。配合 contextTotal 显示详情。 */
  contextUsed?: number
  /** 仅 includePreview=true 返：上下文上限 token 数。 */
  contextTotal?: number
  /** 仅 includePreview=true 返：上下文用量 6 段分解（系统/用户系统/记忆/技能/工具定义/用户对话）。 */
  contextBreakdown?: ContextBreakdown
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

export interface ConversationRouteCandidate {
  chatId: string | null
  confidence: number
  reason: string
}

export interface ConversationRouteSuggestion {
  requestVersion: number
  candidates: ConversationRouteCandidate[]
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
}

/** runtime.set 选择（每轮可换 brain + 单一工具组）。 */
export interface RuntimeSelection {
  brain: string
  /** 无 Tool Call 模型使用空字符串。 */
  senseGroup: string
  mcpServers?: string[]
}

/** 当前会话临时角色编制；服务重启后自动失效，不写入会话默认配置。 */
export interface SessionRuntimeSelection {
  primary: RuntimeSelection
  roles: Record<string, RuntimeSelection>
}

export type ApprovalAction = 'accept' | 'reject'

/**
 * brain.list 单条 brain 信息（对齐后端 Agent 1 契约）。
 * contextLimit（token）用于 ContextBar 显示用量。
 */
export interface BrainInfo {
  name: string
  contextLimit: number
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

/** brain.list 响应形状。 */
export interface BrainListResponse {
  brains: BrainInfo[]
  mcpServers: string[]
}

/** sense.tools 响应单项：内置工具元信息（name=原名/key，label=中文名/显示，description=解释/tooltip，icon=glyph/emoji 供 pet bar 运行中工具显示）。 */
export interface SenseToolInfo {
  name: string
  label: string
  description: string
  icon: string
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

/** skills.list 单项：用户 `.chery/skills/` 独立技能 + `.chery/plugins/` 插件技能元数据。 */
export interface SkillInfo {
  name: string
  description: string
  trigger?: string
  /** 激活完整技能指令后预计新增的上下文 token（= 系统提示词 + 内容提示词之和）。 */
  contextTokens: number
  /** 系统提示词占用：注入 system prompt `<skills>` XML 的 name+description token。 */
  nameDescTokens: number
  /** 系统提示词占用：trigger 行 token（无 trigger 则缺省）。 */
  triggerTokens?: number
  /** 内容提示词占用：激活后加载的技能正文 token。 */
  contentTokens: number
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

export interface ConfigDefault {
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
  runtime?: RuntimeSelection
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

export interface TimelineSnapshot {
  chatId: string
  revision: number
  messages: CanonicalMessage[]
  nextCursor?: string
  eventSeq?: number
  rootTimeline?: RootTimelineSnapshot
}

export type TimelineActor =
  | { kind: 'user'; actorId: 'human'; displayName?: string }
  | { kind: 'agent'; chatId: string; roleType?: string; avatarKey?: string }
  | { kind: 'tool'; toolName: string }
  | { kind: 'system' }

export type TimelineDirection =
  'user-to-agent' | 'agent-to-user' | 'parent-to-child' | 'child-to-parent' | 'internal'

export interface GraphToolCall {
  callId: string
  index: number
  name: string
  arguments: string
  result?: string
  status: 'pending' | 'accepted' | 'rejected' | 'completed' | 'error'
  childChatId?: string
  targetChatId?: string
}

export interface TerminationFact {
  actor: 'user' | 'system' | 'agent'
  code: 'user_abort' | 'system_stop' | 'watchdog' | 'error' | 'agent_redirect'
  at: number
  detail?: string
  controlOperationId?: string
}

export type TreeControlOperationStatus =
  | 'pausing'
  | 'paused'
  | 'resuming'
  | 'partial'
  | 'completed'
  | 'superseded'
export type TreeControlTargetStatus =
  | 'paused'
  | 'resuming'
  | 'resumed'
  | 'delegated'
  | 'skipped'
  | 'failed'
export interface TreeControlTarget {
  chatId: string
  pausedRunId: string
  status: TreeControlTargetStatus
  resumeRunId?: string
  detail?: string
}
export interface TreeControlState {
  pauseId: string
  rootChatId: string
  status: TreeControlOperationStatus
  createdAt: number
  updatedAt: number
  targets: TreeControlTarget[]
}
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

export interface TimelineNode {
  id: string
  rootChatId: string
  sourceChatId: string
  sourceMessageId?: string
  kind: 'message' | 'tool-batch' | 'return' | 'dispatch' | 'system' | 'tool-group' | 'spawn'
  actor: TimelineActor
  target?: TimelineActor
  direction: TimelineDirection
  visibility: 'conversation' | 'detail' | 'internal'
  content: string
  thinking?: string
  /** 消息执行时的 runtime；assistant 继承同 chat 前一条 user 消息的快照。 */
  runtime?: RuntimeSelection
  toolCalls?: GraphToolCall[]
  batchId?: string
  orderKey: number
  termination?: TerminationFact
  /** Legacy read compatibility only. */
  parentNodeId?: string
  causationId?: string
  createdAt: number
  updatedAt: number
  status: 'committed' | 'revoked'
  taskId?: string
  branchId?: string
  branchKind?: 'original' | 'continuation' | 'detail'
  forkAnchor?: boolean
}

export type ExecutionEdgeKind =
  'sequence' | 'spawn' | 'continue' | 'dispatch' | 'return' | 'return-continuation' |
  'fork-continuation' | 'fork-detail'

export interface ExecutionEdgeFact {
  id: string
  rootChatId: string
  fromNodeId: string
  toNodeId: string
  kind: ExecutionEdgeKind
  orderKey: number
  sourceChatId: string
  targetChatId: string
  callId?: string
  taskId?: string
  branchId?: string
}

export interface ConversationBranchSummary {
  branchId: string
  taskId: string
  chatId: string
  kind: 'original' | 'continuation' | 'detail'
  sourceBranchId?: string
  anchorRootChatId?: string
  anchorNodeId?: string
  title?: string
  createdAt: number
}

export interface ActiveRunFact {
  rootChatId: string
  chatId: string
  runId: string
  status: 'running' | 'waiting' | 'paused' | 'completed' | 'failed'
  turnId?: string
  nodeId?: string
  batchId?: string
}

export interface RootTimelineSnapshot {
  rootChatId: string
  taskId?: string
  activeBranchId?: string
  branches?: ConversationBranchSummary[]
  view: 'conversation' | 'tree' | 'audit'
  revision: number
  nodes: TimelineNode[]
  edges: ExecutionEdgeFact[]
  activeRuns: ActiveRunFact[]
  pendingInputs: PendingInput[]
  controlState?: TreeControlState
  nextCursor?: string
  capturedEventSeq: number
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

export interface PendingInput {
  chatId?: string
  inputId: string
  clientMessageId?: string
  messageId?: string
  content: string
  state: 'accepted' | 'started' | 'queued' | 'consumed' | 'cancelled' | 'rejected'
  queueSequence?: number
  acceptedAt?: number
  createdAt?: number
  reason?: string
}

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
  [key: string]: unknown
}

export interface ChatOpenResponse {
  chatId: string
  subscriptionId: string
  eventSeq: number
  timelineRevision: number
  timelineChanged: boolean
  rootTimeline?: RootTimelineSnapshot
  state: {
    chatIds?: string[]
    run?: RunSnapshot
    runs?: RunSnapshot[]
    pendingInputs: PendingInput[]
    activeTurns: ActiveTurnSnapshot[]
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

export interface InputAccepted {
  chatId: string
  inputId: string
  clientMessageId: string
  messageId: string
  runId?: string
  state: 'started' | 'queued' | 'accepted'
  queueSequence?: number
  acceptedAt: number
}

/** 思考强度档位（对齐后端 ThinkingLevel）：
 * - off：关闭
 * - on：由模型/服务端决定（不传参）
 * - low/medium/high/xhigh：强度递增
 * - 任意字符串：来自 `.chery/model-thinking.yaml` 的原样档位（如 DeepSeek 的 `max`）。
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
  rpm?: number
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

export type MediaKindDto = 'image' | 'video' | 'audio'
export interface MediaServiceConfigDto {
  type: MediaKindDto
  url: string
  model?: string
  key?: string
  enabled?: boolean
  maxUploadMb?: number
}
export interface MediaConfigDto {
  [name: string]: MediaServiceConfigDto
}

/** 阈值线型（对齐后端 utils/config.ts Threshold）：tokens 绝对值 / percent 0..1 占比。 */
export interface ThresholdDto {
  unit: 'tokens' | 'percent'
  value: number
}

/** command 配置（对齐后端 CommandConfig / config.save globalSchema）。字段均 optional。 */
export interface CommandConfigDto {
  warn?: ThresholdDto
  auto?: ThresholdDto
  min_context_limit?: number
  safety_margin?: number
}

/** chat.get / chat.contextUsage 携带的 command 系统配置投影（对齐后端 CommandConfigData）。 */
export interface CommandConfigDataDto {
  warn: ThresholdDto
  auto: ThresholdDto
  minContextLimit: number
}

export interface GlobalConfigDto {
  thinking: boolean
  supervision: 'auto' | 'smart' | 'manual'
  stream: boolean
  sense_execute_timeout?: number
  /** 审批等待超时（ms）。`>= 0`，0 = 不限时。详见 `InterruptNotificationData.waitTime`。 */
  approval_timeout?: number
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

/** 预设（对齐后端 PresetConfig）：选中的角色 type 列表（引用 config.roles 单一源）+ 指定组长 + 按类型媒体服务 */
export interface PresetDto {
  /** Stable preset workspace identity; generated for legacy configs when read. */
  id?: string
  /** Optional text-only brain used for asynchronous conversation routing suggestions. */
  routingBrain?: string
  detailRole?: string
  /** 组长角色 type 名（必填，主 pet 编制取 config.roles[leader]） */
  leader: string
  /** 选中的角色 type 名 */
  roles?: string[]
  /** 按类型引用媒体服务名（引用 config.media 已定义的服务，类型须匹配） */
  mediaImage?: string
  mediaVideo?: string
  mediaAudio?: string
  /** 项目工作目录绝对路径（system prompt 提示词注入 <workspace> 段；不约束 sense 行为）。缺省 → 不注入 */
  workspace?: string
  /** smart 监管规则覆盖文件名（.chery/rule/ 下，不含 base.yaml；与基准深合并）。缺省 → 仅用基准 */
  rule?: string
}

export interface ConfigDto {
  global: GlobalConfigDto
  llm: { brain: Record<string, BrainConfigDto> }
  media?: MediaConfigDto
  sense_groups?: Record<string, string[]>
  mcp_servers?: Record<string, McpServerConfigDto>
  roles?: Record<
    string,
    {
      brain: string
      avatar?: string
      description?: string
      mentionable?: boolean
      senseGroup: string
      mcpServers?: string[]
      systemPrompt?: string
      skills?: string[]
      plugins?: string[]
      lock?: boolean
    }
  >
  presets?: Record<string, PresetDto>
  /** 项目记忆配置（双层：global 跨 chat 共享 · workspace per chat）；缺省 global {30,500} / workspace {15,500} */
  memory?: {
    global?: { max_count?: number; max_chars?: number }
    workspace?: { max_count?: number; max_chars?: number }
  }
}

/** hooks handler 传输对象（对齐后端 HooksHandlerDTO）*/
export interface HookHandlerDTO {
  matcher?: string
  if?: string
  command: string
  timeout?: number
}

/** hooks.get 响应：全局 hooks + brain 级只读 hooks */
export interface HooksGetResult {
  handlers: Record<string, HookHandlerDTO[]>
  brainHooks: Record<string, Record<string, HookHandlerDTO[]>>
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

function fail(method: string, res: RpcResponse): Error {
  return new Error(res.error?.message ?? `${method} failed`)
}

/** 非流式 RPC：返回 success 时解包 data，否则 throw。 */
async function call<T>(method: string, params: unknown): Promise<T> {
  const res = await wsClient.rpc(method, params)
  if (!res.success) throw fail(method, res)
  return res.data as T
}

/**
 * 流式 RPC：返回 requestId（供 routeChunk 映射 chatId）+ 完成承诺。
 * response 在流式结束（done notification）后 resolve；调用方按需 await。
 */
function callStream(
  method: string,
  params: unknown,
): { requestId: string; done: Promise<RpcResponse> } {
  const { requestId, response } = wsClient.rpcTrack(method, params)
  return { requestId, done: response }
}

export const agentApi = {
  async listInteractions(params?: {
    presetId?: string
    includeActivity?: boolean
  }): Promise<InteractionRecord[]> {
    const response = await call<{ interactions: InteractionRecord[] }>('interaction.list', params ?? {})
    return response.interactions
  },

  async decideInteractionApproval(params: {
    interactionId: string
    action: 'accept' | 'reject'
    expectedRevision: number
    commandId: string
    reason?: string
  }): Promise<InteractionRecord> {
    const response = await call<{ interaction: InteractionRecord }>('interaction.approval.decide', params)
    return response.interaction
  },

  async answerInteractionQuestion(params: {
    interactionId: string
    expectedRevision: number
    commandId: string
    answers: Array<{
      questionId: string
      selectedLabels: string[]
      freeText?: string
      cancelled?: boolean
    }>
  }): Promise<InteractionRecord> {
    const response = await call<{ interaction: InteractionRecord }>('interaction.question.answer', params)
    return response.interaction
  },
  /** skills.list：实时列出用户可加载的技能（独立 + 插件）；内置命令不在此结果中。支持可选分页与搜索。 */
  async listSkills(params?: {
    page?: number
    pageSize?: number
    search?: string
    plugin?: string
  }): Promise<{ skills: SkillInfo[]; total: number; page: number; pageSize: number }> {
    const data = await call<{
      skills?: SkillInfo[]
      total?: number
      page?: number
      pageSize?: number
    }>('skills.list', params ?? {})
    const skills = data?.skills ?? []
    return {
      skills,
      total: data?.total ?? skills.length,
      page: data?.page ?? 1,
      pageSize: data?.pageSize ?? skills.length,
    }
  },

  /** skills.listNames：轻量接口，仅返回 skill/plugin 名称列表（不算 token），供角色卡下拉使用。 */
  async listSkillNames(): Promise<{
    skills: string[]
    plugins: string[]
    skillTokens: Record<string, number>
    pluginTokens: Record<string, number>
  }> {
    return await call('skills.listNames', {})
  },

  /** skills 导入 ZIP：HTTP 上传 raw bytes → stage 候选 + 冲突（两阶段，后 commitSkillImport 落盘）。 */
  async importSkillZip(file: File): Promise<SkillStageResult> {
    const server = await fetchServerConfig()
    const response = await fetch(httpUrl('/api/skills/import'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/zip',
        'X-Filename': file.name,
        ...(server.sessionToken ? { 'X-Chery-Session-Token': server.sessionToken } : {}),
      },
      body: file,
    })
    if (!response.ok) {
      const msg = await response.text().catch(() => '')
      throw new Error(`skill 上传失败: ${response.status}${msg ? ` ${msg}` : ''}`)
    }
    return (await response.json()) as SkillStageResult
  },
  /** skills.importUrl：按选定分支 git clone 独立技能集合 → stage 候选 + 冲突（鉴权同插件）。 */
  async importSkillUrl(req: SkillImportRequest): Promise<SkillImportResponse> {
    return await call<SkillImportResponse>('skills.importUrl', req)
  },
  /** skills.commit：按选择落盘 + 规范化 SKILL.md + 清 staging。 */
  async commitSkillImport(
    stagingId: string,
    selections: SkillCommitSelection[],
  ): Promise<{ imported: string[]; skipped: string[] }> {
    return await call<{ imported: string[]; skipped: string[] }>('skills.commit', {
      stagingId,
      selections,
    })
  },
  /** skills.delete：删除独立 skill 目录（插件技能不在此列）。 */
  async deleteSkill(name: string): Promise<void> {
    await call<{ ok: true }>('skills.delete', { name })
  },
  /** skills.preImportUrl：拉分支列表 + needsAuth/gitNotInstalled 探测（不 clone）。 */
  async preImportSkillUrl(
    url: string,
    credentialId?: string,
    proxy?: string,
  ): Promise<SkillPreImportResult> {
    return await call<SkillPreImportResult>('skills.preImportUrl', {
      url,
      ...(credentialId ? { credentialId } : {}),
      ...(proxy ? { proxy } : {}),
    })
  },
  /** skills.listSources：列出 git 来源中央索引（每来源 skills 实时读 skills_dir）。 */
  async listSkillSources(): Promise<SkillSource[]> {
    const data = await call<{ sources?: SkillSource[] }>('skills.listSources', {})
    return data?.sources ?? []
  },
  async checkSkillSource(sourceId: string): Promise<{
    sourceId: string
    latestSha: string
    latestDate?: string
    updateAvailable: boolean
  }> {
    return await call('skills.checkSource', { sourceId })
  },
  async checkAllSkillSources(): Promise<{
    checked: number
    updatesAvailable: number
    failed: Array<{ sourceId: string; reason: string }>
  }> {
    return await call('skills.checkAllSources', {})
  },
  /** skills.resyncSource：重 clone 某来源 + 重弹候选（前端预勾选原已导入）。 */
  async resyncSkillSource(sourceId: string): Promise<SkillResyncResult> {
    return await call<SkillResyncResult>('skills.resyncSource', { sourceId })
  },
  /** skills.resyncAllSources：批量重拉全部来源（serial 非交互；失败条目写 lastSyncError 持久化）。 */
  async resyncAllSkillSources(): Promise<{
    results: Array<{
      sourceId: string
      ok: boolean
      error?: string
      commitSha?: string
      commitDate?: string
    }>
    successes: number
    failures: number
  }> {
    return await call('skills.resyncAllSources', {})
  },
  /** skills.deleteSource：删来源条目 + 其跟踪的 skill 文件夹。 */
  async deleteSkillSource(sourceId: string): Promise<void> {
    await call<{ ok: true }>('skills.deleteSource', { sourceId })
  },

  /** plugins.list：列出已安装插件（.chery/plugins/*）。 */
  async listPlugins(): Promise<PluginInfo[]> {
    const data = await call<{ plugins?: PluginInfo[] }>('plugins.list', {})
    return data?.plugins ?? []
  },
  /** plugins.preImportUrl：解析 URL + 拉 branches + needsAuth/gitNotInstalled 探测（不 clone）。 */
  async preImportPluginUrl(
    url: string,
    credentialId?: string,
    proxy?: string,
  ): Promise<PluginPreImportResult> {
    return await call<PluginPreImportResult>('plugins.preImportUrl', {
      url,
      ...(credentialId ? { credentialId } : {}),
      ...(proxy ? { proxy } : {}),
    })
  },
  /** plugins.importUrl：按选定分支 git clone 整仓 → staging 预览（含 existing 冲突 + SHA/日期）。 */
  async importPluginUrl(req: PluginImportRequest): Promise<PluginImportPreview> {
    return await call<PluginImportPreview>('plugins.importUrl', req)
  },
  /** plugins.commit：确认落盘（overwrite=true 覆盖同名插件）。 */
  async commitPlugin(stagingId: string, overwrite: boolean): Promise<{ plugin: PluginInfo }> {
    return await call<{ plugin: PluginInfo }>('plugins.commit', { stagingId, overwrite })
  },
  /** plugins.checkUpdate：对比 manifest 当前 HEAD 与远端分支 HEAD（含最新发布日期，私有仓降级）。 */
  async checkPluginUpdate(name: string): Promise<PluginCheckUpdateResult> {
    return await call<PluginCheckUpdateResult>('plugins.checkUpdate', { name })
  },
  /**
   * plugins.checkAllUpdates：批量检查全部已安装插件，结果写入各自 manifest。
   * 返回 checked / updatesAvailable / failed（单个失败不中断）。调用后需 refresh() 重拉 list 读持久化字段。
   */
  async checkAllPluginsUpdate(): Promise<{
    checked: number
    updatesAvailable: number
    failed: Array<{ name: string; reason: string }>
  }> {
    return await call('plugins.checkAllUpdates', {})
  },
  /** plugins.update：按 manifest.cloneUrl+branch 重新拉取覆盖。 */
  async updatePlugin(name: string): Promise<{ plugin: PluginInfo }> {
    return await call<{ plugin: PluginInfo }>('plugins.update', { name })
  },
  /** plugins.uninstall：删除整个插件目录。 */
  async uninstallPlugin(name: string): Promise<void> {
    await call<{ ok: true }>('plugins.uninstall', { name })
  },

  /** credentials.list：列出全部已存凭据（仅 id/label/username，密令永不回前端）。 */
  async listCredentials(): Promise<CredentialListItemDTO[]> {
    const data = await call<{ credentials?: CredentialListItemDTO[] }>('credentials.list', {})
    return data?.credentials ?? []
  },
  /** credentials.save：加密入池（AES-256-GCM，密令后端解密）。 */
  async saveCredential(
    label: string,
    username: string,
    password: string,
  ): Promise<CredentialListItemDTO> {
    const data = await call<{ credential: CredentialListItemDTO }>('credentials.save', {
      label,
      username,
      password,
    })
    return data.credential
  },
  /** credentials.delete：从凭据池删除。 */
  async deleteCredential(id: string): Promise<void> {
    await call<{ ok: true }>('credentials.delete', { id })
  },

  /** chat.list：列出所有 chat（主 chat → 主 pet；子 chat 按 parentChatId 挂主附近）。CP8：includePreview=true 增返 preview/turnCount（会话列表用）。 */
  async listChats(includePreview = false): Promise<ChatSummary[]> {
    const data = await call<{ chats?: ChatSummary[] }>('chat.list', { includePreview })
    return data?.chats ?? []
  },

  async suggestConversationRoute(params: {
    presetId: string
    draft: string
    requestVersion: number
  }): Promise<ConversationRouteSuggestion> {
    return call<ConversationRouteSuggestion>('chat.route.suggest', params)
  },

  /** chat.create：创建 chat。返回 chatId + 实际生效编制（预设路径由后端回填，供记 pet.runtime）。 */
  async createAgent(opts: CreateAgentOptions): Promise<CreateAgentResult> {
    const data = await call<{
      chatId?: string
      presetId?: string
      brain?: string
      senseGroup?: string
      mcpServers?: string[]
      workspace?: string
      workspaceValid?: boolean
    }>('chat.create', {
      ...(opts.preset ? { preset: opts.preset } : {}),
      ...(opts.brain !== undefined ? { brain: opts.brain } : {}),
      ...(opts.senseGroup !== undefined ? { senseGroup: opts.senseGroup } : {}),
      mcpServers: opts.mcpServers ?? [],
      chatId: opts.chatId,
      parentChatId: opts.parentChatId,
    })
    if (!data?.chatId || !data.brain) {
      throw new Error('chat.create: missing chatId/brain/senseGroup in response')
    }
    return {
      chatId: data.chatId,
      presetId: data.presetId,
      brain: data.brain,
      senseGroup: data.senseGroup ?? '',
      mcpServers: data.mcpServers ?? [],
      workspace: data.workspace,
      workspaceValid: data.workspaceValid,
    }
  },

  /** V2 command plane：立即确认输入，不承载 Agent 流生命周期。 */
  async submitChatInput(params: {
    chatId: string
    commandId: string
    clientMessageId: string
    messageId: string
    content: string
    attachments?: ChatSendAttachment[]
  }): Promise<InputAccepted> {
    return call<InputAccepted>('chat.input.submit', {
      chatId: params.chatId,
      commandId: params.commandId,
      clientMessageId: params.clientMessageId,
      messageId: params.messageId,
      content: params.content,
      ...(params.attachments?.length ? { attachments: params.attachments } : {}),
    })
  },

  /** V2 timeline plane：返回后端已经构建好的完整消息对象。 */
  async getTimeline(params: {
    chatId: string
    before?: string
    limit?: number
    knownRevision?: number
  }): Promise<TimelineSnapshot> {
    return call<TimelineSnapshot>('chat.timeline.get', {
      chatId: params.chatId,
      ...(params.before ? { before: params.before } : {}),
      ...(params.limit !== undefined ? { limit: params.limit } : {}),
      ...(params.knownRevision !== undefined ? { knownRevision: params.knownRevision } : {}),
    })
  },

  /** Root timeline projection: backend joins all recursive descendants. */
  async getRootTimeline(params: {
    rootChatId: string
    view?: 'conversation' | 'tree' | 'audit'
    knownRevision?: number
  }): Promise<RootTimelineSnapshot> {
    const response = await call<TimelineSnapshot>('chat.timeline.get', {
      rootChatId: params.rootChatId,
      view: params.view ?? 'conversation',
      ...(params.knownRevision !== undefined ? { knownRevision: params.knownRevision } : {}),
    })
    if (!response.rootTimeline) throw new Error('root timeline 响应缺少 rootTimeline')
    return response.rootTimeline
  },

  async getTaskTimeline(params: {
    taskId: string
    view?: 'conversation' | 'tree' | 'audit'
  }): Promise<RootTimelineSnapshot> {
    const response = await call<TimelineSnapshot>('chat.timeline.get', {
      taskId: params.taskId,
      view: params.view ?? 'tree',
    })
    if (!response.rootTimeline) throw new Error('task timeline 响应缺少 rootTimeline')
    return response.rootTimeline
  },

  async previewBranch(rootChatId: string, anchorNodeId: string): Promise<{
    taskId: string
    sourceBranchId: string
    eligible: boolean
    reason?: string
    sideEffects: Array<{ nodeId: string; callId: string; toolName: string; arguments: string; result?: string }>
    effectDigest: string
  }> {
    return call<{
      taskId: string
      sourceBranchId: string
      eligible: boolean
      reason?: string
      sideEffects: Array<{ nodeId: string; callId: string; toolName: string; arguments: string; result?: string }>
      effectDigest: string
    }>('chat.branch.preview', { rootChatId, anchorNodeId })
  },

  async createBranch(params: {
    rootChatId: string
    anchorNodeId: string
    branchType: 'continuation' | 'detail'
    prompt: string
    commandId: string
    clientMessageId: string
    messageId: string
    effectDigest?: string
  }): Promise<ConversationBranchSummary & { input: InputAccepted }> {
    return call<ConversationBranchSummary & { input: InputAccepted }>('chat.branch.create', params)
  },

  async activateBranch(branchId: string, commandId: string): Promise<{
    taskId: string
    activeBranchId: string
    activeChatId: string
    deliveryGeneration: number
  }> {
    return call('chat.branch.activate', { branchId, commandId })
  },

  async abortTask(taskId: string, commandId: string): Promise<{ taskId: string; abortedBranches: string[] }> {
    return call<{ taskId: string; abortedBranches: string[] }>('chat.abortTask', { taskId, commandId })
  },

  /** V2 session plane：原子建立订阅并返回当前运行态快照。 */
  async openChat(params: {
    chatId?: string
    rootChatId?: string
    knownTimelineRevision?: number
    knownEventSeq?: number
  }): Promise<ChatOpenResponse> {
    return call<ChatOpenResponse>('chat.open', {
      ...(params.chatId ? { chatId: params.chatId } : {}),
      ...(params.rootChatId ? { rootChatId: params.rootChatId } : {}),
      ...(params.knownTimelineRevision !== undefined
        ? { knownTimelineRevision: params.knownTimelineRevision }
        : {}),
      ...(params.knownEventSeq !== undefined ? { knownEventSeq: params.knownEventSeq } : {}),
    })
  },

  /** V2 session plane：显式关闭订阅。 */
  async closeChat(subscriptionId: string): Promise<void> {
    await call('chat.close', { subscriptionId })
  },

  /**
   * chat.send：流式发消息。返回 requestId（agents store 记录 requestId→chatId 供 routeChunk）。
   * done 在流式结束 resolve；CP1 可不 await（chunk 路由独立）。
   * P4：可选 attachments 参数，结构化附件（替代旧 [[media:]] 文本标记）。
   *   服务端据 assetId + mimeType 合成 [[media:<filename>]] 标记追加到 prompt，
   *   兼容既有 enrichMediaInputs 流程。前端 AgentDialog 把 MediaAttachment[] 传过来即可。
   */
  sendMessage(
    chatId: string,
    text: string,
    attachments?: ChatSendAttachment[],
  ): { requestId: string; done: Promise<RpcResponse> } {
    return callStream('chat.send', {
      chatId,
      prompt: text,
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    })
  },

  /**
   * chat.resume：流式续跑（无 prompt，run("") 起流）。T9 wait=true 唤醒轮用：
   * 后端注入角色回复后推 role_reply → 前端调本方法 resume 主处理注入消息。
   * 也用于重连续跑 interrupted wait-子。返回 requestId 供 chunk 路由。
   */
  resumeChat(chatId: string): { requestId: string; done: Promise<RpcResponse> } {
    return callStream('chat.resume', { chatId })
  },

  /** Atomically claims and starts a persisted role spawn task. Safe to call after role_created replay. */
  startSpawn(taskId: string): { requestId: string; done: Promise<RpcResponse> } {
    return callStream('chat.startSpawn', { taskId })
  },

  /** chat.sync：单一水源回放（chat.sync(0) = 全量）；后端不再发 reset:true，超窗淘汰由消息合成事件回填。response 含 currentState 快照（见 CurrentStateData）。 */
  syncChat(chatId: string, afterSeq: number): { requestId: string; done: Promise<RpcResponse> } {
    return callStream('chat.sync', { chatId, afterSeq })
  },

  /** runtime.set：原子设置 chat 的 brain + 工具组 + mcpServers。 */
  async setRuntime(chatId: string, selection: RuntimeSelection): Promise<void> {
    await call('runtime.set', {
      chatId,
      brain: selection.brain,
      senseGroup: selection.senseGroup,
      mcpServers: selection.mcpServers ?? [],
    })
  },

  /**
   * session.runtime.set：临时设置主角色和小组角色编制，不持久化；
   * **同时回灌已派发的同 type 子 chat**——idle/未加载子即时切换并持久化到子 metadata.runtime；
   * running 子仅记 deferredRunning，需用户先 abort→resume 才生效。
   * @returns applied=已即时切换的子 chatId 列表；deferredRunning=运行中待生效的子 chatId 列表
   */
  async setSessionRuntime(
    chatId: string,
    selection: SessionRuntimeSelection,
  ): Promise<{ applied: string[]; deferredRunning: string[] }> {
    return call<{ applied: string[]; deferredRunning: string[] }>('session.runtime.set', {
      chatId,
      ...selection,
    })
  },

  /** chat.abort：中止当前流（清内存运行时 + 释放连接，不删 DB）。 */
  async abortAgent(
    chatId: string,
    runId?: string,
    commandId?: string,
  ): Promise<ChatAbortResponse | undefined> {
    return call<ChatAbortResponse | undefined>('chat.abort', {
      chatId,
      ...(runId ? { runId } : {}),
      ...(commandId ? { commandId } : {}),
    })
  },

  async resumeTree(
    rootChatId: string,
    pauseId: string,
    commandId: string,
  ): Promise<TreeResumeResponse> {
    return call<TreeResumeResponse>('chat.resumeTree', { rootChatId, pauseId, commandId })
  },

  /**
   * chat.attach：F5 后重连运行中 run，请求后端把后续实时输出重定向到本连接。
   * 返回 running=false → 前端回落历史；running=true → 已重定向，后续 chunk 经 WS envelope(chatId) 路由。
   * 非流式；须在 syncChatEvents（回放补齐）之前调用（先开启重定向再回放，seq 无缝衔接）。
   * response.currentState：running 时含存活的 pending approval / 运行中工具 / 当前 todo（见 CurrentStateData）。
   */
  async attachChat(chatId: string): Promise<{
    chatId: string
    running: boolean
    attached?: boolean
    /** Stable event cursor captured together with the question snapshot. */
    snapshotSeq: number
    pendingQuestionBatches: unknown[]
    currentState?: CurrentStateData
  }> {
    return call<{
      chatId: string
      running: boolean
      attached?: boolean
      snapshotSeq: number
      pendingQuestionBatches: unknown[]
      currentState?: CurrentStateData
    }>('chat.attach', { chatId })
  },

  /** chat.delete：真删 chat（CP8 仅会话列表 ✕ deleteSession 调用；主 chat 后端级联删子 chat）。stage 隐藏走 store.hide，不调本方法。 */
  async destroyAgent(chatId: string): Promise<void> {
    await call('chat.delete', { chatId })
  },

  /**
   * chat.get：流式载入历史。返回 requestId；历史块（staged chunks, role=user/assistant/...）
   * 经 routeChunk 路由到对应 StreamState。CP1 骨架仅返回 requestId，CP4 接 HistoryDrawer 渲染。
   */
  getHistory(chatId: string): { requestId: string; done: Promise<RpcResponse> } {
    return callStream('chat.get', { chatId })
  },

  /** chat.contextUsage：轻量取上下文用量详情（比例 + 已用 token / 上限 + 6 段分解 + commandConfig）。initFromChats 后驱动 ContextBar 初始渲染。 */
  async contextUsage(chatId: string): Promise<{
    chatId: string
    contextUsage: number
    contextUsed: number
    contextTotal: number
    contextBreakdown: ContextBreakdown
    commandConfig?: CommandConfigDataDto
  }> {
    return call<{
      chatId: string
      contextUsage: number
      contextUsed: number
      contextTotal: number
      contextBreakdown: ContextBreakdown
      commandConfig?: CommandConfigDataDto
    }>('chat.contextUsage', { chatId })
  },

  /**
   * chat.promptSnapshot：重建 chat 当前 runtime 的 system prompt 全文 + 工具定义。
   * 供历史抽屉顶部「上下文」hover 面板展示完整系统提示词（system 段 + tools 段）。
   * 按 chat 当前快照重建（systemPromptFile/workspace/skillFilter + runtime selection）。
   */
  async promptSnapshot(chatId: string): Promise<{
    chatId: string
    systemPrompt: string
    tools: PromptSnapshotTool[]
  }> {
    return call<{
      chatId: string
      systemPrompt: string
      tools: PromptSnapshotTool[]
    }>('chat.promptSnapshot', { chatId })
  },

  /** sense.approval：审批（accept/reject）。approvalId 来自 interrupt notification。 */
  async approval(approvalId: string, action: ApprovalAction): Promise<void> {
    await call('sense.approval', { approvalId, action })
  },

  /**
   * sense.question.answer：回答 ask_user_question 感官（questionId 来自 question_requested notification）。
   * selectedLabels：用户点选的 label 数组（单选=1 项；多选=N 项；「其他」自由文本时为 []）。
   * freeText：「其他」chip 触发模态对话框时输入的自由文本（普通 chip 选中时省略）。
   * cancelled：true = 用户点 ✕ 取消；正常答案时省略。
   */
  async answerQuestion(
    questionId: string,
    answer: { selectedLabels: string[]; freeText?: string; cancelled?: boolean },
  ): Promise<void> {
    await call('sense.question.answer', { questionId, ...answer })
  },

  /** 原子提交一个完整问题批次；服务端成功落库后由 shouldResume 指示是否续跑 agent。 */
  async answerQuestionBatch(
    chatId: string,
    batchId: string,
    answers: Array<{
      questionId: string
      selectedLabels: string[]
      freeText?: string
      cancelled?: boolean
    }>,
  ): Promise<{ chatId: string; batchId: string; completed: boolean; shouldResume: boolean }> {
    return await call('sense.question.batchAnswer', { chatId, batchId, answers })
  },

  /**
   * brain.list：列出可用 brain + 当前已连 MCP server（AgentDialog 用）。
   * 后端 Agent 1 契约保证 brains[].contextLimit。返回形状容错（缺字段 → 空数组）。
   */
  async listBrains(): Promise<BrainListResponse> {
    const data = await call<Partial<BrainListResponse>>('brain.list', {})
    return {
      brains: Array.isArray(data?.brains) ? data.brains : [],
      mcpServers: Array.isArray(data?.mcpServers) ? data.mcpServers : [],
    }
  },

  /** config.get：读 .chery/config.yaml 原文（除 server 段），供设置面板编辑。supervision 为字符串、key 仍为 $ENV 占位符。 */
  async getConfig(): Promise<ConfigDto> {
    return call<ConfigDto>('config.get', {})
  },

  /** config.workspace.validate：只读检查后端主机上的工作区目录，不保存配置。 */
  async validateWorkspace(workspace?: string): Promise<{ valid: boolean; error?: string }> {
    return call<{ valid: boolean; error?: string }>(
      'config.workspace.validate',
      workspace ? { workspace } : {},
    )
  },

  /**
   * config.save：校验（brain 引用/supervision 合法/`:level` 合法/必填）+ 写回（保留 server 段、无注释）。
   * 不碰内存单例，重启生效。校验失败 throw（error.message 含全部错误，设置面板红框展示）。
   */
  async saveConfig(
    payload: ConfigDto,
  ): Promise<{ needRestart: true; restart: 'immediate' | 'scheduled' | 'manual' }> {
    return call<{ needRestart: true; restart: 'immediate' | 'scheduled' | 'manual' }>(
      'config.save',
      payload,
    )
  },

  /** hooks.get：读全局 hooks.json + brain 级 hooks（只读展示）*/
  async getHooks(): Promise<HooksGetResult> {
    return call<HooksGetResult>('hooks.get', {})
  },

  /** hooks.save：校验 + 写回 hooks.json */
  async saveHooks(handlers: Record<string, HookHandlerDTO[]>): Promise<{ ok: true }> {
    return call<{ ok: true }>('hooks.save', { handlers })
  },

  /** hooks.events：返回 10 事件静态元数据 */
  async getHookEvents(): Promise<HookEventMeta[]> {
    const data = await call<{ events: HookEventMeta[] }>('hooks.events', {})
    return data?.events ?? []
  },

  /**
   * sense.tools：列出代码维护的全部内置工具（name/label/description/icon），供设置面板感官分组下拉建议 + pet bar 运行中工具 icon 查询。
   * 仅内置；自定义/外部/MCP 工具不在内，靠组合框自由输入。返回形状容错（缺字段 -> 空数组）。
   */
  async listSenseTools(): Promise<SenseToolInfo[]> {
    const data = await call<Partial<{ tools: SenseToolInfo[] }>>('sense.tools', {})
    return Array.isArray(data?.tools) ? data.tools : []
  },

  /**
   * sense.list：列出 config.sense_groups 全部组及其 sense 名（group→senses 解析）。
   * 供前端「能力判定」——pet 的 senseGroups（组名）经此解析为 sense 名集合，判断是否含某工具（如 update_todo）。
   * 返回形状容错（缺字段 -> 空数组）。
   */
  async listSenseGroups(): Promise<{ name: string; senses: string[] }[]> {
    const data = await call<Partial<{ senseGroups?: { name: string; senses: string[] }[] }>>(
      'sense.list',
      {},
    )
    return Array.isArray(data?.senseGroups) ? data.senseGroups : []
  },

  /**
   * prompts.list：递归列出 .chery/prompt/ 下全部 .md（含子文件夹），每项为相对 .chery/ 的路径
   * （如 prompt/prefebMain/leader.md）。供设置面板 systemPrompt 级联选择器（el-cascader）建目录树。
   * 返回形状容错（缺字段 -> 空数组）。
   */
  async listPrompts(): Promise<string[]> {
    const data = await call<Partial<{ prompts?: string[] }>>('prompts.list', {})
    return Array.isArray(data?.prompts) ? data.prompts : []
  },
  /**
   * rules.list：列出 .chery/rule/ 下全部 .yaml 文件名（排除基准 base.yaml），供设置面板预设 tab
   * 「规则文件」下拉填充。返回形状容错（缺字段 -> 空数组）。
   */
  async listRules(): Promise<string[]> {
    const data = await call<Partial<{ rules?: string[] }>>('rules.list', {})
    return Array.isArray(data?.rules) ? data.rules : []
  },
  async uploadMedia(file: File): Promise<UploadedMediaAsset> {
    const server = await fetchServerConfig()
    const response = await fetch(httpUrl('/api/media/upload'), {
      method: 'POST',
      headers: {
        'Content-Type': file.type,
        'X-Filename': file.name,
        ...(server.sessionToken ? { 'X-Chery-Session-Token': server.sessionToken } : {}),
      },
      body: file,
    })
    if (!response.ok) throw new Error('媒体上传失败')
    return (await response.json()) as UploadedMediaAsset
  },

  /** utils.models：基于 provider/url/key 拉取可用模型列表。 */
  async fetchModels(
    provider: string,
    url: string,
    key?: string,
  ): Promise<{ models: Array<{ id: string; name?: string }>; error?: string }> {
    return await call<{ models: Array<{ id: string; name?: string }>; error?: string }>(
      'utils.models',
      { provider, url, key },
    )
  },

  /** utils.testConnection：用未保存的连接字段执行真实最小 Provider 请求。 */
  async testConnection(
    provider: string,
    url: string,
    key: string | undefined,
    model: string,
  ): Promise<{ ok: true; error?: never } | { ok: false; error: string }> {
    return await call<{ ok: true; error?: never } | { ok: false; error: string }>(
      'utils.testConnection',
      { provider, url, key, model },
    )
  },

  /**
   * env.list：读取 .env 文件中的变量名列表（供密钥下拉选择）。
   * 前端再按密钥后缀白名单过滤，只把凭据类变量名透出给下拉（CHERY_DIR / HOST / URL 等
   * 运行时配置不进下拉，避免误选）。后端 redactEnvKeys 仍按全量脱敏，不受影响。
   */
  async listEnvVars(): Promise<string[]> {
    const data = await call<{ vars: string[] }>('env.list', {})
    const all = data?.vars ?? []
    return all.filter(isSecretEnvVarName)
  },

  /** utils.openFile：打开指定文件（用配置的编辑器或系统默认）。 */
  async openFile(path: string): Promise<void> {
    await call('utils.openFile', { path })
  },

  /** utils.openConfigDir：打开后端主机的 .chery 配置目录。 */
  async openConfigDir(): Promise<void> {
    await call('utils.openConfigDir', {})
  },

  /** utils.editors：获取系统可用的文本编辑器列表（供前端下拉选择）。 */
  async listEditors(): Promise<EditorInfo[]> {
    const data = await call<{ editors: EditorInfo[] }>('utils.editors', {})
    return data?.editors ?? []
  },

  /**
   * utils.thinkingLevels：按模型名批量查 ThinkingLevel 档位列表。
   * 后端读 `.chery/model-thinking.yaml` 配置，**原样返回文件中 thinking 数组**（按 YAML 顺序），
   * elements 含任意字符串（如 DeepSeek 的 `max`）。未命中兜底为 ["off", "on"]。
   * models 去重 + 过滤空串；返回 `Record<model, ThinkingLevel[]>`。
   */
  async getThinkingLevels(models: string[]): Promise<Record<string, ThinkingLevel[]>> {
    const unique = Array.from(new Set(models.filter((m) => typeof m === 'string' && m.length > 0)))
    if (unique.length === 0) return {}
    const data = await call<{ levels: Record<string, ThinkingLevel[]> }>('utils.thinkingLevels', {
      models: unique,
    })
    return data?.levels ?? {}
  },

  // ========== 内置命令管理（settings 「指令」tab） ==========

  /** command.list：列出全部 .chery/command/*.md 文件（只读枚举）。返回 [] 时前端展示空态。 */
  async listCommands(): Promise<CommandInfo[]> {
    const data = await call<Partial<{ commands?: CommandInfo[] }>>('command.list', {})
    return Array.isArray(data?.commands) ? data.commands : []
  },
}

/**
 * /api/config 全量配置缓存（default + senseGroups + presets）。
 * 幂等：首次 fetch 后缓存；失败时清缓存置 null（下次仍 fetch 重试），错误显式抛出由调用方处理（规则 12）。
 * AgentFab（presets）+ AgentDialog（senseGroups/default）共享同一缓存，避免重复 fetch。
 */
let serverConfigCache: ConfigDefault | null | undefined

export async function fetchServerConfig(): Promise<ConfigDefault> {
  if (serverConfigCache) return serverConfigCache
  try {
    const res = await fetch(httpUrl('/api/config'))
    if (!res.ok) throw new Error(`/api/config ${res.status}`)
    serverConfigCache = (await res.json()) as ConfigDefault
    return serverConfigCache as ConfigDefault
  } catch (e) {
    // 失败置 null（区分"未 fetch"与"fetch 成功但无 default"），下次不再重试
    serverConfigCache = null
    throw e
  }
}
