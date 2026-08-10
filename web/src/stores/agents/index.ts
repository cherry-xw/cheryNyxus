import { defineStore } from 'pinia'
import { ref } from 'vue'
import {
  agentApi,
  type ChatSummary,
  type ChatSendAttachment,
  type CommandConfigDataDto,
  type ConfigDto,
  type ContextBreakdown,
  type CurrentStateData,
  type RuntimeSelection,
  type SenseToolInfo,
  type SessionRuntimeSelection,
} from '@/services/agentApi'
import type { PetInstance, PetMood } from '@/features/pets/types/types'
import type { ChatSession } from '../chats/types'
import type { StreamState, HistoryItem } from './types'
import { sameRuntime, defaultBounds, pushHistoryItem } from './data/streamAccumulator'
import { replaceQuestionBatches, type QuestionBatchPayload } from './actions/questionBatch'
import { collectDescendantChatIds } from './data/historyMerge'
import { hasActiveChatRun } from './data/historyLoadState'
import { wsClient } from '@/services/ws'

// 模块 factories
import { createUiState } from './ui/uiState'
import { createApprovalActions } from './actions/approvalActions'
import { createQuestionActions } from './actions/questionActions'
import {
  CHERY_NYXUS_PRESET,
  createPetLifecycle,
  selectRefreshRecoveryChats,
  turnChildIntoGhost,
} from './data/petLifecycle'
import {
  createStreamRouter,
  ensureStream as _ensureStream,
  trackRequest as _trackRequest,
} from './ui/streamRouter'

// re-export 公共契约类型（保 @/stores/agents 导入路径兼容：4 .vue + stores/index.ts 零改动）
export type {
  SenseCallRecord,
  HistoryItem,
  ApprovalState,
  QuestionBatchState,
  QuestionItemState,
  QuestionDraftAnswer,
  StreamState,
  RunningTool,
} from './types'

/**
 * agents store：agent/chat 状态层单一数据源。
 *
 * - pets: PetInstance[] —— chat.list + chunk/notification 驱动（CP1 由 initFromChats 重建）
 * - streams: Record<chatId, StreamState> —— chunk 按 requestId→chatId 路由累积
 * - activeDialogChatId / historyDrawerStack —— UI 焦点（CP2+ 弹窗/抽屉用；抽屉栈支持 spawn 多级下钻，逐层返回）
 *
 * routeChunk/routeNotification 由 App.vue 订阅 wsClient 回调注入。
 */
