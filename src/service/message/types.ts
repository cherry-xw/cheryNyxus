import { randomUUID } from "crypto";
import { SupervisionLevel } from "@/core/config.js";
import type { McpServerInfo } from "@/core/mcp/types.js";
import type { RuntimeSelection } from "@/agent/runtimeResolver.js";
import type { ConfigRaw } from "@/utils/config.js";

// ========== 消息基础类型 ==========

/**
 * 请求消息（C→S）
 */
export type Request<M extends Method = Method> = {
  [K in M]: {
    id: string;
    kind: "request";
    method: K;
    params: ParamsOf<K>;
  };
}[M];

/**
 * 响应消息（S→C，请求返回）
 */
export interface Response<TData extends ResponseData = ResponseData> {
  id: string;
  kind: "response";
  requestId: string;
  success: boolean;
  data?: TData;
  error?: RpcError;
}

/**
 * Chunk消息（S→C，流式增量）
 */
export interface Chunk {
  kind: "chunk";
  type: "stream" | "staged";
  requestId: string;
  /** 事件所属 chat。不得再通过 requestId 猜测 chat 路由。 */
  chatId?: string;
  /** 一次 chat.send/chat.resume 运行的稳定标识；当前实现中等于启动该运行的 Request.id。 */
  runId?: string;
  /** Chat event sequence. Present for recoverable live events and chat.sync replays. */
  seq?: number;
  data: ChunkData;
}

/**
 * Notification消息（S→C，服务端推送）
 */
export interface Notification {
  kind: "notification";
  type: NotificationType;
  /** 触发该事件的 RPC 请求；脱离请求异步推送时省略。 */
  requestId?: string;
  /** 事件所属 chat。role_created/role_reply 等异步事件必须使用此字段路由。 */
  chatId?: string;
  /** 事件所属运行；非某次运行产生的异步事件可省略。 */
  runId?: string;
  /** Chat event sequence. Present for recoverable live events and chat.sync replays. */
  seq?: number;
  data: NotificationData;
}

/** Chunk/Notification 共用的显式业务关联字段。 */
export interface EventContext {
  chatId?: string;
  runId?: string;
}

export type NotificationType =
  | "interrupt"    // 感官审批请求（sense_end，仅 confirm/manual）
  | "sense_started" // 感官开始执行（sense_end，仅 auto；前端维护「运行中工具」列表）
  | "accept"       // 感官执行成功（全工具；approvalId=sense id，前端移除运行中工具同 id 项）
  | "rejected"     // 感官执行被拒绝
  | "consumed"     // 消息已消费
  | "loaded"       // 历史对话已载入
  | "done"         // 执行完成
  | "error"        // 错误
  | "replaced"     // 感官去重命中：历史 sense 结果被新读取替换
  | "role_created"   // 角色（子 pet）派发（spawn_role sense 执行时推送给主 chat 所属连接）
  | "role_destroyed" // 角色销毁（destroy_role sense 执行时推送给主 chat 所属连接，CP6）
  | "role_reply"     // wait=true 子完成唤主（后端注入角色回复后推，前端 chat.resume 续跑，T9 B1）
  | "question_requested" // ask_user_question 旧版逐题事件（兼容历史事件重放）
  | "question_answered" // ask_user_question 旧版逐题完成事件（兼容）
  | "question_batch_requested" // 一个 assistant turn 的完整问题批次
  | "question_batch_completed"; // 批次已原子完成，前端清理本地投影

// ========== Request Data ==========

/** 严格空对象：用于无参数请求与无 data 成功响应，避免裸 `{}` 吞并联合成员。 */
export type EmptyObjectData = Record<string, never>;

export type BrainListRequestData = EmptyObjectData;

export type SenseListRequestData = EmptyObjectData;

export type SenseToolsRequestData = EmptyObjectData;

/** skills.list：列出用户配置目录中当前可用的 Skill 元数据。 */
export type SkillsListRequestData = EmptyObjectData;

export type PromptsListRequestData = EmptyObjectData;

export interface ChatCreateRequestData {
  chatId?: string;
  /** 预设名（T6）：给出则从 config.presets[preset].leader 解析编制（取 config.roles[leader] 的 brain/senseGroup/mcp/systemPrompt 锁定快照），忽略下方 brain/senseGroup */
  preset?: string;
  /** 非预设路径必填；预设给出时忽略 */
  brain?: string;
  senseGroup?: string;
  /** 启用的 MCP server 名（绕过 sense_groups，其全部 tools 合并进 schema）。缺省 []。 */
  mcpServers?: string[];
  /** 角色（子 pet）关联主 chat 的 chatId；主 chat 不携带（DB 存 NULL）。主从 Agent 桌宠系统 CP1。 */
  parentChatId?: string;
}

export interface ChatListRequestData {
  /**
   * true：每项增返 preview（首条 user 消息截断）+ turnCount（user 消息数），供会话列表渲染。
   * 省略/false：lean，不查 messages，供初始化重建 pet 树（免 N+1）。CP8。
   */
  includePreview?: boolean;
}

export interface ChatGetRequestData {
  chatId: string;
}

export interface ChatContextUsageRequestData {
  chatId: string;
}

export interface ChatDeleteRequestData {
  chatId: string;
}

