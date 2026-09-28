import { Method as ProtocolMethod } from '@chery/protocol'
import { InternalCommand } from '../internalCommand.js'
import type { ConfigRaw } from '@/utils/config.js'
import type {
  BashKillRequestData,
  BashKillResponseData,
  BashListRequestData,
  BashListResponseData,
  BrainListRequestData,
  BrainListResponseData,
  ChatAbortRequestData,
  ChatAbortResponseData,
  ChatAbortTaskRequestData,
  ChatAbortTaskResponseData,
  ChatAttachRequestData,
  ChatAttachResponseData,
  ChatBranchActivateRequestData,
  ChatBranchActivateResponseData,
  ChatBranchCreateRequestData,
  ChatBranchCreateResponseData,
  ChatBranchPreviewRequestData,
  ChatBranchPreviewResponseData,
  ChatCloseRequestData,
  ChatCloseResponseData,
  ChatContextUsageRequestData,
  ChatContextUsageResponseData,
  ChatCreateRequestData,
  ChatCreateResponseData,
  ChatDeleteRequestData,
  ChatDeleteResponseData,
  ChatEpochListRequestData,
  ChatEpochListResponseData,
  ChatGetRequestData,
  ChatGetResponseData,
  ChatInputSubmitRequestData,
  ChatInputSubmitResponseData,
  ChatListRequestData,
  ChatListResponseData,
  ChatOpenRequestData,
  ChatOpenResponseData,
  ChatOverviewCloseRequestData,
  ChatOverviewCloseResponseData,
  ChatOverviewOpenRequestData,
  ChatOverviewOpenResponseData,
  ChatPromptSnapshotRequestData,
  ChatPromptSnapshotResponseData,
  ChatResumeRequestData,
  ChatResumeResponseData,
  ChatResumeTreeRequestData,
  ChatResumeTreeResponseData,
  ChatRouteSuggestRequestData,
  ChatRouteSuggestResponseData,
  ChatSendRequestData,
  ChatSendResponseData,
  ChatSendToChildRequestData,
  ChatSendToChildResponseData,
  ChatStartSpawnRequestData,
  ChatStartSpawnResponseData,
  ChatStopChildRequestData,
  ChatStopChildResponseData,
  ChatSyncRequestData,
  ChatSyncResponseData,
  ChatTaskListRequestData,
  ChatTaskListResponseData,
  ChatTaskResultViewRequestData,
  ChatTaskResultViewResponseData,
  ChatTimelineGenerationGetRequestData,
  ChatTimelineGenerationGetResponseData,
  ChatTimelineGetRequestData,
  ChatTimelineGetResponseData,
  ChatTimelineNodeGetRequestData,
  ChatTimelineNodeGetResponseData,
  CommandListResponseData,
  ConfigGetRequestData,
  ConfigGetResponseData,
  ConfigSaveRequestData,
  ConfigSaveResponseData,
  ConfigWorkspaceBrowseListRequestData,
  ConfigWorkspaceBrowseListResponseData,
  ConfigWorkspaceBrowseStartRequestData,
  ConfigWorkspaceBrowseStartResponseData,
  ConfigWorkspaceValidateRequestData,
  ConfigWorkspaceValidateResponseData,
  CredentialsDeleteRequestData,
  CredentialsDeleteResponseData,
  CredentialsListRequestData,
  CredentialsListResponseData,
  CredentialsSaveRequestData,
  CredentialsSaveResponseData,
  EmptyObjectData,
  EnvListRequestData,
  EnvListResponseData,
  HooksEventsRequestData,
  HooksEventsResponseData,
  HooksGetRequestData,
  HooksGetResponseData,
  HooksSaveRequestData,
  HooksSaveResponseData,
  InteractionApprovalDecideRequestData,
  InteractionApprovalDecideResponseData,
  InteractionListRequestData,
  InteractionListResponseData,
  InteractionQuestionAnswerRequestData,
  InteractionQuestionAnswerResponseData,
  McpConnectRequestData,
  McpConnectResponseData,
  McpDisconnectRequestData,
  McpDisconnectResponseData,
  McpGetRequestData,
  McpGetResponseData,
  McpListRequestData,
  McpListResponseData,
  McpReloadRequestData,
  McpReloadResponseData,
  PluginsCheckAllUpdatesRequestData,
  PluginsCheckAllUpdatesResponseData,
  PluginsCheckUpdateRequestData,
  PluginsCheckUpdateResponseData,
  PluginsCommitRequestData,
  PluginsCommitResponseData,
  PluginsImportUrlRequestData,
  PluginsImportUrlResponseData,
  PluginsListRequestData,
  PluginsListResponseData,
  PluginsPreImportUrlRequestData,
  PluginsPreImportUrlResponseData,
  PluginsUninstallRequestData,
  PluginsUninstallResponseData,
  PluginsUpdateRequestData,
  PluginsUpdateResponseData,
  PromptsListRequestData,
  PromptsListResponseData,
  RulesListRequestData,
  RulesListResponseData,
  RuntimeSetRequestData,
  RuntimeSetResponseData,
  SenseApprovalRequestData,
  SenseApprovalResponseData,
  SenseListRequestData,
  SenseListResponseData,
  SenseQuestionAnswerRequestData,
  SenseQuestionAnswerResponseData,
  SenseQuestionBatchAnswerRequestData,
  SenseQuestionBatchAnswerResponseData,
  SenseToolsDocsRequestData,
  SenseToolsDocsResponseData,
  SenseToolsRequestData,
  SenseToolsResponseData,
  SessionRuntimeSetRequestData,
  SessionRuntimeSetResponseData,
  SkillsCheckAllSourcesRequestData,
  SkillsCheckAllSourcesResponseData,
  SkillsCheckSourceRequestData,
  SkillsCheckSourceResponseData,
  SkillsCommitRequestData,
  SkillsCommitResponseData,
  SkillsDeleteRequestData,
  SkillsDeleteResponseData,
  SkillsDeleteSourceRequestData,
  SkillsDeleteSourceResponseData,
  SkillsImportUrlRequestData,
  SkillsImportUrlResponseData,
  SkillsListNamesRequestData,
  SkillsListNamesResponseData,
  SkillsListRequestData,
  SkillsListResponseData,
  SkillsListSourcesRequestData,
  SkillsListSourcesResponseData,
  SkillsPreImportUrlRequestData,
  SkillsPreImportUrlResponseData,
  SkillsResyncAllSourcesRequestData,
  SkillsResyncAllSourcesResponseData,
  SkillsResyncSourceRequestData,
  SkillsResyncSourceResponseData,
  TerminalCloseRequestData,
  TerminalCloseResponseData,
  TerminalCreateRequestData,
  TerminalCreateResponseData,
  TerminalInputRequestData,
  TerminalInputResponseData,
  TerminalResizeRequestData,
  TerminalResizeResponseData,
  UtilsEditorsRequestData,
  UtilsEditorsResponseData,
  UtilsModelRecommendationRequestData,
  UtilsModelRecommendationResponseData,
  UtilsModelsRequestData,
  UtilsModelsResponseData,
  UtilsOpenConfigDirRequestData,
  UtilsOpenConfigDirResponseData,
  UtilsOpenFileRequestData,
  UtilsOpenFileResponseData,
  UtilsTestConnectionRequestData,
  UtilsTestConnectionResponseData,
  WorkspaceFilesListRequestData,
  WorkspaceFilesListResponseData,
  WorkspaceFilesReadRequestData,
  WorkspaceFilesReadResponseData,
  WorkspaceGitCheckoutRequestData,
  WorkspaceGitCheckoutResponseData,
  WorkspaceGitStatusRequestData,
  WorkspaceGitStatusResponseData,
} from '../types.js'

