import { call, callList, uploadFile, fail } from './agentApiTransport'
import { wsClient } from './ws'
import type { ContextBreakdown } from '@/domain/chat/context'
import type { PromptSnapshotTool, ChatSummary, ChatEpochSummary, ConversationRouteSuggestion, CreateAgentOptions, CreateAgentResult, TimelineSnapshot, TreeResumeResponse, ChatAbortResponse, TimelineNodeDetailResponse, ConversationBranchSummary, RootTimelineSnapshot, TimelineGenerationSnapshot, ChatOpenResponse, InputAccepted } from './agentApiTypes'
import type { ChatInputSubmitRequest, ChatInputWithdrawRequest, ChatInputWithdrawResponse, ChatOpenRequest, ChatRunResumeRequest, ChatRunResumeResponse } from '@chery/protocol'
import type { RuntimeSelection, SessionRuntimeSelection } from '@/domain/chat/runtime'
import type { CommandConfigDataDto } from '@/domain/chat/commands'

export const chatApi = {
  async listChats(options: {
    scope: 'stage' | 'preset' | 'history'
    presetId?: string
    preset?: string
    includePreview?: boolean
  }): Promise<ChatSummary[]> {
    return callList<ChatSummary>('chat.list', 'chats', options)
  },

  /** chat.list 分页版（标题栏会话下拉）：scope='preset' + limit/offset，返回 total（同 WHERE 匹配总数）。
   * 后端 preset scope 同时排除非 original 分支 root（与 isPianoRootSession 对齐）。 */
  async listChatsPaged(options: {
    scope: 'preset'
    presetId?: string
    preset?: string
    includePreview?: boolean
    limit: number
    offset?: number
  }): Promise<{ chats: ChatSummary[]; total: number }> {
    const data = await call<Record<string, unknown>>('chat.list', options)
    return {
      chats: Array.isArray(data?.chats) ? (data.chats as ChatSummary[]) : [],
      total: (data?.total as number | undefined) ?? 0,
    }
  },
  async suggestConversationRoute(params: {
    presetId: string
    draft: string
    requestVersion: number
  }): Promise<ConversationRouteSuggestion> {
    return call<ConversationRouteSuggestion>('chat.route.suggest', params, { timeoutMs: 30_000 })
  },

  /**
   * 流式会话路由：实时回传路由 Shadow 的 thinking/content 增量（onDelta），resolve 时返回最终结果。
   * 后端以 `route` chunk 流式推送增量，最终以 response 返回完整 suggestion。
   */
  async suggestConversationRouteStream(
    params: { presetId: string; draft: string; requestVersion: number },
    onDelta: (delta: { thinking: string; content: string }) => void,
  ): Promise<ConversationRouteSuggestion> {
    const { requestId, response } = wsClient.rpcTrack('chat.route.suggest', params)
    const unsubscribe = wsClient.onChunk((chunk) => {
      const c = chunk as {
        kind?: string
        type?: string
        requestId?: string
        data?: { delta?: { thinking?: string; content?: string } }
      }
      if (c.kind !== 'chunk' || c.type !== 'route' || c.requestId !== requestId) return
      const delta = c.data?.delta
      if (delta) onDelta({ thinking: delta.thinking ?? '', content: delta.content ?? '' })
    })
    try {
      const res = await response
      if (!res.success) throw fail('chat.route.suggest', res)
      return res.data as ConversationRouteSuggestion
    } finally {
      unsubscribe()
    }
  },

  /** chat.create：创建 chat。返回 chatId + 实际生效编制（预设路径由后端回填，供记 pet.runtime）。
   * 仅发送显式提供的字段：preset 路径按后端契约「preset 与显式 runtime 字段互斥」不得携带
   * brain/senseGroup/mcpServers（严格 zod 校验，携带即 INVALID_PARAMS「方言不通」）。
   * 空白复用（后端默认启用）：preset 路径命中同预设空会话时直接返回其 chatId 且 `reused: true`
   * （未新建）；前端无须区分，拿 chatId 直接跳转即可。 */
  async createAgent(opts: CreateAgentOptions): Promise<CreateAgentResult> {
    const data = await call<{
      chatId?: string
      presetId?: string
      brain?: string
      senseGroup?: string
      mcpServers?: string[]
      workspace?: string
      workspaceValid?: boolean
      reused?: boolean
    }>('chat.create', {
      ...(opts.preset ? { preset: opts.preset } : {}),
      ...(opts.brain !== undefined ? { brain: opts.brain } : {}),
      ...(opts.senseGroup !== undefined ? { senseGroup: opts.senseGroup } : {}),
      ...(opts.mcpServers !== undefined ? { mcpServers: opts.mcpServers } : {}),
      ...(opts.chatId !== undefined ? { chatId: opts.chatId } : {}),
      ...(opts.parentChatId !== undefined ? { parentChatId: opts.parentChatId } : {}),
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
      reused: data.reused,
    }
  },

  /** V2 command plane：立即确认输入，不承载 Agent 流生命周期。 */
  async submitChatInput(params: ChatInputSubmitRequest): Promise<InputAccepted> {
    return call<InputAccepted>('chat.input.submit', {
      chatId: params.chatId,
      commandId: params.commandId,
      clientMessageId: params.clientMessageId,
      messageId: params.messageId,
      content: params.content,
      ...(params.attachments?.length ? { attachments: params.attachments } : {}),
    })
  },

  /** V2 command plane：撤回排队消息（服务端校验仅 queued）。 */
  async withdrawChatInput(params: ChatInputWithdrawRequest): Promise<ChatInputWithdrawResponse> {
    return call<ChatInputWithdrawResponse>('chat.input.withdraw', {
      chatId: params.chatId,
      commandId: params.commandId,
      ...(params.inputId ? { inputId: params.inputId } : {}),
      ...(params.clientMessageId ? { clientMessageId: params.clientMessageId } : {}),
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

  /** Root timeline projection: backend joins all recursive descendants.
   *  返回 undefined = knownRevision 短路（unchanged），调用方保留现有缓存快照。 */
  async getRootTimeline(params: {
    rootChatId: string
    view?: 'conversation' | 'tree' | 'audit'
    knownRevision?: number
  }): Promise<RootTimelineSnapshot | undefined> {
    const response = await call<TimelineSnapshot>('chat.timeline.get', {
      rootChatId: params.rootChatId,
      view: params.view ?? 'conversation',
      ...(params.knownRevision !== undefined ? { knownRevision: params.knownRevision } : {}),
    })
    if (response.unchanged) return undefined
    if (!response.rootTimeline) throw new Error('root timeline 响应缺少 rootTimeline')
    return response.rootTimeline
  },

  /** Root node details use the canonical application WebSocket. Lite controls
   * only when this read is requested; it does not create a profile connection. */
  async getTimelineNode(params: {
    rootChatId: string
    nodeId: string
    sections?: Array<'content' | 'thinking' | 'toolCalls'>
    offset?: number
    limit?: number
    toolCursor?: { callIndex: number; field: 'arguments' | 'result'; offset: number }
  }): Promise<TimelineNodeDetailResponse> {
    return call<TimelineNodeDetailResponse>('chat.timeline.node.get', {
      rootChatId: params.rootChatId,
      nodeId: params.nodeId,
      ...(params.sections ? { sections: params.sections } : {}),
      ...(params.offset !== undefined ? { offset: params.offset } : {}),
      ...(params.limit !== undefined ? { limit: params.limit } : {}),
      ...(params.toolCursor ? { toolCursor: params.toolCursor } : {}),
    })
  },

  /** 按需拉取单个已打包代际的完整图（LRU 缓存由 chats store 持有）。 */
  async getTimelineGeneration(params: {
    rootChatId: string
    generationIndex: number
  }): Promise<TimelineGenerationSnapshot> {
    return call<TimelineGenerationSnapshot>('chat.timeline.generation.get', params)
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

  async previewBranch(
    rootChatId: string,
    anchorNodeId: string,
  ): Promise<{
    taskId: string
    sourceBranchId: string
    eligible: boolean
    reason?: string
    sideEffects: Array<{
      nodeId: string
      callId: string
      toolName: string
      arguments: string
      result?: string
    }>
    effectDigest: string
  }> {
    return call<{
      taskId: string
      sourceBranchId: string
      eligible: boolean
      reason?: string
      sideEffects: Array<{
        nodeId: string
        callId: string
        toolName: string
        arguments: string
        result?: string
      }>
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

  async activateBranch(
    branchId: string,
    commandId: string,
  ): Promise<{
    taskId: string
    activeBranchId: string
    activeChatId: string
    deliveryGeneration: number
  }> {
    return call('chat.branch.activate', { branchId, commandId })
  },

  async abortTask(
    taskId: string,
    commandId: string,
  ): Promise<{ taskId: string; abortedBranches: string[] }> {
    return call<{ taskId: string; abortedBranches: string[] }>('chat.abortTask', {
      taskId,
      commandId,
    })
  },

  /** V2 session plane：原子建立订阅并返回当前运行态快照。 */
  async openChat(params: ChatOpenRequest): Promise<ChatOpenResponse> {
    return call<ChatOpenResponse>('chat.open', params)
  },

  /** V2 session plane：显式关闭订阅。 */
  async closeChat(subscriptionId: string): Promise<void> {
    await call('chat.close', { subscriptionId })
  },

  async resumeRun(params: ChatRunResumeRequest): Promise<ChatRunResumeResponse> {
    return call('chat.run.resume', params)
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

  async archiveChat(chatId: string): Promise<{ chatId: string; archivedChatIds: string[] }> {
    return call('chat.archive', { chatId })
  },

  async listArchives(
    params: import('@chery/protocol').ArchiveListRequest = {},
  ): Promise<import('@chery/protocol').ArchiveListResponse> {
    return call('chat.archive.list', params)
  },

  /** Permanent deletion is restricted to archived family roots. */
  async destroyAgent(chatId: string): Promise<{ chatId: string; deletedChatIds: string[] }> {
    return call<{ chatId: string; deletedChatIds: string[] }>('chat.delete', { chatId })
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
  async promptSnapshot(
    chatId: string,
    epochId?: string,
  ): Promise<{
    chatId: string
    epochId?: string
    epochOrdinal?: number
    epochStatus?: 'active' | 'historical' | 'archived'
    snapshotQuality?: 'exact' | 'partial' | 'reconstructed'
    systemPrompt: string
    tools: PromptSnapshotTool[]
  }> {
    return call<{
      chatId: string
      epochId?: string
      epochOrdinal?: number
      epochStatus?: 'active' | 'historical' | 'archived'
      snapshotQuality?: 'exact' | 'partial' | 'reconstructed'
      systemPrompt: string
      tools: PromptSnapshotTool[]
    }>('chat.promptSnapshot', { chatId, ...(epochId ? { epochId } : {}) })
  },

  async listEpochs(chatId: string): Promise<{
    chatId: string
    rootChatId: string
    activeEpochId?: string
    epochs: ChatEpochSummary[]
  }> {
    return call<{
      chatId: string
      rootChatId: string
      activeEpochId?: string
      epochs: ChatEpochSummary[]
    }>('chat.epoch.list', { chatId })
  },

  /**
   * brain.list：列出可用 brain + 当前已连 MCP server（AgentDialog 用）。
   * 后端 Agent 1 契约保证 brains[].contextLimit。返回形状容错（缺字段 → 空数组）。
   */
}