/**
 * chat.send 入参
 * - prompt：用户文本（与 attachments 并存；纯文本 prompt 也允许）
 * - attachments：上传到 `/api/media/upload` 后的资产引用数组（结构化协议，替代旧的 `[[media:filename]]` 文本标记）。
 *   后端 chatMiddleware enrichMediaInputs 据 assetId 走 readMediaAsset → provider 多模态 buildMessages。
 *   旧文本 marker 仍兼容（旧 marker = 历史消息遗留；新客户端不再发 marker）。
 *   资产未通过 brain.capabilities.input[kind] 检查时不下发，附文本提示。
 */
export interface ChatSendRequestData {
  chatId: string;
  prompt: string;
  attachments?: ChatSendAttachment[];
}

export type ChatAttachmentKind = "image" | "video" | "audio";

export interface ChatSendAttachment {
  /** 上传后服务端生成的 asset id（与 /api/media/upload 返回 UploadedMediaAsset.id 对应）。 */
  assetId: string;
  kind: ChatAttachmentKind;
  mimeType: string;
}

export interface RuntimeSetRequestData {
  chatId: string;
  brain: string;
  /** 非预设 chat 必填；preset chat 下仅 brain 生效（编制锁定，强制取创建快照，显式带不同值 fail loud） */
  senseGroup?: string;
  /** 启用的 MCP server 名。缺省 []（关闭所有 MCP）。preset chat 下锁定。 */
  mcpServers?: string[];
}

/** 当前会话临时编制：仅保存在服务进程内存，不写 chats.metadata。 */
export interface SessionRuntimeSetRequestData {
  chatId: string;
  /** 主角色本轮及后续本次会话发送所用编制。 */
  primary: RuntimeSelection;
  /** role type → 临时编制；后续 spawn_role 创建子角色时应用。 */
  roles: Record<string, RuntimeSelection>;
}

export interface SessionRuntimeSetResponseData {
  chatId: string;
}

export interface ChatResumeRequestData {
  chatId: string;
}

/** Replays recoverable chat events newer than afterSeq. */
export interface ChatSyncRequestData {
  chatId: string;
  afterSeq: number;
}

/** Starts a persisted role spawn task exactly once. */
export interface ChatStartSpawnRequestData {
  taskId: string;
}

export interface SenseApprovalRequestData {
  approvalId: string;
  action: "accept" | "reject";
  reason?: string;
}

/**
 * sense.question.answer 入参（用户回答 ask_user_question）。
 * selectedLabels：用户点选的 label 数组（单选=1 项；多选=N 项；「其他」自由文本时为空数组）。
 * freeText：「其他」chip 触发模态对话框时输入的自由文本（普通 chip 选中时为 undefined）。
 * cancelled：true = 用户点 ✕ 取消；正常答案时省略或 false。
 */
export interface SenseQuestionAnswerRequestData {
  questionId: string;
  selectedLabels: string[];
  freeText?: string;
  cancelled?: boolean;
}

export interface SenseQuestionAnswerResponseData {
  questionId: string;
  cancelled: boolean;
}

/** 原子提交一个持久化问题批次。answers 必须恰好覆盖批次内所有仍 pending 的问题。 */
export interface SenseQuestionBatchAnswerRequestData {
  chatId: string;
  batchId: string;
  answers: Array<{
    questionId: string;
    selectedLabels: string[];
    freeText?: string;
    cancelled?: boolean;
  }>;
}

export interface SenseQuestionBatchAnswerResponseData {
  chatId: string;
  batchId: string;
  completed: boolean;
  /** true 时调用方应启动 chat.resume；重复提交已完成批次时为 false。 */
  shouldResume: boolean;
}

export interface ChatAbortRequestData {
  chatId: string;
  /** 仅中止该运行；与当前 active run 不一致时返回 CONFLICT，防止旧页面误杀新一轮。 */
  runId?: string;
}

export interface BashKillRequestData {
  chatId: string;
  pid: number;
}

export interface BashListRequestData {
  chatId: string;
}

// ---------- MCP 管理（连接层）----------

export type McpListRequestData = EmptyObjectData;

export interface McpGetRequestData {
  name: string;
}

export interface McpConnectRequestData {
  name: string;
}

export interface McpDisconnectRequestData {
  name: string;
}

/**
 * mcp.reload：name 给出→原子重载单个 server；name 省略→全量重载（重读 config）。
 */
export interface McpReloadRequestData {
  name?: string;
}

/**
 * subagent.result RPC 已于 2026-07-09 废弃（wait=true 改后端注入唤醒，见 docs/agent-pet.md §5.4）。
 * 原前端→后端结果回传通道移除：SubagentResultRequestData / SubagentResultResponseData / Method.SUBAGENT_RESULT / handler / schema 全删。
 */

// ---------- Config 设置（config.get / config.save）----------

/** config.get 请求：空参 */
export type ConfigGetRequestData = EmptyObjectData;

/** config.save 入参：除 server 外全部字段（结构同 ConfigRaw，supervision 为字符串、key 为 $ENV 占位符） */
export type ConfigSaveRequestData = ConfigRaw;

// ---------- Utils 工具（独立信息查询，不依赖 chat/brain 运行时）----------

/**
 * utils.models：基于用户提供的 provider/url/key 拉取可用模型列表。
 * provider 必填（区分调用方式），url 必填，key 可选（ollama 通常无需）。
 */
export interface UtilsModelsRequestData {
  provider: string;
  url: string;
  key?: string;
}