// ========== 方法常量 ==========

export const Method = {
  // Brain / Sense 列表
  BRAIN_LIST: 'brain.list',
  SENSE_LIST: 'sense.list',
  // 列出代码维护的全部内置工具（name/label/description），供设置面板感官分组下拉
  SENSE_TOOLS: 'sense.tools',
  // 统一获取内置工具完整说明文档（全量或按 name 列表过滤），供设置面板 hover 展示
  SENSE_TOOLS_DOCS: 'sense.tools.docs',
  // 实时列出用户配置目录中的 Skill 元数据，供发送窗口 / 命令菜单使用
  SKILLS_LIST: 'skills.list',
  // 轻量接口：仅返回 skill/plugin 名称列表（不算 token），供角色卡下拉
  SKILLS_LIST_NAMES: 'skills.listNames',
  // Skill 导入：preImport 拉分支 + 探测鉴权/git；importUrl 选分支 clone 到 staging 分析候选；commit 落盘（写来源索引）；delete 删独立 skill（清索引）；listSources/resyncSource/deleteSource 管 git 来源中央索引
  SKILLS_PRE_IMPORT_URL: 'skills.preImportUrl',
  SKILLS_IMPORT_URL: 'skills.importUrl',
  SKILLS_COMMIT: 'skills.commit',
  SKILLS_DELETE: 'skills.delete',
  SKILLS_LIST_SOURCES: 'skills.listSources',
  SKILLS_CHECK_SOURCE: 'skills.checkSource',
  SKILLS_CHECK_ALL_SOURCES: 'skills.checkAllSources',
  SKILLS_RESYNC_SOURCE: 'skills.resyncSource',
  SKILLS_DELETE_SOURCE: 'skills.deleteSource',
  // 批量重拉全部 Skill 来源（非交互：serial 串行；写 lastSyncError 持久化失败 marker）
  SKILLS_RESYNC_ALL_SOURCES: 'skills.resyncAllSources',
  // 递归列出 .chery/prompt/ 下全部 .md（含子文件夹，排除 system.md），供设置面板 systemPrompt 级联选择器
  PROMPTS_LIST: 'prompts.list',
  // 列出 .chery/rule/ 下全部 .yaml（排除基准 base.yaml），供设置面板预设「规则文件」下拉
  RULES_LIST: 'rules.list',

  // Runtime 设置（每轮可换，必须原子携带 brain + senseGroups）
  RUNTIME_SET: 'runtime.set',
  // 当前会话临时角色编制（不持久化）
  SESSION_RUNTIME_SET: 'session.runtime.set',

  // Chat 管理
  CHAT_CREATE: 'chat.create',
  CHAT_LIST: 'chat.list',
  CHAT_TASK_LIST: 'chat.task.list',
  CHAT_TASK_RESULT_VIEW: 'chat.task.result.view',
  CHAT_ROUTE_SUGGEST: 'chat.route.suggest',
  CHAT_DELETE: 'chat.delete',
  CHAT_ARCHIVE: 'chat.archive',
  CHAT_ARCHIVE_LIST: 'chat.archive.list',
  CHAT_BRANCH_PREVIEW: 'chat.branch.preview',
  CHAT_BRANCH_CREATE: 'chat.branch.create',
  CHAT_BRANCH_ACTIVATE: 'chat.branch.activate',
  CHAT_ABORT_TASK: 'chat.abortTask',
  CHAT_CONTEXT_USAGE: 'chat.contextUsage',
  /** 重建 chat 当前 runtime 的 system prompt 全文 + 工具定义，供前端历史抽屉「上下文」hover 面板展示。 */
  CHAT_PROMPT_SNAPSHOT: 'chat.promptSnapshot',
  /** List immutable context epochs; only the active epoch is executable. */
  CHAT_EPOCH_LIST: 'chat.epoch.list',
  CHAT_USAGE_DETAIL: ProtocolMethod.CHAT_USAGE_DETAIL,
  CHAT_USAGE_SUMMARIES: ProtocolMethod.CHAT_USAGE_SUMMARIES,
  CHAT_USAGE_ROUNDS: ProtocolMethod.CHAT_USAGE_ROUNDS,
  CHAT_USAGE_DAILY: ProtocolMethod.CHAT_USAGE_DAILY,
  CHAT_USAGE_DAY_TASKS: ProtocolMethod.CHAT_USAGE_DAY_TASKS,
  CHAT_USAGE_OPERATIONS: ProtocolMethod.CHAT_USAGE_OPERATIONS,
  CHAT_CONTEXT_CONTENT: ProtocolMethod.CHAT_CONTEXT_CONTENT,
  CHAT_INPUT_SUBMIT: 'chat.input.submit',
  CHAT_TIMELINE_GET: 'chat.timeline.get',
  CHAT_TIMELINE_GENERATION_GET: 'chat.timeline.generation.get',
  // lite profile：按需拉取单个节点的完整详情（P0，canonical §3.6.3；低频用户触发，只读）
  CHAT_TIMELINE_NODE_GET: 'chat.timeline.node.get',
  CHAT_RUN_RESUME: 'chat.run.resume',
  CHAT_RESUME_TREE: 'chat.resumeTree',
  CHAT_OPEN: 'chat.open',
  CHAT_CLOSE: 'chat.close',
  CHAT_OVERVIEW_OPEN: 'chat.overview.open',
  CHAT_OVERVIEW_CLOSE: 'chat.overview.close',
  CHAT_STOP_CHILD: 'chat.stopChild',

  // Sense 审批
  INTERACTION_LIST: 'interaction.list',
  INTERACTION_APPROVAL_DECIDE: 'interaction.approval.decide',
  INTERACTION_QUESTION_ANSWER: 'interaction.question.answer',
  // Sense 问答（ask_user_question 感官答案回传）
  // Chat 中止（切换 chat：清内存 + 退出挂起 generator，不动 DB，pending 保留供下次重新审核）
  CHAT_ABORT: 'chat.abort',
  // Chat 重连（F5 后重连运行中 run，重定向后续实时输出到本连接）

  // Bash 进程管理（挂起子进程的查询 / 显式杀死）
  BASH_LIST: 'bash.list',
  BASH_KILL: 'bash.kill',

  // MCP 管理（连接层热重载：list/get/connect/disconnect/reload）
  MCP_LIST: 'mcp.list',
  MCP_GET: 'mcp.get',
  MCP_CONNECT: 'mcp.connect',
  MCP_DISCONNECT: 'mcp.disconnect',
  MCP_RELOAD: 'mcp.reload',

  // Config 设置（读写 .chery/config.yaml，除 server 段，重启生效）
  CONFIG_GET: 'config.get',
  CONFIG_WORKSPACE_VALIDATE: 'config.workspace.validate',
  CONFIG_WORKSPACE_BROWSE_START: 'config.workspace.browse.start',
  CONFIG_WORKSPACE_BROWSE_LIST: 'config.workspace.browse.list',
  WORKSPACE_FILES_LIST: ProtocolMethod.WORKSPACE_FILES_LIST,
  WORKSPACE_FILES_READ: ProtocolMethod.WORKSPACE_FILES_READ,
  WORKSPACE_GIT_STATUS: ProtocolMethod.WORKSPACE_GIT_STATUS,
  WORKSPACE_GIT_CHECKOUT: ProtocolMethod.WORKSPACE_GIT_CHECKOUT,
  TERMINAL_CREATE: ProtocolMethod.TERMINAL_CREATE,
  TERMINAL_INPUT: ProtocolMethod.TERMINAL_INPUT,
  TERMINAL_RESIZE: ProtocolMethod.TERMINAL_RESIZE,
  TERMINAL_CLOSE: ProtocolMethod.TERMINAL_CLOSE,
  CONFIG_SAVE: 'config.save',
  CONFIG_PREVIEW: 'config.preview',
  CONFIG_APPLY_STATUS: 'config.apply.status',

  // Hooks 管理（读写 .chery/hooks/hooks.json，独立于 config.yaml）
  HOOKS_GET: 'hooks.get',
  HOOKS_SAVE: 'hooks.save',
  HOOKS_EVENTS: 'hooks.events',

  // Utils 工具（独立信息查询，不依赖 chat/brain 运行时）
  UTILS_MODELS: 'utils.models',
  UTILS_TEST_CONNECTION: 'utils.testConnection',

  // Env 环境变量（读 .env 变量名列表，供前端密钥下拉）
  ENV_LIST: 'env.list',

  // 打开文件（用配置的编辑器或系统默认）
  UTILS_OPEN_FILE: 'utils.openFile',

  // 固定打开后端主机的 .chery 配置目录
  UTILS_OPEN_CONFIG_DIR: 'utils.openConfigDir',

  // 编辑器列表（获取系统可用的文本编辑器）
  UTILS_EDITORS: 'utils.editors',

  // 模型档位（按 model 名批量查 ThinkingLevel，前端旋钮用）
  UTILS_MODEL_RECOMMENDATION: 'utils.modelRecommendation',

  // 内置命令管理（settings 「指令」tab 后端；只读枚举 .chery/command/*.md，不可增删改）
  COMMAND_LIST: 'command.list',

  // 插件管理（settings 「插件」tab 后端）：GitHub URL git clone（分支选择 + 凭据池 + 版本检查）
  PLUGINS_LIST: 'plugins.list',
  PLUGINS_PRE_IMPORT_URL: 'plugins.preImportUrl',
  PLUGINS_IMPORT_URL: 'plugins.importUrl',
  PLUGINS_COMMIT: 'plugins.commit',
  PLUGINS_CHECK_UPDATE: 'plugins.checkUpdate',
  PLUGINS_CHECK_ALL_UPDATES: 'plugins.checkAllUpdates',
  PLUGINS_UPDATE: 'plugins.update',
  PLUGINS_UNINSTALL: 'plugins.uninstall',

  // 凭据池（通用：plugins / skills / 未来 commands 共享；密令后端加密存储，list 不回密令）
  CREDENTIALS_LIST: 'credentials.list',
  CREDENTIALS_SAVE: 'credentials.save',
  CREDENTIALS_DELETE: 'credentials.delete',
} as const satisfies typeof ProtocolMethod