export const useAgentsStore = defineStore('agents', () => {
  // ── 核心数据状态 ──
  const pets = ref<PetInstance[]>([])
  const streams = ref<Record<string, StreamState>>({})
  // 完整 chat 列表缓存（initFromChats 时拉取，getHistory 用它找子 chat，避免仅依赖 pets 的 top-5 限制）
  const allChatsCache = ref<ChatSummary[]>([])
  // CP8 会话列表：historyList 缓存 chat.list(includePreview) 全量会话
  const historyList = ref<ChatSummary[]>([])
  // 内置工具元信息（sense.tools，name→icon/label）+ sense 组解析（sense.list，group→senses）。
  // initFromChats 载入；供 RunningTools icon 查询 + 能力判定（pet senseGroups 含某工具，如 update_todo）。
  const senseTools = ref<SenseToolInfo[]>([])
  const senseGroupsResolved = ref<{ name: string; senses: string[] }[]>([])
  // 全局配置快照（initFromChats 时拉取；节点树全量渲染阈值等重启生效字段用）
  const globalConfig = ref<ConfigDto | null>(null)

  // requestId → chatId 映射（流式 RPC 调用前由 trackRequest 注册，chunk/notification 路由用）
  const requestMap = new Map<string, string>()
  let initialized = false
  /** 同一 chat 的恢复任务唯一，确保 attach 快照与 sync cursor 串行。 */
  const attachRecoveryTasks = new Map<string, Promise<void>>()
  const ATTACH_RECOVERY_DELAY_MS = 1000

  // ── UI 状态（独立模块） ──
  const ui = createUiState()

  // ── 基础函数 ──

  /** 读 chat 当前 runtime（首次 = createMasterPet 时的 default）。AgentDialog 初始化复选框用。
   * runtime 挂 pet（pet.runtime）；hide 移除 pet / 刷新 initFromChats 不恢复 → undefined，AgentDialog 退 default 预选。 */
  function getRuntime(chatId: string): RuntimeSelection | undefined {
    return petForChat(chatId)?.runtime
  }

  function presetKey(presetId?: string, presetName?: string): string | undefined {
    return presetId ? `id:${presetId}` : presetName ? `name:${presetName}` : undefined
  }

  function summaryForChat(chatId: string): ChatSummary | undefined {
    return historyList.value.find((chat) => chat.chatId === chatId) ??
      allChatsCache.value.find((chat) => chat.chatId === chatId)
  }

  /** Resolve the stable workspace Pet for any root in that preset. Child pets still win exact lookup. */
  function petForChat(chatId: string): PetInstance | undefined {
    const exact = pets.value.find((pet) => pet.chatId === chatId)
    if (exact && !exact.isMaster) return exact
    const summary = summaryForChat(chatId)
    const key = presetKey(summary?.presetId, summary?.preset)
    if (key) {
      const workspacePet = pets.value.find(
        (pet) => pet.isMaster && presetKey(pet.presetId, pet.preset) === key,
      )
      if (workspacePet) return workspacePet
    }
    return exact
  }

  function activeRootForPet(pet: PetInstance): string {
    if (!pet.isMaster) return pet.chatId
    const key = presetKey(pet.presetId, pet.preset)
    return (key ? ui.activeRootByPreset.value[key] : undefined) ?? pet.chatId
  }

  /**
   * 切 pet 工作态视觉：action=chatting（复用现有 chatting motion，不新增 action——plan §10 决策）。
   * interactionUntil=0 → usePetWorld tickPet chatting 分支不回收（agent 工作态无超时，由 done/error 解除）。
   *
   * Req 7: freezeUntil 可选参数。done 后保留期（retainUntil）内 pet 保持 chatting 不移动。
   * - working=true: action=chatting, interactionUntil=0, bubbleRepelExtra=80
   * - working=false + freezeUntil: isWorking=false, interactionUntil=freezeUntil, action 保持 chatting（tickPet 到期切 walk）
   * - working=false 无 freezeUntil: action=walk, bubbleRepelExtra=0（立即恢复移动）
   */
  function setWorking(pet: PetInstance | undefined, working: boolean, freezeUntil?: number): void {
    if (!pet) return
    // ghost 是子任务终态；迟到的 V2 working effect 不能把已收尾的 pet 再次标为运行中。
    if (working && pet.isGhost) return
    pet.isWorking = working
    if (working) {
      pet.action = 'chatting'
      pet.mood = 'curious'
      pet.interactionUntil = 0
      pet.moodUntil = 0
      pet.bubbleRepelExtra = 80
    } else if (freezeUntil && freezeUntil > Date.now()) {
      // 保留期冻结：action 保持 chatting，tickPet 在 interactionUntil 到期时切 walk
      pet.interactionUntil = freezeUntil
      // bubbleRepelExtra 保持，tickPet 到期清零
    } else {
      // 解除：回到 walk，mood 让 tickPet 在 moodUntil 处恢复（清零立即走 restMood）
      pet.action = 'walk'
      pet.moodUntil = 0
      pet.bubbleRepelExtra = 0
    }
  }

  /** 按 chatId 设置工作态（chatSessions.onWorkingChange effect 注入用）。 */
  function setWorkingForChat(chatId: string, working: boolean, freezeUntil?: number): void {
    const pet = petForChat(chatId)
    if (pet?.isMaster && activeRootForPet(pet) !== chatId) return
    setWorking(pet, working, freezeUntil)
  }

  /**
   * 移除 pets + active 焦点（仅前端视觉，**保留 streams** 提问/审批/error 态）。
   * 统一暂停语义：hide 用——pet 隐藏 ≠ 删会话，提问批次等暂停态需保留供重显恢复（重连 applyQuestionSnapshot 亦可重建）。
   * runtime 挂 pet → pet splice 后 runtime 随之消失（loadSession 重建 pet 时 AgentDialog 退 default 预选）。
   */
  function removePetsOnly(removeIds: string[]): void {
    for (const id of removeIds) {
      const idx = pets.value.findIndex((p) => p.chatId === id)
      if (idx >= 0) pets.value.splice(idx, 1)
    }
    if (ui.activeDialogChatId.value && removeIds.includes(ui.activeDialogChatId.value)) {
      ui.activeDialogChatId.value = null
    }
    // 抽屉栈：移除所有被删 chat（深层下钻中被删 chat 的层一并清理）
    ui.pruneHistoryStack(removeIds)
  }

  /**
   * 移除 pets + streams + active 焦点（彻底删会话）。deleteSession 用。
   */
  function removePetsAndStreams(removeIds: string[]): void {
    for (const id of removeIds) {
      const idx = pets.value.findIndex((p) => p.chatId === id)
      if (idx >= 0) pets.value.splice(idx, 1)
      delete streams.value[id]
    }
    if (ui.activeDialogChatId.value && removeIds.includes(ui.activeDialogChatId.value)) {
      ui.activeDialogChatId.value = null
    }
    ui.pruneHistoryStack(removeIds)
  }

  // ── 模块初始化（按依赖顺序） ──

  const approval = createApprovalActions(streams, pets)
  const question = createQuestionActions(streams, pets, resumeAgent)

  /**
   * 后端问题快照是权威 replace，但它不能倒退已观察到的事件。
   * Cursor 只由带 seq 的事件推进；attach/chat.get 的 snapshotSeq 仅用于
   * 建立回放屏障，绝不能直接跳过 `(oldCursor, snapshotSeq]` 的事件。
   */
  function applyQuestionSnapshot(chatId: string, data: unknown): void {
    const snapshot = data as
      | {
          snapshotSeq?: number
          pendingQuestionBatches?: QuestionBatchPayload[]
        }
      | undefined
    if (
      typeof snapshot?.snapshotSeq !== 'number' ||
      !Array.isArray(snapshot.pendingQuestionBatches)
    ) {
      return
    }
    // pending 中的实时事件也算“已观察到”：它们正等待 replay fence 释放，
    // 不能被较早快照反向覆盖。
    if (wsClient.getHighestSeenSeq(chatId) > snapshot.snapshotSeq) return
    const stream = _ensureStream(streams, chatId)
    replaceQuestionBatches(stream, snapshot.pendingQuestionBatches)
  }

  /**
   * 后端 currentState 是权威 replace；同步 pendingApproval / runningTools / currentTodo。
   * 镜像 applyQuestionSnapshot 模式：快照不能倒退已观察到的事件，seq 仅由事件消费推进。
   * - pendingApproval → stream.approval（=pendingApproval，含 waitTime/createdAt 倒计时）+ 清 approvalQueue
   * - runningTools → stream.runningTools（含 smart/manual 待审批，补实时态缺口）
   * - currentTodo → stream.currentTodo（F5 收口：TodoPanel 改读此字段）
   * 缺 currentState 字段 = 后端未提供实时态；不动 StreamState。
   */
  function applyCurrentState(chatId: string, data: unknown): void {
    const cs = (data as { currentState?: CurrentStateData } | undefined)?.currentState
    if (!cs) return
    const snapshot = (data as { snapshotSeq?: number }).snapshotSeq
    if (typeof snapshot === 'number' && wsClient.getHighestSeenSeq(chatId) > snapshot) return
    const stream = _ensureStream(streams, chatId)
    // pendingApproval → approval 权威 replace（审批存活判定：后端内存命中即视为仍挂起）
    if (cs.pendingApproval) {
      stream.approval = {
        approvalId: cs.pendingApproval.approvalId,
        senseName: cs.pendingApproval.senseName,
        args: cs.pendingApproval.arguments,
        waitTime: cs.pendingApproval.waitTime,
        createdAt: cs.pendingApproval.createdAt,
      }
      stream.approvalQueue = []
    } else {
      // 无 pendingApproval → 清空审批（run 已 paused 或无可挂起）
      stream.approval = undefined
      stream.approvalQueue = []
    }
    // runningTools 权威 replace（含 smart/manual 待审批 → 补实时态缺口：parked 子 chat spinner 不再残留）
    stream.runningTools = cs.runningTools.map((t) => ({ id: t.id, name: t.senseName }))
    // currentTodo 透传（暂存 stream 顶层）
    if (cs.currentTodo !== undefined) {
      stream.currentTodo = cs.currentTodo
    }
  }

  const lifecycle = createPetLifecycle(
    pets,
    streams,
    historyList,
    ui.historyListOpen,
    getRuntime,
    setWorking,
    removePetsOnly,
    removePetsAndStreams,
    ui.activeNyxusChatId,
  )

  // ── 流式 RPC 编排（sendMessage/resumeAgent 用 standalone ensureStream/trackRequest） ──

  /**
   * 发消息（AgentDialog 调用）。runtime diff 决策：
   *   - runtime 提供 + 与当前不同 → agentApi.setRuntime 再 sendMessage
   *   - runtime 与当前同 / 未提供 → 直接 sendMessage
   *   - 首次（chat 刚由 FAB 创建）→ runtime 已是 default，直接 sendMessage
   * 发送后重置 stream 累积 + pet 进 isWorking（chatting action）。
   * 错误显式抛出（规则 12），调用方 try/catch 显示错误态。
   * 参数顺序：attachments 前置（与 agentApi.sendMessage 对齐，常用参数先），runtime 后置（差异场景才用）。
   */
  async function sendMessage(
    chatId: string,
    text: string,
    attachments?: ChatSendAttachment[],
    runtime?: RuntimeSelection,
  ): Promise<void> {
    if (runtime) {
      const pet = petForChat(chatId)
      const cur = pet?.runtime
      if (!cur || !sameRuntime(cur, runtime)) {
        await agentApi.setRuntime(chatId, runtime)
        if (pet) {
          pet.runtime = {
            brain: runtime.brain,
            senseGroup: runtime.senseGroup,
            mcpServers: [...(runtime.mcpServers ?? [])],
          }
        }
      }
    }
    const { requestId, done } = agentApi.sendMessage(chatId, text, attachments)
    _trackRequest(requestMap, requestId, chatId)
    const pet = petForChat(chatId)
    setWorking(pet, true)
    const stream = _ensureStream(streams, chatId)
    // 新一轮发送：重置实时累积。当前 pending 审批不丢失 → 移到 queue 保留（用户可从 PetIcons 重新唤起）。
    // history dirty：新轮产生新消息，缓存失效，下次 drawer 打开需 reload
    stream.thinking = ''
    stream.content = ''
    stream.isWorking = true
    // 清上一轮残留提问态（避免残留 activeQuestionId 抑制本轮新卡片；yield-turn 下 done 不清，故此显式重置）
    stream.questionBatches = []
    stream.activeQuestionId = undefined
    // 若已有活跃 run，当前请求只是入队；否则 requestId 即本轮 runId。
    if (!stream.activeRunId) stream.activeRunId = requestId
    stream.historyDirty = true
    // 即时 push user prompt 到 history（让 drawer 打开期间即时显自己发的消息）
    // F4：走 pushHistoryItem 统一入口（msgId 占位 = tempMsgId，与 B 源 staged 同轴幂等）。
    // msgId/agentChatId 后端 response.data.userMsgId 到达后再补；若 drawer 在此之前 reload 也不会重复（user prompt 仅一条）。
    const tempMsgId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    pushHistoryItem(stream, {
      role: 'user',
      content: text,
      createdAt: Date.now(),
      msgId: tempMsgId,
      agentChatId: chatId,
    })
    if (stream.approval) {
      stream.approvalQueue.push(stream.approval)
      stream.approval = undefined
    }
    stream.retainUntil = undefined
    // P3：清旧 error（新轮起，错误状态不残留）
    stream.error = undefined
    // P3：捕获 final Response 终态。success:false（后端 P2 修复产 failureResponse）→ stream.error。
    // done Promise 在流结束时 resolve；catch 仅网络中断（ws 断）才触发。
    done
      .then((res) => {
        const data = res.data as { runId?: string; queued?: boolean } | undefined
        // 正常路径已先收到 done 并清 activeRunId；仅仍在运行（queued）时更新关联。
        if (typeof data?.runId === 'string' && stream.isWorking) {
          stream.activeRunId = data.runId
        }
        // queued 请求不拥有独立事件流，收到最终 Response 后即可释放其旧 requestId 映射。
        if (data?.queued) requestMap.delete(requestId)
        if (!res.success) {
          stream.error = res.error?.message ?? '系统出了点小问题'
          console.error('[agents] sendMessage response failed:', res.error)
          return
        }
        // 后端回 userMsgId → 用真 msgId 替换临时占位符，dedup 用
        const userMsgId = (res.data as { userMsgId?: string } | undefined)?.userMsgId
        if (userMsgId) {
          const idx = stream.history.findIndex((h) => h.msgId === tempMsgId)
          if (idx >= 0) {
            const item = stream.history[idx]
            if (item) stream.history[idx] = { ...item, msgId: userMsgId, agentChatId: chatId }
          }
        }
      })
      .catch((e) => {
        stream.error = '连接断了，请重试'
        console.error('[agents] sendMessage done rejected:', e)
      })
  }

  /**
   * 续跑 chat（chat.resume，无 prompt）。T9 wait=true 唤醒轮：后端注入角色回复 + 推 role_reply
   * → 本方法 resume 主处理注入消息（loop 见末条 role:role 或旧 subagent → LLM 响应）。也用于重连续跑 interrupted wait-子。
   * 复用 sendMessage 的 trackRequest/setWorking/ensureStream 机制（run("") 起流）。
   */
  async function resumeAgent(chatId: string): Promise<void> {
    const { requestId, done } = agentApi.resumeChat(chatId)
    _trackRequest(requestMap, requestId, chatId)
    const pet = petForChat(chatId)
    setWorking(pet, true)
    const stream = _ensureStream(streams, chatId)
    stream.thinking = ''
    stream.content = ''
    stream.isWorking = true
    // resume 是新一轮（问答答完后续跑 / spawn 唤醒）：清残留提问态，同 sendMessage。
    stream.questionBatches = []
    stream.activeQuestionId = undefined
    if (!stream.activeRunId) stream.activeRunId = requestId
    // resume 同 sendMessage：标 dirty 让下次 drawer 打开 reload（resume 可能产生新 assistant 回复）
    stream.historyDirty = true
    // resume 同 sendMessage：当前审批不丢失 → 移到 queue 保留
    if (stream.approval) {
      stream.approvalQueue.push(stream.approval)
      stream.approval = undefined
    }
    stream.retainUntil = undefined
    // P3：清旧 error + 捕获 resume 终态（与 sendMessage 同步）
    stream.error = undefined
    done
      .then((res) => {
        const data = res.data as { runId?: string; alreadyRunning?: boolean } | undefined
        if (typeof data?.runId === 'string' && stream.isWorking) stream.activeRunId = data.runId
        if (data?.alreadyRunning) requestMap.delete(requestId)
        if (!res.success) {
          stream.error = res.error?.message ?? '系统出了点小问题'
          console.error('[agents] resumeChat response failed:', res.error)
        }
      })
      .catch((e) => {
        stream.error = '连接断了，请重试'
        console.error('[agents] resumeChat done rejected:', e)
      })
  }

  /**
   * A child chat is an independent stream.  role_created only creates its
   * visual shell; recovery attaches that child itself instead of issuing a
   * second startSpawn request against the already eager-started task.
   */
  async function recoverChildChat(chatId: string): Promise<void> {
    try {
      const chats = await agentApi.listChats()
      allChatsCache.value = chats
      const child = chats.find((chat) => chat.chatId === chatId)
      if (!child) return
      await recoverUnattachedChat(child, true, true)
    } catch (e) {
      console.warn(`[agents] 子 chat 恢复失败 ${chatId}:`, e)
    }
  }

  const router = createStreamRouter(
    streams,
    pets,
    requestMap,
    setWorking,
    approval.dismissApproval,
    recoverChildChat,
    resumeAgent,
    lifecycle.pickGhostFace,
    allChatsCache,
  )

  /**
   * 将权威会话树投影为舞台 pet。会话事件、快照与重连恢复都可调用；因此
   * role_created 不再是创建子 pet 的唯一、不可恢复的瞬时命令。
   * 这里仅补建/收尾身份视觉，坐标、拖拽和动画仍保留在既有 PetInstance 上。
   */
  function reconcilePetsFromSessions(sessions: Record<string, ChatSession>): void {
    for (const session of Object.values(sessions)) {
      const meta = session.meta
      if (!meta.parentChatId || !meta.agentType) continue
      const existing = pets.value.find((pet) => pet.chatId === session.chatId)
      if (!existing) {
        router.applyRoleCreated(
          {
            chatId: session.chatId,
            parentChatId: meta.parentChatId,
            type: meta.agentType,
            avatar: meta.avatar,
            brain: session.context.runtime?.brain,
            senseGroup: session.context.runtime?.senseGroup,
          },
          {
            recover: false,
            working: session.run.status === 'running',
            finished: meta.finished === true,
          },
        )
        continue
      }
      if (meta.finished === true) {
        turnChildIntoGhost(existing, pets.value, lifecycle.pickGhostFace)
      } else {
        setWorking(existing, session.run.status === 'running')
      }
    }
  }

  // ── 剩余编排函数 ──

  /**
   * 载入内置工具元信息（sense.tools）+ sense 组解析（sense.list）。
   * initFromChats 调一次；供 RunningTools icon 查询 + 能力判定（pet senseGroups 含某工具）。
   * 失败不阻塞（容错降级 → icon fallback ⚙ / 能力判定 false，规则12 warn）。
   */
  async function loadSenseMeta(): Promise<void> {
    const [tools, groups] = await Promise.all([
      agentApi.listSenseTools(),
      agentApi.listSenseGroups(),
    ])
    senseTools.value = tools
    senseGroupsResolved.value = groups
  }

  /** 工具名→icon（senseTools 缓存）；未命中 fallback ⚙。RunningTools 渲染用。 */
  function iconForTool(name: string): string {
    return senseTools.value.find((t) => t.name === name)?.icon ?? '⚙'
  }

  /**
   * 能力判定：senseGroup（组名）经 sense.list 解析为 sense 名集合后，是否含 senseName（如 "update_todo"）。
   * 组未解析到（loadSenseMeta 未完成/失败）→ false（降级，不显侧栏）。
   */
  function senseGroupsHasSense(senseGroup: string | undefined, senseName: string): boolean {
    if (!senseGroup) return false
    const senses = senseGroupsResolved.value.find((r) => r.name === senseGroup)?.senses
    return !!senses?.includes(senseName)
  }

  function activatePresetSession(
    presetId: string | undefined,
    chatId: string,
    presetName?: string,
  ): void {
    const summary = summaryForChat(chatId)
    const key = presetKey(presetId ?? summary?.presetId, presetName ?? summary?.preset)
    if (!key) return
    ui.activeRootByPreset.value[key] = chatId
    const pet = pets.value.find(
      (candidate) => candidate.isMaster && presetKey(candidate.presetId, candidate.preset) === key,
    )
    if (pet) setWorking(pet, streams.value[chatId]?.isWorking === true || summary?.running === true)
  }

  /** 连接成功后拉 chat.list → 重建 pet 树。幂等（initialized 守卫），失败可重试。 */
  async function initFromChats(): Promise<void> {
    if (initialized) return
    // listChats 失败 → initialized 不置位，下次 status=connected 时可重试
    const [chats, configSnapshot] = await Promise.all([
      agentApi.listChats(),
      agentApi.getConfig().catch((cause) => {
        console.warn('[agents] 读取预设目录失败，暂保留历史 Pet 投影:', cause)
        return undefined
      }),
    ])
    initialized = true
    globalConfig.value = configSnapshot ?? null

    // 载入工具元信息 + 组解析（icon 查询 + 能力判定用）；失败不阻塞（容错降级）
    loadSenseMeta().catch((e) => console.warn('[agents] loadSenseMeta 失败:', e))

    // 缓存完整 chat 列表（getHistory 用它找子 chat，避免仅依赖 pets 的 top-5 限制）
    allChatsCache.value = chats
    console.log('[agents] initFromChats: allChatsCache 已初始化', {
      totalChats: chats.length,
      mainChats: chats.filter((c) => !c.parentChatId).length,
      childChats: chats.filter((c) => c.parentChatId).length,
    })

    const bounds = defaultBounds()
    const usedFaces = new Set<Record<PetMood, string>>()
    const activePresetIds = configSnapshot
      ? new Set(Object.values(configSnapshot.presets ?? {}).map((preset) => preset.id).filter(Boolean))
      : undefined
    const activePresetNames = configSnapshot
      ? new Set(Object.keys(configSnapshot.presets ?? {}))
      : undefined
    const mains = chats.filter(
      (c) =>
        !c.parentChatId &&
        c.preset !== CHERY_NYXUS_PRESET &&
        (!activePresetIds ||
          (c.presetId ? activePresetIds.has(c.presetId) : !!c.preset && activePresetNames!.has(c.preset))),
    )

    // CP8：stage 默认显最近 5 个会话。sessionRecency = max(master.updatedAt, 其子 updatedAt)
    //   （子 agent done 会回传/注入主 chat → 主 updatedAt 被刷新，但子运行中窗口期取 max 更准）
    const grouped = new Map<string, ChatSummary[]>()
    for (const main of mains) {
      const key = main.presetId ?? (main.preset ? `legacy:${main.preset}` : `chat:${main.chatId}`)
      const group = grouped.get(key)
      if (group) group.push(main)
      else grouped.set(key, [main])
    }
    const topMasters = [...grouped.values()]
      .map((roots) => {
        const m = [...roots].sort(
          (a, b) =>
            (b.lastUserActivityAt ?? b.createdAt ?? 0) -
            (a.lastUserActivityAt ?? a.createdAt ?? 0),
        )[0]!
        const recency = Math.max(...roots.map((root) => root.lastUserActivityAt ?? root.updatedAt ?? 0))
        return { m, recency }
      })
      .sort((a, b) => b.recency - a.recency)
      .slice(0, 5)
      .map((x) => x.m)

    for (const m of topMasters) {
      lifecycle.buildMasterAndChildren(m, chats, bounds, usedFaces)
    }

    // 重连后重建 wait 唤醒态 + 检测主卡死（容错机制，见 docs/agent-pet.md §5.8）
    await rebuildSpawnWaits(chats)
    // F5 重连运行中 run 的实时流：先 attach（开启后端输出重定向）→ 再 syncChatEvents（'resume' 回放补齐当前实时态）。
    // 顺序关键：attach 在 sync 之前，断连窗口后续实时事件由 sync 推进 cursor 后 drainChatEvents 连续补放。
    await attachRunningChats(chats)
    // F5 是新的浏览器进程，尚无 seq cursor；只恢复当前舞台上的普通 Pet。
    // Nyxus 及其后代由用户打开具体 root 后通过 root timeline 原子恢复。
    await syncChatEvents()

    // 初始载入 contextUsage（ContextBar 渲染用）。
    // initFromChats 仅用 chat.list（不含 contextUsage），需单独拉；done/chat.get 是后续实时路径。
    // 拉全部主 chat（非仅 top 5），确保所有可见 pet 的 ContextBar 初始渲染正确。
    // 失败不阻塞初始化（静默降级：bar 留 0 等下次 done 刷新）。
    Promise.all(
      mains.map((m) =>
        agentApi.contextUsage(m.chatId).then(
          (res) => {
            const pet = pets.value.find((p) => p.chatId === m.chatId)
            if (pet) {
              if (typeof res.contextUsage === 'number') pet.contextUsage = res.contextUsage
              if (typeof res.contextUsed === 'number') pet.contextUsed = res.contextUsed
              if (typeof res.contextTotal === 'number') pet.contextTotal = res.contextTotal
              if (res.contextBreakdown) pet.contextBreakdown = res.contextBreakdown
              if (res.commandConfig) pet.commandConfig = res.commandConfig
            }
          },
          (e) => console.warn(`[agents] contextUsage(${m.chatId}) 失败:`, e),
        ),
      ),
    ).catch(() => {})

  }

  /**
   * F5 重连运行中 run 的实时流（主 + 子 Agent）。initFromChats 在 syncChatEvents **之前**调用：
   * 先 chat.attach 开启后端输出重定向到本连接，再由 syncChatEvents（'resume' 回放）补齐当前实时态，
   * 后续 chunk 经 WS envelope(chatId) 无缝续显。attach 返回 running:false（竞态已停）→ 交给 canResume/继续按钮。
   *
   * 仅对已建 pet 的 chat（top-5 主 + 全部后代）恢复；未上台的运行中主 chat 待 loadSession 时再处理。
   * 同页瞬断重连不走此路径（ws.ts 复用原 requestId 触发后端 active-join 重定向）。
   */
  async function attachRunningChats(chats: ChatSummary[]): Promise<void> {
    const recoveryChats = selectRefreshRecoveryChats(
      chats,
      new Set(pets.value.map((pet) => pet.chatId)),
    )
    await Promise.all(
      recoveryChats
        // attach 同时登记服务端订阅；idle 主 chat 也必须登记，才能在子完成后
        // 收到 role_reply / child_abandoned。running chat 另行接收实时 stream。
        .filter((c) => !c.finished)
        .map(async (c) => {
          const pet = pets.value.find((p) => p.chatId === c.chatId)
          if (!pet) return
          try {
            const res = await agentApi.attachChat(c.chatId)
            // attach 已开始向本连接推实时事件。先立住 snapshotSeq 屏障，
            // 再回放旧 cursor 到该屏障；屏障后的 live event 会暂存到 replay 结束。
            wsClient.beginChatReplay(c.chatId, res.snapshotSeq)
            // 1. 权威 replace 实时态（pendingApproval / runningTools / currentTodo）
            applyCurrentState(c.chatId, res)
            // 2. 权威 replace parked question batches（否则断连期发出的 question_requested 通知丢失）
            applyQuestionSnapshot(c.chatId, res)
            if (res.running) {
              // chat.list 与 attach 之间可能刚起跑；以 attach 的实时判定为准，
              // 避免 replay finally 按旧 list.running 清掉刚恢复的 loading。
              const attachedChat = c.running ? c : { ...c, running: true }
              const stream = _ensureStream(streams, c.chatId)
              stream.isWorking = true
              setWorking(pet, true)
              await syncOneChat(attachedChat, 'replay', res.snapshotSeq)
            } else {
              // attach 的 running:false 有两种含义：run 已结束，或旧 owner 仍 OPEN
              // 导致接管被拒。无论哪种都先回放持久事件；若尚未收到终态则后台
              // 继续 sync + attach，不能让刷新页永久停在 loading。
              await syncOneChat(c, 'replay', res.snapshotSeq)
              if (streams.value[c.chatId]?.isWorking) {
                void recoverUnattachedChat(c)
              }
            }
          } catch (e) {
            console.warn(`[agents] attachChat 失败 ${c.chatId}:`, e)
            // 临时网络错误或旧连接尚未释放时不能放弃；恢复任务会以最新摘要重试。
            void recoverUnattachedChat(c)
          }
        }),
    )
  }

  /**
   * attach 暂时失败后的恢复兜底。
   *
   * 后端会区分「已结束」与「仍被另一 OPEN 连接持有」；前者由 sync 回放 done/error
   * 收口，后者在旧 owner 释放前持续补事件。每轮先重新 list，也覆盖 F5 时
   * 子 pet 已创建、但 eager 子 run 尚未进入 running 的窗口。
   */
  async function recoverUnattachedChat(
    chat: ChatSummary,
    immediate = false,
    loadHistory = false,
  ): Promise<void> {
    const existing = attachRecoveryTasks.get(chat.chatId)
    if (existing) return existing

    const task = (async () => {
      let firstAttempt = true
      let historyRecovered = false
      while (true) {
        // 首轮 attach 已由 attachRunningChats 发起；等待让旧 socket 的 close/bind 完成。
        if (!immediate || !firstAttempt) {
          await new Promise<void>((resolve) => window.setTimeout(resolve, ATTACH_RECOVERY_DELAY_MS))
        }
        firstAttempt = false
        try {
          const chats = await agentApi.listChats()
          allChatsCache.value = chats
          const latest = chats.find((item) => item.chatId === chat.chatId)
          if (!latest || latest.finished) {
            if (latest) await syncOneChat(latest, 'replay')
            return
          }

          // idle chat 也要 attach：它可能正等待 eager launcher，attach 后才能
          // 收到其独立 chatId 的第一条实时 stream/tool/done。
          const res = await agentApi.attachChat(latest.chatId)
          wsClient.beginChatReplay(latest.chatId, res.snapshotSeq)
          applyCurrentState(latest.chatId, res)
          applyQuestionSnapshot(latest.chatId, res)

          if (!res.running) {
            await syncOneChat(latest, 'replay', res.snapshotSeq)
            if (loadHistory && !historyRecovered) {
              historyRecovered = true
              await getHistory(latest.chatId)
            }
            // eager launcher 尚未写入首条 user message 的新子 chat 继续等；其他
            // 非 running chat 是已暂停状态，不能由刷新逻辑擅自 resume。
            const waitingForEagerStart =
              !!latest.parentChatId &&
              (latest.messageCount === undefined || latest.messageCount === 0)
            if (waitingForEagerStart) continue
            return
          }

          const attachedChat = latest.running ? latest : { ...latest, running: true }
          await syncOneChat(attachedChat, 'replay', res.snapshotSeq)
          if (loadHistory && !historyRecovered) {
            historyRecovered = true
            await getHistory(latest.chatId)
          }
          if (res.running || !streams.value[latest.chatId]?.isWorking) return
        } catch (e) {
          // RPC/网络临时失败不终止恢复；下一轮取最新 chat.list 后重试。
          console.warn(`[agents] attach 恢复失败 ${chat.chatId}:`, e)
        }
      }
    })().finally(() => attachRecoveryTasks.delete(chat.chatId))
    attachRecoveryTasks.set(chat.chatId, task)
    return task
  }

  /**
   * 重连后重建 wait 唤醒态（T9.10 重构；统一暂停语义 + F5 attach 后精简）。
   *
   * 刷新/重连只恢复状态，不自动调用 chat.resume。未完成会话由 chat.list.canResume
   * 映射到 pet 工具栏“继续”按钮，用户点击后才恢复。
   *
   * 运行中主 chat 不再判卡死 abort：F5 后由 attachRunningChats 重连实时流（见 docs/agent-pet.md §5.8.3），
   * 真正 wedged 的 run 交给后端看门狗/进程级处理，前端不再用「800ms→abort」误杀正在跑的 run。
   * 子会话（含 wait-子）只映射 finished/canResume 到 pet，不在刷新阶段自动续跑。
   */
  async function rebuildSpawnWaits(chats?: ChatSummary[]): Promise<void> {
    // chat.list 权威字段（finished/canResume）已在 buildMasterAndChildren 映射到 pet；
    // 此处保留为扩展点（重连后按需重建等待态），当前无需额外动作。
    void chats
  }

  /**
   * 载入历史（HistoryDrawer 打开时调 / 主动预加载调）。
   * dirty 守卫 + in-flight 去重：缓存命中或并发请求中均零额外 RPC。
   *
   * 主 chat 载入全部后代历史并按时间合流；子 chat 自身抽屉只显示本 chat 的 direct 历史。
   */
  // in-flight 去重：同一 chatId 并发请求 → 共享同一 Promise
  const inFlightHistory = new Map<string, Promise<void>>()

  async function getHistory(chatId: string): Promise<void> {
    // 1) 缓存命中：!dirty && loaded → 零 RPC 直接 return
    const cur = streams.value[chatId]
    if (cur && !cur.historyDirty && cur.historyLoaded) {
      return
    }
    // 2) 并发去重：已有同 chatId in-flight → await 同一 Promise
    const inflight = inFlightHistory.get(chatId)
    if (inflight) return inflight

    const p = doLoadHistory(chatId)
    inFlightHistory.set(chatId, p)
    // 完成后清 in-flight（finally 模式，吞错误也清理）
    p.catch(() => {}).finally(() => inFlightHistory.delete(chatId))
    return p
  }

  /**
   * M1+M2+M9 修复后：主 chat 历史完全走 chat.get（syncOneChat loadHistory 模式），子 chat 仍 chat.get + remapChildHistory。
   * 双 RPC 语义对齐后端契约：
   * - chat.get = 全量历史（messages 表 + contextUsage + workspace + canResume 一并到位）
   * - chat.sync = 增量回放（chat_events seq>afterSeq + 超窗回填，attach 后补回 disconnect-window）
   * - chat.attach = 重定向 + cursor 锚点（response 携带 snapshotSeq，前端 resetChatSeq 推进 cursor）
   *
   * 主 chat 串行（chat.get 灌满 stream.history + 写 pet.contextUsage/workspace 后再合流子 remap）；
   * 子 chat 并行（childHistoryPromises 各自 chat.get + remap）。
   * 同步全由 streamRouter.routeChunk → accumulateStaged → stream.history 写入，无需 doLoadHistory 介入累积。
   */
  async function doLoadHistory(chatId: string): Promise<void> {
    // 先刷新 allChatsCache（确保包含最新创建的后代 agent，避免子 spawn 孙后主 cache 缺孙的信息）
    try {
      const chats = await agentApi.listChats()
      allChatsCache.value = chats
    } catch (e) {
      console.warn('[agents] getHistory: 刷新 allChatsCache 失败，使用缓存', e)
    }

    const openedSummary = allChatsCache.value.find((c) => c.chatId === chatId)
    const openedIsSubChat = !!openedSummary?.parentChatId
    const stream = router.ensureStream(chatId)

    try {
      if (openedIsSubChat) {
        // opened chat 自身为子 chat（ghost 自身抽屉）→ 仍走 chat.get 单流（无后代合流）
        const { requestId, done } = agentApi.getHistory(chatId)
        router.trackRequest(requestId, chatId)
        stream.history = []
        stream.historyLoaded = false
        const pet = pets.value.find((p) => p.chatId === chatId)
        if (!hasActiveChatRun(stream, pet)) {
          stream.thinking = ''
          stream.content = ''
          stream.retainUntil = undefined
          setWorking(pet, false)
        }
        const response = await done
        if (response.success) applyQuestionSnapshot(chatId, response.data)
        const openedParentChatId = openedSummary?.parentChatId ?? chatId
        const ownHistory = lifecycle.remapChildHistory(stream.history, chatId, openedParentChatId)
        streams.value[chatId] = {
          ...stream,
          history: ownHistory,
          historyLoaded: true,
        }
        // 子 chat direct 视图：不拉 contextUsage（ContextBar 仅主 pet 渲染；pet 无 contextUsage 字段兜底 0）
      } else {
        // 主 chat：syncOneChat(loadHistory) 内部走 chat.get（全量历史 + contextUsage/workspace/canResume 一并到位，无需独立 RPC 兜底）
        if (openedSummary) await syncOneChat(openedSummary, 'loadHistory')

        // 并行获取所有子 chat 的历史（子 chat 仍走 chat.get 仅取消息 + remap，不走 staged 累积）
        const descendantIds = collectDescendantChatIds(allChatsCache.value, chatId)
        const childChatSummaries = descendantIds
          .map((id) => allChatsCache.value.find((c) => c.chatId === id))
          .filter((chat): chat is ChatSummary => !!chat)
        const childHistoryPromises = childChatSummaries.map(async (childSummary) => {
          const childChatId = childSummary.chatId
          console.log('[agents] getHistory: 加载子 chat 历史', { childChatId })
          const { requestId: childRequestId, done: childDone } = agentApi.getHistory(childChatId)
          router.trackRequest(childRequestId, childChatId) // 注册 requestId 供 routeChunk 路由
          const childStream = router.ensureStream(childChatId)
          childStream.history = []
          const childResponse = await childDone
          if (childResponse.success) applyQuestionSnapshot(childChatId, childResponse.data)
          return lifecycle.remapChildHistory(
            childStream.history,
            childChatId,
            childSummary.parentChatId ?? chatId,
          )
        })
        const childHistories = await Promise.all(childHistoryPromises)

        // 层④ 合流：主 chat chat.get 流 + 子 chat remap（M1+M2+M9 修复后主 chat history 由 chat.get 全量灌入，
        // 合流仅做跨 chat 物理去重 + 时间线排序，不重建 staged）
        const allHistory: HistoryItem[] = [...stream.history, ...childHistories.flat()]
        const seenMsgIds = new Set<string>()
        const deduped: HistoryItem[] = []
        for (const item of allHistory) {
          if (item.msgId) {
            if (seenMsgIds.has(item.msgId)) continue
            seenMsgIds.add(item.msgId)
          }
          deduped.push(item)
        }
        // 按 createdAt 排序（实现群聊样式的时间线）
        deduped.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))

        // 通过 streams.value[chatId] 赋值（而非 stream 变量），确保 Vue 响应式系统检测到变化
        streams.value[chatId] = {
          ...stream,
          history: deduped,
          historyLoaded: true,
          historyDirty: false,
        }
      }
    } catch (e) {
      console.error('[agents] 合并子 chat 历史失败:', e)
      // 降级：只显示主 chat 历史
      stream.historyLoaded = true
    }
  }

  /**
   * 中止 chat 当前流（CP6 主/子 pet 工具栏）。后端 chat.abort 清运行时 + 释放连接，
   * 可能不推 done → 手动清工作态（pet isWorking + stream.isWorking）。
   * 统一暂停语义：abort=暂停，乐观设 canResume=true 立即显继续按钮（下次 chat.list 权威覆盖）；
   *   前端级联标记所有后代 pet 暂停态（主停→子停）。
   */
  async function abort(chatId: string): Promise<void> {
    const stream = streams.value[chatId]
    await agentApi.abortAgent(chatId, stream?.activeRunId)
    const pet = petForChat(chatId)
    setWorking(pet, false)
    if (stream) {
      stream.isWorking = false
      stream.activeRunId = undefined
      stream.retainUntil = undefined
    }
    if (pet) pet.canResume = true
    // 前端级联：所有后代 pet 清工作态 + 乐观设 canResume（后端级联 abort 已停其后台流）。
    // 掐断即终态：后代子 pet 立即转 ghost（不等 WS 投递兜底），与「主停→子停→子转 ghost」语义对齐。
    const descendantIds = collectDescendantChatIds(pets.value, chatId)
    for (const childId of descendantIds) {
      const childPet = pets.value.find((p) => p.chatId === childId)
      const childStream = streams.value[childId]
      if (childPet) {
        setWorking(childPet, false)
        childPet.canResume = false
        turnChildIntoGhost(childPet, pets.value, lifecycle.pickGhostFace)
      }
      if (childStream) {
        childStream.isWorking = false
        childStream.activeRunId = undefined
        childStream.retainUntil = undefined
      }
    }
  }

  /** 应用当前会话临时角色编制。只更新内存/服务端运行时，绝不调用持久化 runtime.set。
   *  返回 session.runtime.set 的 applied/deferredRunning，供调用方反馈子切换结果。 */
  async function setSessionRuntime(
    chatId: string,
    selection: SessionRuntimeSelection,
  ): Promise<{ applied: string[]; deferredRunning: string[] }> {
    const result = await agentApi.setSessionRuntime(chatId, selection)
    const pet = petForChat(chatId)
    if (pet)
      pet.runtime = { ...selection.primary, mcpServers: [...(selection.primary.mcpServers ?? [])] }
    return result
  }

  /** 拉取全量会话列表（includePreview=true）缓存到 historyList。CP8：会话列表打开时调。 */
  async function fetchHistoryList(): Promise<void> {
    const chats = await agentApi.listChats(true)
    historyList.value = chats
    allChatsCache.value = chats
  }

  /**
   * 标记所有已加载 stream dirty（WS 重连兜底）。
   * disconnect 期间后端可能产生新消息（其他客户端 send、role_created 等），
   * 重连后无法依赖 sendMessage/role_reply 隐含 dirty 触发（事件可能漏推），
   * 故强制全标 dirty → 下次 drawer 打开必 reload 走完整合流。
   */
  function markAllStreamsDirty(): void {
    for (const id in streams.value) {
      const s = streams.value[id]
      if (s) s.historyDirty = true
    }
  }

  /**
   * F4 抽内核：单 chat 同步持久化事件 + currentState 快照。
   * syncChatEvents 批量调用 + doLoadHistory 主 chat 路径共用此函数。
   * - `mode='replay'`（默认）：syncChatEvents 批量场景，保留原回放模式语义（非运行 chat 清空实时态 + dirty/loaded 时机）
   * - `mode='loadHistory'`：doLoadHistory 主 chat 路径，sync 完成后立即设 historyLoaded=true + historyDirty=false
   *
   * On reconnect, replay the persisted delta for every known chat. Event
   * envelopes carry chatId, so the normal router can consume them even though
   * chat.sync itself has a different request id. Expired cursors fall back to
   * chat.get snapshots.
   *
   * 修复：sync 回放的 stream chunks 会被 routeChunk 当作实时流处理，累积到 thinking/content，
   * done notification 设置 retainUntil=now+20s，导致已完成 chat 的气泡显示 20 秒；
   * 历史 role_reply 也会穿透守卫触发 resumeAgent，导致刷新即自动 resume。
   * 回放标记（stream.replaying，见 types.ts）一律 true（含非运行 chat）：
   * - 非运行 chat → 回放结束清空实时态 + 清标记（一次性回灌缓存）。
   * - 运行中 chat → 回放结束保留实时态、清标记，交给后续 attach 实时流继续推进
   *   （F5 重连，attachRunningChats 已开启后端重定向）。
   * 两条路径回放期行为一致：抑制副作用 RPC + 终态 + stream chunk 累加；实时态由 currentState 快照给定（F2）。
   */
  async function syncOneChat(
    chat: ChatSummary,
    mode: 'replay' | 'loadHistory' = 'replay',
    replayThroughSeq?: number,
  ): Promise<void> {
    const stream = _ensureStream(streams, chat.chatId)
    // loadHistory 模式：先清 history + dirty 标记，确保 chat.get 流重灌（与 doLoadHistory 旧 reset 语义一致）
    if (mode === 'loadHistory') {
      stream.history = []
      stream.historyLoaded = false
      const pet = pets.value.find((p) => p.chatId === chat.chatId)
      // 同 doLoadHistory 旧语义：等待审批仍属于活跃 run，必须保留 stream/pet 工作态
      if (!hasActiveChatRun(stream, pet)) {
        stream.thinking = ''
        stream.content = ''
        stream.retainUntil = undefined
        setWorking(pet, false)
      }
    }
    // replay 模式：仅 chat.sync（增量 + cursor）；loadHistory 模式：仅 chat.get（全量 + contextUsage）。
    // 两条路径语义对齐后端契约：chat.get = 全量历史（messages 表，retention-independent），
    // chat.sync = 增量回放（chat_events seq>afterSeq + 超窗回填）。
    if (mode === 'loadHistory') {
      // chat.get：无 cursor，无 replaying 标记（chat.get 与实时流无冲突）
      const { requestId, done } = agentApi.getHistory(chat.chatId)
      _trackRequest(requestMap, requestId, chat.chatId)
      const response = await done
      requestMap.delete(requestId)
      if (response.success) {
        // chat.get response 字段齐全：currentState + snapshotSeq + pendingQuestionBatches + canResume + contextUsage + workspace
        // 一次性 consume 全字段；无独立 contextUsage RPC 兜底
        applyQuestionSnapshot(chat.chatId, response.data)
        applyCurrentState(chat.chatId, response.data)
        const data = response.data as
          | {
              canResume?: boolean
              contextUsage?: number
              contextUsed?: number
              contextTotal?: number
              contextBreakdown?: ContextBreakdown
              commandConfig?: CommandConfigDataDto
              workspace?: string
              workspaceValid?: boolean
            }
          | undefined
        const pet = pets.value.find((p) => p.chatId === chat.chatId)
        if (pet) {
          if (typeof data?.canResume === 'boolean') pet.canResume = data.canResume
          if (typeof data?.contextUsage === 'number') pet.contextUsage = data.contextUsage
          if (typeof data?.contextUsed === 'number') pet.contextUsed = data.contextUsed
          if (typeof data?.contextTotal === 'number') pet.contextTotal = data.contextTotal
          if (data?.contextBreakdown) pet.contextBreakdown = data.contextBreakdown
          if (data?.commandConfig) pet.commandConfig = data.commandConfig
          if (typeof data?.workspace === 'string') pet.workspace = data.workspace
          if (typeof data?.workspaceValid === 'boolean') pet.workspaceValid = data.workspaceValid
        }
      }
    } else {
      // replay 模式：chat.sync 设回放标记，sync 流抑制副作用 RPC + 终态 + stream chunk 累加
      // 回放期一律 true（含非运行 chat）：历史 role_reply/done 等事件不得触发 resumeAgent/retainUntil，
      // 非运行 chat 的历史 stream delta 不得累加进气泡；运行中 chat 则重建最后一个未结束 run。
      stream.replaying = true
      stream.replayLiveChunks = !!chat.running
      try {
        const afterSeq = wsClient.getLastSeq(chat.chatId)
        const { requestId, done } = agentApi.syncChat(chat.chatId, afterSeq)
        _trackRequest(requestMap, requestId, chat.chatId)
        try {
          const response = await done
          if (response.success) {
            // sync 的事件本身顺序推进 cursor；response snapshot 只补不可由
            // 事件可靠推导的当前态，不能 reset cursor。
            applyQuestionSnapshot(chat.chatId, response.data)
            applyCurrentState(chat.chatId, response.data)
          }
        } finally {
          requestMap.delete(requestId)
        }
      } finally {
        // 顺序不能反：先让 router 离开 replay，再释放屏障后缓存的 live
        // 事件；这样每个 seq 恰好走一次正常 UI 路径。
        const cur = streams.value[chat.chatId]
        if (!chat.running) {
          if (cur) {
            cur.replaying = undefined
            cur.replayLiveChunks = undefined
            cur.thinking = ''
            cur.content = ''
            cur.isWorking = false
            cur.retainUntil = undefined
            cur.activeRunId = undefined
            cur.runningTools = []
            cur.error = undefined
            cur.approval = undefined
            cur.approvalQueue = []
            cur.questionBatches = []
          }
          const pet = pets.value.find((p) => p.chatId === chat.chatId)
          if (pet) setWorking(pet, false)
        } else if (cur) {
          cur.replaying = undefined
          cur.replayLiveChunks = undefined
          if (cur.isWorking) {
            const pet = pets.value.find((p) => p.chatId === chat.chatId)
            setWorking(pet, true)
          }
        }
        if (replayThroughSeq !== undefined) wsClient.endChatReplay(chat.chatId)
      }
    }
    // loadHistory 模式：chat.get 流已灌满 history + applyQuestionSnapshot 已推 cursor → 标 loaded + 清 dirty
    const curFinal = streams.value[chat.chatId]
    if (mode === 'loadHistory' && curFinal) {
      curFinal.historyLoaded = true
      curFinal.historyDirty = false
    }
  }

  async function syncChatEvents(): Promise<void> {
    const chats = await agentApi.listChats()
    allChatsCache.value = chats
    const recoveryChats = selectRefreshRecoveryChats(
      chats,
      new Set(pets.value.map((pet) => pet.chatId)),
    )
    await Promise.all(
      recoveryChats.map(async (chat) => {
        // A non-finished visible chat can still emit while this recovery is
        // running. Obtain a fresh attach snapshot first so sync has a stable
        // per-chat fence.
        if (!chat.finished) {
          try {
            const res = await agentApi.attachChat(chat.chatId)
            wsClient.beginChatReplay(chat.chatId, res.snapshotSeq)
            applyCurrentState(chat.chatId, res)
            applyQuestionSnapshot(chat.chatId, res)
            await syncOneChat(
              res.running && !chat.running ? { ...chat, running: true } : chat,
              'replay',
              res.snapshotSeq,
            )
            return
          } catch (e) {
            console.warn(`[agents] sync 前 attach 失败 ${chat.chatId}:`, e)
            void recoverUnattachedChat(chat)
          }
        }
        await syncOneChat(chat, 'replay')
      }),
    )
    // role_created 已落库、但 eager launcher 尚未把子 chat 标为 running 时，首轮
    // attachRunningChats 看不到它。给这类已展示的子 pet 保留恢复任务；真正运行后
    // 任务只 attach，不会再次 startSpawn 或重复执行子任务。
    for (const chat of recoveryChats) {
      const waitingForEagerStart =
        !!chat.parentChatId &&
        !chat.finished &&
        !chat.running &&
        (chat.messageCount === undefined || chat.messageCount === 0)
      if (waitingForEagerStart && pets.value.some((pet) => pet.chatId === chat.chatId)) {
        void recoverUnattachedChat(chat)
      }
    }
  }

  return {
    pets,
    allChatsCache,
    ...ui,
    streams,
    historyList,
    senseTools,
    senseGroupsResolved,
    globalConfig,
    loadSenseMeta,
    iconForTool,
    senseGroupsHasSense,
    initFromChats,
    rebuildSpawnWaits,
    ...lifecycle,
    sendMessage,
    resumeAgent,
    getHistory,
    abort,
    ...approval,
    ...question,
    fetchHistoryList,
    markAllStreamsDirty,
    syncChatEvents,
    getRuntime,
    setSessionRuntime,
    setWorkingForChat,
    activatePresetSession,
    activeRootForPet,
    petForChat,
    reconcilePetsFromSessions,
    removePetsOnly,
    ...router,
  }
})