/**
 * utils.thinkingLevels：按模型名批量查询 ThinkingLevel 档位列表。
 * 用于前端 settings 渲染「深度思考」旋钮（不同模型暴露不同档位）。
 * 后端按 `.chery/model-thinking.yaml` 配置匹配，未命中返回 `["off", "on"]` 兜底。
 * models：1~N 个模型名（数组去重由调用方负责；空数组返回 `{}`）。
 */
export interface UtilsThinkingLevelsRequestData {
  models: string[];
}

// ---------- Env 环境变量 ----------

/** env.list 请求：空参 */
export type EnvListRequestData = EmptyObjectData;

// ---------- Utils 打开文件 ----------

/**
 * utils.openFile：打开指定文件（用配置的文本编辑器或系统默认）。
 * path：相对 .chery 目录的文件路径（如 config.yaml、.env、prompts/leader.md）。
 */
export interface UtilsOpenFileRequestData {
  path: string;
}

/**
 * utils.editors：获取系统可用的文本编辑器列表。
 * 返回主流编辑器（VSCode、记事本、TextEdit、gedit 等），供前端下拉选择。
 */
export type UtilsEditorsRequestData = EmptyObjectData;

/** utils.openConfigDir：固定打开后端主机的 CHERY_DIR/.chery，不接受客户端路径。 */
export type UtilsOpenConfigDirRequestData = EmptyObjectData;

// ========== Response Data ==========

export interface BrainListResponseData {
  brains: Array<{
    name: string;
    provider: string;
    model: string;
    thinking?: import("@/core/llm/adapter.js").ThinkingLevel;
    capabilities?: import("@/utils/config.js").BrainCapabilities;
    /** 上下文长度上限（token），供前端 context bar 显示用量。缺省 undefined */
    contextLimit?: number;
    /** 是否为「默认」预设 leader 角色的 brain（前端 AgentDialog 无 runtime 时预选默认 brain） */
    default?: boolean;
    senseGroups?: string | string[];
  }>;
  /** 当前已连接的 MCP server 名（供前端按 server 渲染开关） */
  mcpServers: string[];
}

export interface SenseListResponseData {
  senseGroups: Array<{
    name: string;
    supervision?: SupervisionLevel;
    senses: string[];
  }>;
}

/**
 * sense.tools 响应：代码维护的全部内置工具元信息。
 * name=原名（作 sense_groups 条目 key，如 "execute_command"）；
 * label=中文名（UI 显示）；description=解释（tooltip）。
 * 自定义/外部/MCP 工具不在内，前端组合框允许自由输入。
 */
export interface SenseToolMeta {
  name: string;
  label: string;
  description: string;
  /** glyph/emoji 字符串（pet bar 运行中工具图标用）。非内置工具前端 fallback ⚙。 */
  icon: string;
}

export interface SenseToolsResponseData {
  tools: SenseToolMeta[];
}

/** skills.list 响应：仅用户 `.chery/skills/` 中的技能；不含前端内置命令。 */
export interface SkillsListResponseData {
  skills: Array<{
    name: string;
    description: string;
    trigger?: string;
  }>;
}

/**
 * prompts.list 响应：.chery/prompts/ 下全部 .md 的相对路径（相对 .chery/，含 prompts/ 前缀）。
 * 供设置面板 systemPrompt 级联选择器建目录树；叶 value = 全路径 = 存储值。
 */
export interface PromptsListResponseData {
  prompts: string[];
}

export interface ChatCreateResponseData {
  chatId: string;
  /** 回显已生效的 runtime selection（含 MCP 开关） */
  brain: string;
  senseGroup: string;
  mcpServers: string[];
}

export interface ChatListResponseData {
  chats: Array<{
    chatId: string;
    createdAt: number;
    updatedAt: number;
    messageCount: number;
    /**
     * 角色（子 pet）关联主 chat 的 chatId；主 chat 为 null。
     * 前端据此溯源重建 pet 树（主 chat → 主 pet，子 chat 挂主 pet 附近）。CP1。
     */
    parentChatId: string | null;
    /**
     * 首条 user 消息截断（≤40 字符），供会话列表辨识。"指令"跳过规则待定（默认取首条 user 消息）。
     * 仅 includePreview=true 时返。CP8。
     */
    preview?: string;
    /**
     * user 角色消息数 = 会话轮次。仅 includePreview=true 时返。CP8。
     */
    turnCount?: number;
    /**
     * 上下文 token 用量比例（0-1）。仅 includePreview=true 时返（SessionList 渲染用）。
     * = 当前 chat 总 token / brain.contextLimit（见 computeContextUsage）。
     */
    contextUsage?: number;
    /**
     * 已用 token 数（估算值，字符数/4）。仅 includePreview=true 时返。配合 contextTotal 显示详情。
     */
    contextUsed?: number;
    /**
     * 上下文上限 token 数。仅 includePreview=true 时返。
     */
    contextTotal?: number;
    /**
     * 角色是否已完成（metadata.finished 解析）。前端据 finished===true 重建子 pet 为 ghost（灵魂态）。
     * 主 chat 恒 undefined。无论 includePreview 与否都返（initFromChats 重建 pet 树需）。
     */
    finished?: boolean;
    /**
     * 子 chat 是否被主 wait（metadata.wait=true，T9.10）。前端重连识别 wait-子：续跑 interrupted 子 +
     * 后端 rebuildWaitedChildren 已重建唤醒链。主 chat 恒 undefined。
     */
    wait?: boolean;
    /**
     * 主 chat 有已持久化、尚未由 chat.resume 消费的角色回复。前端重连后据此恢复主循环。
     */
    resumePending?: boolean;
  }>;
}

