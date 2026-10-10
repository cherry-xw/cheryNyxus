import { call, callList, uploadFile, clearServerConfigCache } from './agentApiTransport'
import { skillsApi } from './skillsApi'
import { pluginsApi } from './pluginsApi'
import { chatApi } from './chatApi'
import type { WorkspaceFilesList, WorkspaceFileContent, WorkspaceGitStatus, TerminalSessionInfo, InteractionRecord, TaskCatalogItem, TaskCatalogQuery, TaskOverviewSubscription, ModelRecommendationDto, BrainListResponse, SenseToolInfo, SenseToolDocInfo, CommandInfo, UploadedMediaAsset, EditorInfo, ConfigDto, ConfigWorkspaceBrowseStart, HookHandlerDTO, HooksGetResult, HookEventMeta } from './agentApiTypes'
import type { LlmProtocol } from '@chery/protocol'

export type * from './agentApiTypes'
export { fail, fetchServerConfig } from './agentApiTransport'

export const agentApi = {
  async getContextUsageDetail(taskKey: string): Promise<import('@chery/protocol').TaskUsageDetail> {
    return call('chat.taskUsage.detail', { taskKey })
  },

  async getContextUsageSummaries(taskKeys: string[]): Promise<{ asOf: number; items: import('@chery/protocol').TaskUsageSummary[] }> {
    return call('chat.taskUsage.summaries', { taskKeys })
  },

  async getContextUsageDaily(params: { from: string; to: string; timezone: string; presetId?: string }): Promise<import('@chery/protocol').UsageDailyResponse> {
    return call('chat.taskUsage.daily', params)
  },

  async getContextUsageDayTasks(params: { date: string; timezone: string; presetId?: string; cursor?: string; limit?: number }): Promise<{ asOf: number; items: { taskKey: string; tokens: import('@chery/protocol').UsageMetric }[]; nextCursor?: string }> {
    return call('chat.taskUsage.dayTasks', params)
  },

  async getContextContent(params: { chatId: string; epochId?: string; cursor?: string; limit?: number }): Promise<import('@chery/protocol').ContextContentResponse> {
    return call('chat.contextContent', params)
  },

  async listTasks(options: TaskCatalogQuery): Promise<{
    items: TaskCatalogItem[]
    total: number
    snapshotAt: number
    nextCursor?: string
  }> {
    return call('chat.task.list', options)
  },

  async markTaskResultViewed(
    taskKey: string,
    resultId: string,
  ): Promise<{
    taskKey: string
    resultId: string
    viewed: boolean
    viewedAt?: number
    latestResultId?: string
  }> {
    return call('chat.task.result.view', { taskKey, resultId })
  },

  async openTaskOverview(completedSince: number): Promise<TaskOverviewSubscription> {
    return call<TaskOverviewSubscription>('chat.overview.open', { completedSince })
  },

  async closeTaskOverview(
    subscriptionId: string,
  ): Promise<{ subscriptionId: string; closed: boolean }> {
    return call('chat.overview.close', { subscriptionId })
  },

  async listInteractionPage(params?: {
    presetId?: string
    includeActivity?: boolean
  }): Promise<{ interactions: InteractionRecord[]; serverNow?: number; hasMore?: boolean }> {
    return call<{ interactions: InteractionRecord[]; serverNow?: number; hasMore?: boolean }>(
      'interaction.list',
      params ?? {},
    )
  },
  async listInteractions(params?: {
    presetId?: string
    includeActivity?: boolean
  }): Promise<InteractionRecord[]> {
    const response = await call<{ interactions: InteractionRecord[] }>(
      'interaction.list',
      params ?? {},
    )
    return response.interactions
  },

  async decideInteractionApproval(params: {
    interactionId: string
    action: 'accept' | 'reject'
    expectedRevision: number
    commandId: string
    reason?: string
  }): Promise<InteractionRecord> {
    const response = await call<{ interaction: InteractionRecord }>(
      'interaction.approval.decide',
      params,
    )
    return response.interaction
  },

  async answerInteractionQuestion(params: {
    interactionId: string
    expectedRevision: number
    commandId: string
    answers: Array<{
      questionId: string
      selectedLabels: string[]
      /** 每选项补充描述：label → note（可选，向后兼容；仅已选选项生效）。 */
      optionNotes?: Record<string, string>
      freeText?: string
      cancelled?: boolean
    }>
  }): Promise<InteractionRecord> {
    const response = await call<{ interaction: InteractionRecord }>(
      'interaction.question.answer',
      params,
    )
    return response.interaction
  },
  /** skills.list：实时列出用户可加载的技能（独立 + 插件）；内置命令不在此结果中。支持可选分页与搜索。 */
  async listBrains(): Promise<BrainListResponse> {
    const data = await call<Partial<BrainListResponse>>('brain.list', {})
    return {
      brains: Array.isArray(data?.brains) ? data.brains : [],
      mcpServers: Array.isArray(data?.mcpServers) ? data.mcpServers : [],
    }
  },
  /** config.get：读 .chery/config.yaml 原文（除 server 段），供设置面板编辑。supervision 为字符串、key 仍为 $ENV 占位符。 */
  async getConfig(): Promise<ConfigDto & { baseRevision: string }> {
    return call<ConfigDto & { baseRevision: string }>('config.get', {})
  },

  /** config.workspace.validate：只读检查后端主机上的工作区目录，不保存配置。 */
  async validateWorkspace(workspace?: string): Promise<{ valid: boolean; error?: string }> {
    return call<{ valid: boolean; error?: string }>(
      'config.workspace.validate',
      workspace ? { workspace } : {},
    )
  },

  /** config.workspace.browse.start：开启服务端文件夹浏览会话（设置页工作区「浏览」弹层）。 */
  async browseWorkspaceStart(): Promise<ConfigWorkspaceBrowseStart> {
    return call<ConfigWorkspaceBrowseStart>('config.workspace.browse.start', {})
  },

  /**
   * config.workspace.browse.list：懒加载列某目录子项（逐层钻取）。
   * 载荷加密：encPath = xorEncrypt(nonce, path)，响应 encData 用同一 nonce 解密。
   */
  async browseWorkspaceList(params: {
    sessionId: string
    nonce: string
    encPath: string
    includeFiles?: boolean
  }): Promise<{ nonce: string; encData: string }> {
    return call<{ nonce: string; encData: string }>('config.workspace.browse.list', params)
  },

  async listWorkspaceFiles(chatId: string, path?: string, offset?: number): Promise<WorkspaceFilesList> {
    return call<WorkspaceFilesList>('workspace.files.list', { chatId, ...(path ? { path } : {}), ...(offset ? { offset } : {}) })
  },
  async readWorkspaceFile(chatId: string, path: string): Promise<WorkspaceFileContent> {
    return call<WorkspaceFileContent>('workspace.files.read', { chatId, path })
  },
  async getWorkspaceGitStatus(chatId: string): Promise<WorkspaceGitStatus> { return call<WorkspaceGitStatus>('workspace.git.status', { chatId }) },
  async checkoutWorkspaceGit(chatId: string, branch: string): Promise<{ chatId: string; branch: string }> { return call<{ chatId: string; branch: string }>('workspace.git.checkout', { chatId, branch }) },
  async createTerminal(
    chatId: string,
    target?: Record<string, unknown>,
    cols?: number,
    rows?: number,
  ): Promise<TerminalSessionInfo> {
    return call<TerminalSessionInfo>('terminal.create', { chatId, ...(target ? { target } : {}), ...(cols ? { cols } : {}), ...(rows ? { rows } : {}) }, { timeoutMs: 25000 })
  },
  async terminalInput(sessionId: string, data: string): Promise<void> {
    await call('terminal.input', { sessionId, data })
  },
  async terminalResize(sessionId: string, cols: number, rows: number): Promise<void> {
    await call('terminal.resize', { sessionId, cols, rows })
  },
  async closeTerminal(sessionId: string): Promise<void> {
    await call('terminal.close', { sessionId })
  },

  /**
   * config.save：校验（brain 引用/supervision 合法/`:level` 合法/必填）+ 写回（保留 server 段、无注释）。
   * v2 返回已保存/已生效修订与等待或失败项；校验失败 throw，设置面板展示。
   */
  async saveConfig(
    payload: import('@chery/protocol').ConfigSaveRequest<ConfigDto>,
  ): Promise<import('@chery/protocol').ConfigSaveResult> {
    const result = await call<import('@chery/protocol').ConfigSaveResult>('config.save', payload)
    clearServerConfigCache()
    return result
  },
  async previewConfig(
    payload: import('@chery/protocol').ConfigApplyRequest<ConfigDto>,
  ): Promise<import('@chery/protocol').ConfigPreview> {
    return call<import('@chery/protocol').ConfigPreview>('config.preview', payload)
  },
  async getConfigApplyState(): Promise<import('@chery/protocol').ConfigApplyState> {
    return call<import('@chery/protocol').ConfigApplyState>('config.apply.status', {})
  },
  async killBackgroundProcess(chatId: string, pid: number): Promise<{ killed: boolean }> {
    return call<{ killed: boolean }>('bash.kill', { chatId, pid })
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
    return callList<HookEventMeta>('hooks.events', 'events')
  },

  /**
   * sense.tools：列出代码维护的全部内置工具（name/label/description/icon），供设置面板感官分组下拉建议 + pet bar 运行中工具 icon 查询。
   * 仅内置；自定义/外部/MCP 工具不在内，靠组合框自由输入。返回形状容错（缺字段 -> 空数组）。
   */
  async listSenseTools(): Promise<SenseToolInfo[]> {
    return callList<SenseToolInfo>('sense.tools', 'tools')
  },

  /**
   * sense.tools.docs：统一获取内置工具完整说明文档。
   * 不传 tools = 全量返回（前端缓存后按需展示）；传 tools = 后端按 name 列表一次性返回对应说明，
   * 减少请求数量与流量。返回形状容错（缺字段 -> 空数组）。
   */
  async listSenseToolDocs(tools?: string[]): Promise<SenseToolDocInfo[]> {
    const params = tools?.length ? { tools } : {}
    return callList<SenseToolDocInfo>('sense.tools.docs', 'docs', params)
  },

  /**
   * sense.list：列出 config.sense_groups 全部组及其 sense 名（group→senses 解析）。
   * 供前端「能力判定」——pet 的 senseGroups（组名）经此解析为 sense 名集合，判断是否含某工具（如 update_todo）。
   * 返回形状容错（缺字段 -> 空数组）。
   */
  async listSenseGroups(): Promise<{ name: string; senses: string[] }[]> {
    return callList<{ name: string; senses: string[] }>('sense.list', 'senseGroups')
  },

  /**
   * prompts.list：递归列出 .chery/prompt/ 下全部 .md（含子文件夹），每项为相对 .chery/ 的路径
   * （如 prompt/prefebMain/leader.md）。供设置面板 systemPrompt 级联选择器（el-cascader）建目录树。
   * 返回形状容错（缺字段 -> 空数组）。
   */
  async listPrompts(): Promise<string[]> {
    return callList<string>('prompts.list', 'prompts')
  },
  /**
   * rules.list：列出 .chery/rule/ 下全部 .yaml 文件名（排除基准 base.yaml），供设置面板预设 tab
   * 「规则文件」下拉填充。返回形状容错（缺字段 -> 空数组）。
   */
  async listRules(): Promise<string[]> {
    return callList<string>('rules.list', 'rules')
  },
  async uploadMedia(file: File): Promise<UploadedMediaAsset> {
    return uploadFile<UploadedMediaAsset>('/api/media/upload', file, {
      errorMessage: '媒体上传失败',
    })
  },

  /** utils.models：基于 provider/url/key 拉取可用模型列表。 */
  async fetchModels(
    provider: string,
    url: string,
    key?: string,
    fullUrl?: boolean,
    protocol?: LlmProtocol,
  ): Promise<{ models: Array<{ id: string; name?: string }>; error?: string }> {
    return await call<{ models: Array<{ id: string; name?: string }>; error?: string }>(
      'utils.models',
      { provider, protocol, url, key, fullUrl },
    )
  },

  /** utils.testConnection：用未保存的连接字段执行真实最小 Provider 请求。 */
  async testConnection(
    provider: string,
    url: string,
    key: string | undefined,
    model: string,
    fullUrl?: boolean,
    protocol?: LlmProtocol,
  ): Promise<{ ok: true; error?: never } | { ok: false; error: string }> {
    return await call<{ ok: true; error?: never } | { ok: false; error: string }>(
      'utils.testConnection',
      { provider, protocol, url, key, model, fullUrl },
    )
  },

  /**
   * env.list：读取 .env 文件中的变量名列表（供密钥下拉选择）。
   * 前端不做二次过滤、原样透出——变量名合法性由后端 listEnvVarNames 的
   * /^[A-Za-z_][A-Za-z0-9_]*$/ 命名校验单一兜底（旧的后缀白名单会吞掉 API_KEY1 这类命名，已取消）。
   */
  async listEnvVars(): Promise<string[]> {
    const data = await call<{ vars: string[] }>('env.list', {})
    return data?.vars ?? []
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
   * utils.modelRecommendation：模型识别、事实、推荐与当前协议 thinking 档位。
   */
  async getModelRecommendation(
    model: string,
    provider?: string,
    protocol?: LlmProtocol,
  ): Promise<ModelRecommendationDto> {
    return await call<ModelRecommendationDto>('utils.modelRecommendation', {
      model,
      provider,
      protocol,
    })
  },

  // ========== 内置命令管理（settings 「指令」tab） ==========

  /** command.list：列出全部 .chery/command/*.md 文件（只读枚举）。返回 [] 时前端展示空态。 */
  async listCommands(): Promise<CommandInfo[]> {
    return callList<CommandInfo>('command.list', 'commands')
  },
  ...skillsApi,
  ...pluginsApi,
  ...chatApi,
}