/**
 * Method 类型别名：所有合法 method 字符串的联合。
 * Request.method 用此类型（非裸 string），router.register 据 Method 约束注册键。
 */
export type Method = (typeof Method)[keyof typeof Method]

/**
 * RPC 方法级契约：Method 与 params/result 保持一一对应。
 * RequestData/ResponseData 仅是动态传输边界的派生联合；业务 handler 使用 ParamsOf/ResultOf。
 */
export interface RpcMethodMap {
  [Method.BRAIN_LIST]: { params: BrainListRequestData; result: BrainListResponseData }
  [Method.SENSE_LIST]: { params: SenseListRequestData; result: SenseListResponseData }
  [Method.SENSE_TOOLS]: { params: SenseToolsRequestData; result: SenseToolsResponseData }
  [Method.SENSE_TOOLS_DOCS]: {
    params: SenseToolsDocsRequestData
    result: SenseToolsDocsResponseData
  }
  [Method.SKILLS_LIST]: { params: SkillsListRequestData; result: SkillsListResponseData }
  [Method.SKILLS_LIST_NAMES]: {
    params: SkillsListNamesRequestData
    result: SkillsListNamesResponseData
  }
  [Method.SKILLS_PRE_IMPORT_URL]: {
    params: SkillsPreImportUrlRequestData
    result: SkillsPreImportUrlResponseData
  }
  [Method.SKILLS_IMPORT_URL]: {
    params: SkillsImportUrlRequestData
    result: SkillsImportUrlResponseData
  }
  [Method.SKILLS_COMMIT]: { params: SkillsCommitRequestData; result: SkillsCommitResponseData }
  [Method.SKILLS_DELETE]: { params: SkillsDeleteRequestData; result: SkillsDeleteResponseData }
  [Method.SKILLS_LIST_SOURCES]: {
    params: SkillsListSourcesRequestData
    result: SkillsListSourcesResponseData
  }
  [Method.SKILLS_CHECK_SOURCE]: {
    params: SkillsCheckSourceRequestData
    result: SkillsCheckSourceResponseData
  }
  [Method.SKILLS_CHECK_ALL_SOURCES]: {
    params: SkillsCheckAllSourcesRequestData
    result: SkillsCheckAllSourcesResponseData
  }
  [Method.SKILLS_RESYNC_SOURCE]: {
    params: SkillsResyncSourceRequestData
    result: SkillsResyncSourceResponseData
  }
  [Method.SKILLS_DELETE_SOURCE]: {
    params: SkillsDeleteSourceRequestData
    result: SkillsDeleteSourceResponseData
  }
  [Method.SKILLS_RESYNC_ALL_SOURCES]: {
    params: SkillsResyncAllSourcesRequestData
    result: SkillsResyncAllSourcesResponseData
  }
  [Method.PROMPTS_LIST]: { params: PromptsListRequestData; result: PromptsListResponseData }
  [Method.RULES_LIST]: { params: RulesListRequestData; result: RulesListResponseData }
  [Method.RUNTIME_SET]: { params: RuntimeSetRequestData; result: RuntimeSetResponseData }
  [Method.SESSION_RUNTIME_SET]: {
    params: SessionRuntimeSetRequestData
    result: SessionRuntimeSetResponseData
  }
  [Method.CHAT_CREATE]: { params: ChatCreateRequestData; result: ChatCreateResponseData }
  [Method.CHAT_LIST]: { params: ChatListRequestData; result: ChatListResponseData }
  [Method.CHAT_TASK_LIST]: {
    params: ChatTaskListRequestData
    result: ChatTaskListResponseData
  }
  [Method.CHAT_TASK_RESULT_VIEW]: {
    params: ChatTaskResultViewRequestData
    result: ChatTaskResultViewResponseData
  }
  [Method.CHAT_ROUTE_SUGGEST]: {
    params: ChatRouteSuggestRequestData
    result: ChatRouteSuggestResponseData
  }
  [InternalCommand.CHAT_GET]: { params: ChatGetRequestData; result: ChatGetResponseData }
  [Method.CHAT_DELETE]: { params: ChatDeleteRequestData; result: ChatDeleteResponseData }
  [Method.CHAT_ARCHIVE]: {
    params: ChatDeleteRequestData
    result: { chatId: string; archivedChatIds: string[] }
  }
  [Method.CHAT_ARCHIVE_LIST]: {
    params: import('@chery/protocol').ArchiveListRequest
    result: import('@chery/protocol').ArchiveListResponse
  }
  [Method.CHAT_BRANCH_PREVIEW]: {
    params: ChatBranchPreviewRequestData
    result: ChatBranchPreviewResponseData
  }
  [Method.CHAT_BRANCH_CREATE]: {
    params: ChatBranchCreateRequestData
    result: ChatBranchCreateResponseData
  }
  [Method.CHAT_BRANCH_ACTIVATE]: {
    params: ChatBranchActivateRequestData
    result: ChatBranchActivateResponseData
  }
  [Method.CHAT_ABORT_TASK]: { params: ChatAbortTaskRequestData; result: ChatAbortTaskResponseData }
  [Method.CHAT_CONTEXT_USAGE]: {
    params: ChatContextUsageRequestData
    result: ChatContextUsageResponseData
  }
  [Method.CHAT_PROMPT_SNAPSHOT]: {
    params: ChatPromptSnapshotRequestData
    result: ChatPromptSnapshotResponseData
  }
  [Method.CHAT_USAGE_DETAIL]: {
    params: { taskKey: string }
    result: import('@chery/protocol').TaskUsageDetail
  }
  [Method.CHAT_USAGE_SUMMARIES]: {
    params: { taskKeys: string[] }
    result: { asOf: number; items: import('@chery/protocol').TaskUsageSummary[] }
  }
  [Method.CHAT_USAGE_ROUNDS]: {
    params: import('@chery/protocol').UsagePageRequest
    result: { asOf: number; items: import('@chery/protocol').RequestUsage[]; nextCursor?: string }
  }
  [Method.CHAT_USAGE_OPERATIONS]: {
    params: import('@chery/protocol').UsagePageRequest
    result: { asOf: number; items: import('@chery/protocol').UsageOperation[]; nextCursor?: string }
  }
  [Method.CHAT_USAGE_DAILY]: {
    params: import('@chery/protocol').UsageDailyRequest
    result: import('@chery/protocol').UsageDailyResponse
  }
  [Method.CHAT_USAGE_DAY_TASKS]: {
    params: { date: string; timezone: string; presetId?: string; cursor?: string; limit?: number }
    result: {
      asOf: number
      items: { taskKey: string; tokens: import('@chery/protocol').UsageMetric }[]
      nextCursor?: string
    }
  }
  [Method.CHAT_CONTEXT_CONTENT]: {
    params: ChatPromptSnapshotRequestData & { cursor?: string; limit?: number }
    result: import('@chery/protocol').ContextContentResponse
  }
  [Method.CHAT_EPOCH_LIST]: {
    params: ChatEpochListRequestData
    result: ChatEpochListResponseData
  }
  [InternalCommand.CHAT_SEND]: { params: ChatSendRequestData; result: ChatSendResponseData }
  [Method.CHAT_INPUT_SUBMIT]: {
    params: ChatInputSubmitRequestData
    result: ChatInputSubmitResponseData
  }
  [Method.CHAT_TIMELINE_GET]: {
    params: ChatTimelineGetRequestData
    result: ChatTimelineGetResponseData
  }
  [Method.CHAT_TIMELINE_GENERATION_GET]: {
    params: ChatTimelineGenerationGetRequestData
    result: ChatTimelineGenerationGetResponseData
  }
  [Method.CHAT_TIMELINE_NODE_GET]: {
    params: ChatTimelineNodeGetRequestData
    result: ChatTimelineNodeGetResponseData
  }
  [InternalCommand.CHAT_RESUME]: { params: ChatResumeRequestData; result: ChatResumeResponseData }
  [Method.CHAT_RUN_RESUME]: {
    params: import('@chery/protocol').ChatRunResumeRequest
    result: import('@chery/protocol').ChatRunResumeResponse
  }
  [Method.CHAT_RESUME_TREE]: {
    params: ChatResumeTreeRequestData
    result: ChatResumeTreeResponseData
  }
  [InternalCommand.CHAT_SYNC]: { params: ChatSyncRequestData; result: ChatSyncResponseData }
  [Method.CHAT_OPEN]: { params: ChatOpenRequestData; result: ChatOpenResponseData }
  [Method.CHAT_CLOSE]: { params: ChatCloseRequestData; result: ChatCloseResponseData }
  [Method.CHAT_OVERVIEW_OPEN]: {
    params: ChatOverviewOpenRequestData
    result: ChatOverviewOpenResponseData
  }
  [Method.CHAT_OVERVIEW_CLOSE]: {
    params: ChatOverviewCloseRequestData
    result: ChatOverviewCloseResponseData
  }
  [InternalCommand.CHAT_START_SPAWN]: {
    params: ChatStartSpawnRequestData
    result: ChatStartSpawnResponseData
  }
  [Method.CHAT_STOP_CHILD]: {
    params: ChatStopChildRequestData
    result: ChatStopChildResponseData
  }
  [InternalCommand.CHAT_SEND_TO_CHILD]: {
    params: ChatSendToChildRequestData
    result: ChatSendToChildResponseData
  }
  [InternalCommand.SENSE_APPROVAL]: {
    params: SenseApprovalRequestData
    result: SenseApprovalResponseData
  }
  [Method.INTERACTION_LIST]: {
    params: InteractionListRequestData
    result: InteractionListResponseData
  }
  [Method.INTERACTION_APPROVAL_DECIDE]: {
    params: InteractionApprovalDecideRequestData
    result: InteractionApprovalDecideResponseData
  }
  [Method.INTERACTION_QUESTION_ANSWER]: {
    params: InteractionQuestionAnswerRequestData
    result: InteractionQuestionAnswerResponseData
  }
  [InternalCommand.SENSE_QUESTION_ANSWER]: {
    params: SenseQuestionAnswerRequestData
    result: SenseQuestionAnswerResponseData
  }
  [InternalCommand.SENSE_QUESTION_BATCH_ANSWER]: {
    params: SenseQuestionBatchAnswerRequestData
    result: SenseQuestionBatchAnswerResponseData
  }
  [Method.CHAT_ABORT]: { params: ChatAbortRequestData; result: ChatAbortResponseData }
  [InternalCommand.CHAT_ATTACH]: { params: ChatAttachRequestData; result: ChatAttachResponseData }
  [Method.BASH_LIST]: { params: BashListRequestData; result: BashListResponseData }
  [Method.BASH_KILL]: { params: BashKillRequestData; result: BashKillResponseData }
  [Method.MCP_LIST]: { params: McpListRequestData; result: McpListResponseData }
  [Method.MCP_GET]: { params: McpGetRequestData; result: McpGetResponseData }
  [Method.MCP_CONNECT]: { params: McpConnectRequestData; result: McpConnectResponseData }
  [Method.MCP_DISCONNECT]: { params: McpDisconnectRequestData; result: McpDisconnectResponseData }
  [Method.MCP_RELOAD]: { params: McpReloadRequestData; result: McpReloadResponseData }
  [Method.CONFIG_GET]: { params: ConfigGetRequestData; result: ConfigGetResponseData }
  [Method.CONFIG_WORKSPACE_VALIDATE]: {
    params: ConfigWorkspaceValidateRequestData
    result: ConfigWorkspaceValidateResponseData
  }
  [Method.CONFIG_WORKSPACE_BROWSE_START]: {
    params: ConfigWorkspaceBrowseStartRequestData
    result: ConfigWorkspaceBrowseStartResponseData
  }
  [Method.CONFIG_WORKSPACE_BROWSE_LIST]: {
    params: ConfigWorkspaceBrowseListRequestData
    result: ConfigWorkspaceBrowseListResponseData
  }
  [Method.WORKSPACE_FILES_LIST]: {
    params: WorkspaceFilesListRequestData
    result: WorkspaceFilesListResponseData
  }
  [Method.WORKSPACE_FILES_READ]: {
    params: WorkspaceFilesReadRequestData
    result: WorkspaceFilesReadResponseData
  }
  [Method.WORKSPACE_GIT_STATUS]: {
    params: WorkspaceGitStatusRequestData
    result: WorkspaceGitStatusResponseData
  }
  [Method.WORKSPACE_GIT_CHECKOUT]: {
    params: WorkspaceGitCheckoutRequestData
    result: WorkspaceGitCheckoutResponseData
  }
  [Method.TERMINAL_CREATE]: {
    params: TerminalCreateRequestData
    result: TerminalCreateResponseData
  }
  [Method.TERMINAL_INPUT]: {
    params: TerminalInputRequestData
    result: TerminalInputResponseData
  }
  [Method.TERMINAL_RESIZE]: {
    params: TerminalResizeRequestData
    result: TerminalResizeResponseData
  }
  [Method.TERMINAL_CLOSE]: {
    params: TerminalCloseRequestData
    result: TerminalCloseResponseData
  }
  [Method.CONFIG_SAVE]: { params: ConfigSaveRequestData; result: ConfigSaveResponseData }
  [Method.CONFIG_PREVIEW]: {
    params: import('@chery/protocol').ConfigApplyRequest<ConfigRaw>
    result: import('@chery/protocol').ConfigPreview
  }
  [Method.CONFIG_APPLY_STATUS]: {
    params: Record<string, never>
    result: import('@chery/protocol').ConfigApplyState
  }
  [Method.HOOKS_GET]: { params: HooksGetRequestData; result: HooksGetResponseData }
  [Method.HOOKS_SAVE]: { params: HooksSaveRequestData; result: HooksSaveResponseData }
  [Method.HOOKS_EVENTS]: { params: HooksEventsRequestData; result: HooksEventsResponseData }
  [Method.UTILS_MODELS]: { params: UtilsModelsRequestData; result: UtilsModelsResponseData }
  [Method.UTILS_TEST_CONNECTION]: {
    params: UtilsTestConnectionRequestData
    result: UtilsTestConnectionResponseData
  }
  [Method.ENV_LIST]: { params: EnvListRequestData; result: EnvListResponseData }
  [Method.UTILS_OPEN_FILE]: { params: UtilsOpenFileRequestData; result: UtilsOpenFileResponseData }
  [Method.UTILS_OPEN_CONFIG_DIR]: {
    params: UtilsOpenConfigDirRequestData
    result: UtilsOpenConfigDirResponseData
  }
  [Method.UTILS_EDITORS]: { params: UtilsEditorsRequestData; result: UtilsEditorsResponseData }
  [Method.UTILS_MODEL_RECOMMENDATION]: {
    params: UtilsModelRecommendationRequestData
    result: UtilsModelRecommendationResponseData
  }
  [Method.COMMAND_LIST]: { params: EmptyObjectData; result: CommandListResponseData }
  [Method.PLUGINS_LIST]: { params: PluginsListRequestData; result: PluginsListResponseData }
  [Method.PLUGINS_PRE_IMPORT_URL]: {
    params: PluginsPreImportUrlRequestData
    result: PluginsPreImportUrlResponseData
  }
  [Method.PLUGINS_IMPORT_URL]: {
    params: PluginsImportUrlRequestData
    result: PluginsImportUrlResponseData
  }
  [Method.PLUGINS_COMMIT]: { params: PluginsCommitRequestData; result: PluginsCommitResponseData }
  [Method.PLUGINS_CHECK_UPDATE]: {
    params: PluginsCheckUpdateRequestData
    result: PluginsCheckUpdateResponseData
  }
  [Method.PLUGINS_CHECK_ALL_UPDATES]: {
    params: PluginsCheckAllUpdatesRequestData
    result: PluginsCheckAllUpdatesResponseData
  }
  [Method.PLUGINS_UPDATE]: { params: PluginsUpdateRequestData; result: PluginsUpdateResponseData }
  [Method.PLUGINS_UNINSTALL]: {
    params: PluginsUninstallRequestData
    result: PluginsUninstallResponseData
  }
  [Method.CREDENTIALS_LIST]: {
    params: CredentialsListRequestData
    result: CredentialsListResponseData
  }
  [Method.CREDENTIALS_SAVE]: {
    params: CredentialsSaveRequestData
    result: CredentialsSaveResponseData
  }
  [Method.CREDENTIALS_DELETE]: {
    params: CredentialsDeleteRequestData
    result: CredentialsDeleteResponseData
  }
}

export type ParamsOf<M extends Method> = RpcMethodMap[M]['params']
export type ResultOf<M extends Method> = RpcMethodMap[M]['result']
export type RequestData = ParamsOf<Method>
export type ResponseData = ResultOf<Method>