export interface PendingQuestionBatchData {
  batchId: string;
  assistantMessageId: string;
  createdAt: number;
  questions: Array<{
    questionId: string;
    position: number;
    question: string;
    header?: string;
    options: Array<{ label: string; description?: string }>;
    multiSelect: boolean;
    createdAt: number;
  }>;
}

export interface QuestionStateSnapshotData {
  /** 与 pendingQuestionBatches 同一 SQLite 读快照中的 chat event 游标。 */
  snapshotSeq: number;
  pendingQuestionBatches: PendingQuestionBatchData[];
}

export interface ChatGetResponseData extends QuestionStateSnapshotData {
  chatId: string;
  /** 末条为 pending sense 时 true，前端据此发起 chat.resume 撤回重跑 */
  canResume?: boolean;
  /**
   * 当前 chat 上下文 token 用量比例（0-1，相对 brain.contextLimit）。
   * 历史载入时返，前端据此更新 pet.contextUsage（ContextBar 渲染）。CP7。
   */
  contextUsage?: number;
  /** 已用 token 数（估算值）。配合 contextTotal 显示详情。 */
  contextUsed?: number;
  /** 上下文上限 token 数。 */
  contextTotal?: number;
}

export interface ChatDeleteResponseData {
  chatId: string;
}

export interface ChatContextUsageResponseData {
  chatId: string;
  contextUsage: number;
  /** 已用 token 数（估算值）。 */
  contextUsed: number;
  /** 上下文上限 token 数。 */
  contextTotal: number;
}

export interface ChatSendResponseData {
  chatId: string;
  /** 本次消息所属运行；运行中的 send 返当前活跃 run，而不是新建一条空流。 */
  runId: string;
  /** true 表示消息已入队，后续事件仍归属 runId。 */
  queued?: boolean;
  /**
   * 本次 send 写入的 user message 主键（= messages.id）。
   * 前端 sendMessage 据此即时 push user prompt 到 stream.history（带 msgId），
   * 下次 chat.get reload 时按 msgId 去重，避免重复。
   * 缺省：旧消息写入早于本字段时为 undefined（前端按 role+createdAt 兜底）。
   */
  userMsgId?: string;
}

export interface RuntimeSetResponseData {
  chatId: string;
  brain: string;
  senseGroup: string;
  mcpServers: string[];
}

export interface ChatResumeResponseData {
  chatId: string;
  /** 本次恢复所属运行。 */
  runId: string;
  /** true 表示已有运行，未启动第二条恢复流。 */
  alreadyRunning?: boolean;
}

export interface ChatSyncResponseData extends QuestionStateSnapshotData {
  chatId: string;
  latestSeq: number;
  minSeq?: number;
  /** true means history was evicted; client must reload a chat snapshot. */
  reset: boolean;
}

export interface ChatStartSpawnResponseData extends ChatSendResponseData {
  /** Existing task had already completed, so no child run was started. */
  alreadyFinished?: boolean;
}

export interface SenseApprovalResponseData {
  approvalId: string;
  action: string;
}

export interface SenseQuestionAnswerResponseData {
  questionId: string;
  cancelled: boolean;
}

export interface ChatAbortResponseData {
  chatId: string;
  /** 实际被中止的运行；chat 不在运行时省略。 */
  runId?: string;
  /** 是否存在并中止了活跃运行。 */
  aborted: boolean;
}

/**
 * 挂起 bash 进程信息（bash.list 返回）。
 * 结构对齐 agent/sense/processRegistry.ts BashProcessEntry（service 层不反向依赖 agent，独立定义）。
 */
export interface BashProcessInfo {
  pid: number;
  command: string;
  description: string;
  startedAt: number;
  /** 是否已被显式 kill（区分自然结束）。 */
  killed: boolean;
}

export interface BashKillResponseData {
  chatId: string;
  pid: number;
  /** 是否命中注册表并发送了 kill 信号（false = 该 pid 已不在挂起表中）。 */
  killed: boolean;
}

export interface BashListResponseData {
  chatId: string;
  processes: BashProcessInfo[];
}

export interface McpListResponseData {
  servers: McpServerInfo[];
}

export interface McpGetResponseData {
  server: McpServerInfo;
}

export interface McpConnectResponseData {
  server: McpServerInfo;
}

export interface McpDisconnectResponseData {
  server: McpServerInfo;
}

/**
 * mcp.reload 返回：全量 server 列表 + 本次操作汇总。
 * - 全量重载：connected/failed/totalSenses 覆盖所有 server。
 * - 单 server 重载：connected∈{0,1}、failed∈{0,1}、totalSenses 为该 server 注册数；servers 为重载后全量列表。
 */
export interface McpReloadResponseData {
  servers: McpServerInfo[];
  connected: number;
  failed: number;
  totalSenses: number;
}

/**
 * config.get 响应：.chery/config.yaml 原文（除 server 段）。
 * supervision 为字符串、key 仍为 $ENV 占位符、无路径补全（供设置面板编辑）。
 */
export type ConfigGetResponseData = ConfigRaw;

/**
 * config.save 响应：校验通过已写盘，需重启后端生效。
 * 校验失败走 error（INVALID_PARAMS + errors 列表），不返此 data。
 */
export interface ConfigSaveResponseData {
  needRestart: true;
  /** immediate=当前空闲、即将替换 worker；scheduled=等待 chat 空闲；manual=当前 worker 未受守护。 */
  restart: "immediate" | "scheduled" | "manual";
}

/**
 * utils.models 响应：归一化模型列表。
 * 请求失败时 models 为空数组，error 携带错误信息（非 RpcError，前端可展示）。
 */
export interface UtilsModelsResponseData {
  models: Array<{
    /** 模型 ID（API 原始值） */
    id: string;
    /** 显示名（缺省取 id） */
    name?: string;
    /** 所有者/组织（部分 API 提供） */
    ownedBy?: string;
  }>;
  /** 非空时表示请求失败，前端据此展示错误提示 */
  error?: string;
}

/** env.list 响应：.env 文件中的变量名列表 */
export interface EnvListResponseData {
  vars: string[];
}

/**
 * utils.thinkingLevels 响应：model → ThinkingLevel 列表。
 * 每个 model 一定有 entries（未命中兜底为 `["off", "on"]`）；空 models 入参返回 `levels: {}`。
 */
export interface UtilsThinkingLevelsResponseData {
  levels: Record<string, import("@/core/llm/adapter.js").ThinkingLevel[]>;
}

/** utils.openFile 响应：空（成功即打开，失败返 RpcError） */
export type UtilsOpenFileResponseData = EmptyObjectData;

/** utils.openConfigDir 响应：空（成功即打开，失败返 RpcError） */
export type UtilsOpenConfigDirResponseData = EmptyObjectData;

/**
 * utils.editors 响应：系统可用的文本编辑器列表。
 * editors：编辑器信息数组（name=显示名，command=启动命令，available=是否可用）。
 */
export interface UtilsEditorsResponseData {
  editors: Array<{
    /** 显示名称（如 "Visual Studio Code"） */
    name: string;
    /** 启动命令（如 "code"、"notepad"、"gedit"） */
    command: string;
    /** 是否在系统 PATH 中可用 */
    available: boolean;
  }>;
}

// ========== Chunk Data ==========

export type ChunkData = StreamChunkData | StagedChunkData;

export interface StreamChunkData {
  thinking?: string;
  content?: string;
  senseCall?: SenseCallDelta[];
}

export interface SenseCallDelta {
  index?: number;
  id?: string;
  name?: string;
  arguments?: string;
}

export interface StagedChunkData {
  type: "thinking_end" | "content_end" | "sense_end" | "reverse";
  /** 消息角色，用于区分消息来源（chat.get历史返回时使用） */
  role?: "user" | "assistant" | "system" | "sense" | "role" | "subagent"; // role=新（子 pet 回复）；subagent 仅旧历史消息兼容
  thinking?: string;
  content?: string;
  senseName?: string;
  arguments?: string;
  /** sense 调用 id（= trigger.id = sense message.id），用于前端关联 sense_end 与 role:sense 的 result content_end */
  id?: string;
  /** 消息主键 msgId（= messages.id）。thinking_end / content_end 携带；sense_end / reverse 不携带。前端合流去重用。 */
  msgId?: string;
  /** reverse 类型：被撤回的消息 id 列表（chat.send 恢复撤回整个当前周期时携带） */
  messageIds?: string[];
  /** 感官去重：该消息已被后续相同 hash 调用替换（chat.get 历史返回时携带，content 仍为原内容） */
  replace?: { state: boolean; by: string; content: string };
  /** 被替换时的原内容（溯源/前端展示） */
  originalContent?: string;
  /** content_end 携带：user=发送时配置（messages.runtime），assistant=前一条 user runtime（后端关联）。供前端 hover 历史消息显该消息用的 brain/工具 */
  runtime?: RuntimeSelection;
  /** 消息创建时间戳（ms），用于合并多 chat 历史时按时间排序 */
  createdAt?: number;
  /**
   * 消息来源 chatId（chat.get 历史回放时携带，= 当前回放的 chatId）。
   * 前端反向溯源：filter agentChatId === X 取该 agent 完整 history，无需正向溯源。
   * 旧消息（写入早于本字段）时为 undefined；前端按当前 chatId 兜底。
   */
  agentChatId?: string;
}

// ========== Notification Data ==========

export type NotificationData =
  | InterruptNotificationData
  | SenseStartedNotificationData
  | AcceptNotificationData
  | RejectedNotificationData
  | ConsumedNotificationData
  | ErrorNotificationData
  | ReplacedNotificationData
  | RoleCreatedNotificationData
  | RoleDestroyedNotificationData
  | RoleReplyNotificationData
  | QuestionRequestedNotificationData
  | QuestionAnsweredNotificationData
  | QuestionBatchRequestedNotificationData
  | QuestionBatchCompletedNotificationData
  | DoneNotificationData
  | null;

export interface InterruptNotificationData {
  approvalId: string;
  senseName: string;
  arguments: string;
  supervisionLevel: SupervisionLevel;
  needsApproval: boolean;
  /** 审批等待时长（ms，= global.approval_timeout）。前端据此与 createdAt 算倒计时。仅 needsApproval=true 时有意义。 */
  waitTime: number;
  /** 审批发起时间戳（ms，Date.now()）。前端倒计时 = waitTime - (now - createdAt)。 */
  createdAt: number;
}

/**
 * 感官开始执行（sense_end，仅 auto 工具推送；confirm/manual 走 interrupt）。
 * 前端据 id 维护「运行中工具」列表（pet bar 右侧显 icon）；accept（approvalId=id）到达时移除。
 * id = SenseTriggerChunk.id（= sense 调用 id，与 accept.approvalId 同源）。
 */
export interface SenseStartedNotificationData {
  id: string;
  senseName: string;
  arguments: string;
}

export interface AcceptNotificationData {
  approvalId: string;
  senseName: string;
  result: string;
}

export interface RejectedNotificationData {
  approvalId: string;
  senseName: string;
  reason: string;
}

export interface ConsumedNotificationData {
  count: number;
}

/**
 * chat.send/resume loop 结束（done notification data）。CP7。
 * contextUsage = 当前 chat 总 token / brain.contextLimit（0-1），前端据实时更新 pet.contextUsage。
 */
export interface DoneNotificationData {
  contextUsage: number;
  /** 已用 token 数（估算值）。前端据实时更新 pet.contextUsed。 */
  used?: number;
  /** 上下文上限 token 数。前端据实时更新 pet.contextTotal。 */
  total?: number;
  /**
   * 子 agent done 标记（仅子 chat 即 parent_chat_id 非空时携带=true）。
   * 前端据 finished===true 把子 pet 转 ghost（灵魂态）。主 chat 不带。done 时后端写 metadata.finished 持久化。
   */
  finished?: boolean;
  /**
   * 本轮末条 assistant 消息（仅 loop 结束末条为 assistant 时携带）。
   * 前端据此实时追加进 stream.history —— PetIcons 历史圆点气泡即时显最新回复，
   * 不再等下次 chat.get 重载才补齐（否则圆点长期显旧内容）。
   * msgId = messages.id，供下次 chat.get 合流按 msgId 去重，避免重复。
   * agentChatId = 该消息来源 chatId（默认 = 当前 chat 上下文；冗余携带供前端反向溯源 ——
   * 后续可按 agentChatId filter 取该 agent 完整 history，无需正向溯源）。
   */
  finalMessage?: {
    msgId: string;
    role: "assistant";
    content: string;
    thinking?: string;
    createdAt: number;
    agentChatId?: string;
  };
}

export interface ErrorNotificationData {
  message: string;
}

/**
 * 感官去重命中（read_file hash 相同 = 文件未变动）：
 * 历史 sense 结果被新读取替换。web 据此实时更新对应历史 sense block。
 */
export interface ReplacedNotificationData {
  /** 被替换的历史 sense message id（= sense call id） */
  id: string;
  /** 替换后的说明文字（主显，剔除冗长重复内容） */
  content: string;
  /** 原长内容（折叠溯源） */
  originalContent: string;
  /** 触发替换的新 sense id */
  by: string;
}

/**
 * 角色派发（spawn_role sense 执行时推送）。
 * 前端据 type+prompt 创建子 pet 并驱动子 chat（前端驱动架构，见 docs/agent-pet.md §2/§5.1）。
 * 此类异步事件没有 requestId；外层 chatId 为 parentChatId，前端按 chatId 路由。
 */
export interface RoleCreatedNotificationData {
  /** Persisted task id. The client must call chat.startSpawn(taskId), not chat.send directly. */
  taskId: string;
  /** 子 chat id（前端据此驱动子 chat.send） */
  chatId: string;
  /** 主 chat id（前端溯源 pet 树） */
  parentChatId: string;
  /** 角色类型（config.roles 键名） */
  type: string;
  /** 交付角色的任务 prompt */
  prompt: string;
  /** 角色用的 brain 名 */
  brain: string;
  /** 角色启用的感官组（单组） */
  senseGroup: string;
  /** 是否等待结果（2026-07-09 后信息性：wait=true 子完成由 role_reply 唤主，前端两态均跑子） */
  wait: boolean;
}

/**
 * wait=true 子完成唤主（T9 B1 架构，见 docs/agent-pet.md §5.4）。
 * 子 loop 结束 + waitedChildren 命中时后端推：已把子结果以 role:role 注入主 chat DB，
 * 前端收此 notification → 自动 chat.resume(parentChatId) 跑唤醒轮。外层 chatId = parentChatId。
 */
export interface RoleReplyNotificationData {
  /** 主 chat id（前端据此 resume 主） */
  parentChatId: string;
  /** 子 chat id */
  childChatId: string;
  /** 角色类型（前端展示用） */
  type: string;
  /** 角色结果（即时展示；权威内容已注入主 chat DB，role:role） */
  content: string;
  /**
   * 触发本次 spawn 的 sense call id（= 主 chat sense message.id）。
   * 前端 F 改动：点击 role 子头像 smooth scroll 回主 chat 的 sense 调用框。
   * 旧 chat 无此字段（写入早于 E 改动）时为 undefined。
   */
  spawnSenseCallId?: string;
  /** 注入主 chat 的 role:role 行 msgId（= addMessage 第一参）。前端合流主+子历史时按 msgId 去重。 */
  msgId: string;
}

/**
 * 角色销毁（destroy_role sense 执行时推送，CP6）。
 * 前端据 chatId 移除对应子 pet 并关闭子 chat UI。
 * requestId 为主 chat id（与 role_created 同路由规则）。
 */
export interface RoleDestroyedNotificationData {
  /** 被销毁的子 chat id */
  chatId: string;
}

/** 旧版逐题提问事件，仅保留历史协议兼容。 */
export interface QuestionRequestedNotificationData {
  questionId: string;
  senseName: "ask_user_question";
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
  /** 等待时长（ms，= global.approval_timeout）。0 = 不超时。 */
  waitTime: number;
  /** 发起时间戳（ms，Date.now()）。前端倒计时 = waitTime - (now - createdAt)。 */
  createdAt: number;
}

/** 旧版逐题完成事件，仅保留历史协议兼容。 */
export interface QuestionAnsweredNotificationData {
  questionId: string;
  /** 可选答案文本（权威内容已写入 sense content；此字段仅作即时展示/日志） */
  answer?: string;
}

/** 后端持久化完成后发出的完整问题批次；事件可安全重放且按 batchId 幂等。 */
export interface QuestionBatchRequestedNotificationData extends PendingQuestionBatchData {}

/** 批次原子提交完成。仅用于清理客户端投影；是否 resume 由 batchAnswer RPC 响应决定。 */
export interface QuestionBatchCompletedNotificationData {
  batchId: string;
}

// ========== Error ==========

export interface RpcError {
  code: string;
  message: string;
}

// ========== 方法常量 ==========

export const Method = {
  // Brain / Sense 列表
  BRAIN_LIST: "brain.list",
  SENSE_LIST: "sense.list",
  // 列出代码维护的全部内置工具（name/label/description），供设置面板感官分组下拉
  SENSE_TOOLS: "sense.tools",
  // 实时列出用户配置目录中的 Skill 元数据，供发送窗口 / 命令菜单使用
  SKILLS_LIST: "skills.list",
  // 递归列出 .chery/prompts/ 下全部 .md（含子文件夹），供设置面板 systemPrompt 级联选择器
  PROMPTS_LIST: "prompts.list",

  // Runtime 设置（每轮可换，必须原子携带 brain + senseGroups）
  RUNTIME_SET: "runtime.set",
  // 当前会话临时角色编制（不持久化）
  SESSION_RUNTIME_SET: "session.runtime.set",

  // Chat 管理
  CHAT_CREATE: "chat.create",
  CHAT_LIST: "chat.list",
  CHAT_GET: "chat.get",
  CHAT_DELETE: "chat.delete",
  CHAT_CONTEXT_USAGE: "chat.contextUsage",
  CHAT_SEND: "chat.send",
  CHAT_RESUME: "chat.resume",
  CHAT_SYNC: "chat.sync",
  CHAT_START_SPAWN: "chat.startSpawn",

  // Sense 审批
  SENSE_APPROVAL: "sense.approval",
  // Sense 问答（ask_user_question 感官答案回传）
  SENSE_QUESTION_ANSWER: "sense.question.answer",
  SENSE_QUESTION_BATCH_ANSWER: "sense.question.batchAnswer",
  // Chat 中止（切换 chat：清内存 + 退出挂起 generator，不动 DB，pending 保留供下次重新审核）
  CHAT_ABORT: "chat.abort",

  // Bash 进程管理（挂起子进程的查询 / 显式杀死）
  BASH_LIST: "bash.list",
  BASH_KILL: "bash.kill",

  // MCP 管理（连接层热重载：list/get/connect/disconnect/reload）
  MCP_LIST: "mcp.list",
  MCP_GET: "mcp.get",
  MCP_CONNECT: "mcp.connect",
  MCP_DISCONNECT: "mcp.disconnect",
  MCP_RELOAD: "mcp.reload",

  // Config 设置（读写 .chery/config.yaml，除 server 段，重启生效）
  CONFIG_GET: "config.get",
  CONFIG_SAVE: "config.save",

  // Utils 工具（独立信息查询，不依赖 chat/brain 运行时）
  UTILS_MODELS: "utils.models",

  // Env 环境变量（读 .env 变量名列表，供前端密钥下拉）
  ENV_LIST: "env.list",

  // 打开文件（用配置的编辑器或系统默认）
  UTILS_OPEN_FILE: "utils.openFile",

  // 固定打开后端主机的 .chery 配置目录
  UTILS_OPEN_CONFIG_DIR: "utils.openConfigDir",

  // 编辑器列表（获取系统可用的文本编辑器）
  UTILS_EDITORS: "utils.editors",

  // 模型档位（按 model 名批量查 ThinkingLevel，前端旋钮用）
  UTILS_THINKING_LEVELS: "utils.thinkingLevels",
} as const;

/**
 * Method 类型别名：所有合法 method 字符串的联合。
 * Request.method 用此类型（非裸 string），router.register 据 Method 约束注册键。
 */
export type Method = (typeof Method)[keyof typeof Method];

/**
 * RPC 方法级契约：Method 与 params/result 保持一一对应。
 * RequestData/ResponseData 仅是动态传输边界的派生联合；业务 handler 使用 ParamsOf/ResultOf。
 */
export interface RpcMethodMap {
  [Method.BRAIN_LIST]: { params: BrainListRequestData; result: BrainListResponseData };
  [Method.SENSE_LIST]: { params: SenseListRequestData; result: SenseListResponseData };
  [Method.SENSE_TOOLS]: { params: SenseToolsRequestData; result: SenseToolsResponseData };
  [Method.SKILLS_LIST]: { params: SkillsListRequestData; result: SkillsListResponseData };
  [Method.PROMPTS_LIST]: { params: PromptsListRequestData; result: PromptsListResponseData };
  [Method.RUNTIME_SET]: { params: RuntimeSetRequestData; result: RuntimeSetResponseData };
  [Method.SESSION_RUNTIME_SET]: { params: SessionRuntimeSetRequestData; result: SessionRuntimeSetResponseData };
  [Method.CHAT_CREATE]: { params: ChatCreateRequestData; result: ChatCreateResponseData };
  [Method.CHAT_LIST]: { params: ChatListRequestData; result: ChatListResponseData };
  [Method.CHAT_GET]: { params: ChatGetRequestData; result: ChatGetResponseData };
  [Method.CHAT_DELETE]: { params: ChatDeleteRequestData; result: ChatDeleteResponseData };
  [Method.CHAT_CONTEXT_USAGE]: { params: ChatContextUsageRequestData; result: ChatContextUsageResponseData };
  [Method.CHAT_SEND]: { params: ChatSendRequestData; result: ChatSendResponseData };
  [Method.CHAT_RESUME]: { params: ChatResumeRequestData; result: ChatResumeResponseData };
  [Method.CHAT_SYNC]: { params: ChatSyncRequestData; result: ChatSyncResponseData };
  [Method.CHAT_START_SPAWN]: { params: ChatStartSpawnRequestData; result: ChatStartSpawnResponseData };
  [Method.SENSE_APPROVAL]: { params: SenseApprovalRequestData; result: SenseApprovalResponseData };
  [Method.SENSE_QUESTION_ANSWER]: { params: SenseQuestionAnswerRequestData; result: SenseQuestionAnswerResponseData };
  [Method.SENSE_QUESTION_BATCH_ANSWER]: { params: SenseQuestionBatchAnswerRequestData; result: SenseQuestionBatchAnswerResponseData };
  [Method.CHAT_ABORT]: { params: ChatAbortRequestData; result: ChatAbortResponseData };
  [Method.BASH_LIST]: { params: BashListRequestData; result: BashListResponseData };
  [Method.BASH_KILL]: { params: BashKillRequestData; result: BashKillResponseData };
  [Method.MCP_LIST]: { params: McpListRequestData; result: McpListResponseData };
  [Method.MCP_GET]: { params: McpGetRequestData; result: McpGetResponseData };
  [Method.MCP_CONNECT]: { params: McpConnectRequestData; result: McpConnectResponseData };
  [Method.MCP_DISCONNECT]: { params: McpDisconnectRequestData; result: McpDisconnectResponseData };
  [Method.MCP_RELOAD]: { params: McpReloadRequestData; result: McpReloadResponseData };
  [Method.CONFIG_GET]: { params: ConfigGetRequestData; result: ConfigGetResponseData };
  [Method.CONFIG_SAVE]: { params: ConfigSaveRequestData; result: ConfigSaveResponseData };
  [Method.UTILS_MODELS]: { params: UtilsModelsRequestData; result: UtilsModelsResponseData };
  [Method.ENV_LIST]: { params: EnvListRequestData; result: EnvListResponseData };
  [Method.UTILS_OPEN_FILE]: { params: UtilsOpenFileRequestData; result: UtilsOpenFileResponseData };
  [Method.UTILS_OPEN_CONFIG_DIR]: { params: UtilsOpenConfigDirRequestData; result: UtilsOpenConfigDirResponseData };
  [Method.UTILS_EDITORS]: { params: UtilsEditorsRequestData; result: UtilsEditorsResponseData };
  [Method.UTILS_THINKING_LEVELS]: { params: UtilsThinkingLevelsRequestData; result: UtilsThinkingLevelsResponseData };
}

export type ParamsOf<M extends Method> = RpcMethodMap[M]["params"];
export type ResultOf<M extends Method> = RpcMethodMap[M]["result"];
export type RequestData = ParamsOf<Method>;
export type ResponseData = ResultOf<Method>;

// ========== 错误码常量 ==========

export const ErrorCode = {
  METHOD_NOT_FOUND: "METHOD_NOT_FOUND",
  INTERNAL: "INTERNAL",
  TIMEOUT: "TIMEOUT",
  // MCP 管理：资源不存在 / 参数非法（handler 显式返回，非抛错走 INTERNAL）
  NOT_FOUND: "NOT_FOUND",
  INVALID_PARAMS: "INVALID_PARAMS",
  /** 资源当前状态不允许该操作，例如用旧 runId 中止已替换的新运行。 */
  CONFLICT: "CONFLICT",
} as const;

// ========== 工厂函数 ==========

export function createResponse<TData extends ResponseData = ResponseData>(
  requestId: string,
  success: boolean,
  data?: TData,
  error?: RpcError,
): Response<TData> {
  return {
    id: randomUUID(),
    kind: "response",
    requestId,
    success,
    data,
    error,
  };
}

export function createChunk(
  type: "stream" | "staged",
  requestId: string,
  data: ChunkData,
  context: EventContext = {},
): Chunk {
  return {
    kind: "chunk",
    type,
    requestId,
    ...(context.chatId ? { chatId: context.chatId } : {}),
    ...(context.runId ? { runId: context.runId } : {}),
    data,
  };
}

export function createNotification(
  type: NotificationType,
  requestId: string | undefined,
  data: NotificationData,
  context: EventContext = {},
): Notification {
  return {
    kind: "notification",
    type,
    ...(requestId ? { requestId } : {}),
    ...(context.chatId ? { chatId: context.chatId } : {}),
    ...(context.runId ? { runId: context.runId } : {}),
    data,
  };
}

export function createError(code: string, message: string): RpcError {
  return { code, message };
}

// ========== 类型守卫 ==========

export function isRequest(msg: unknown): msg is Request {
  return typeof msg === "object" && msg !== null && (msg as { kind?: string }).kind === "request";
}

export function isResponse(msg: unknown): msg is Response {
  return typeof msg === "object" && msg !== null && (msg as { kind?: string }).kind === "response";
}
