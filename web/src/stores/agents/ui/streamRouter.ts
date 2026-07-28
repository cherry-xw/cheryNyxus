import type { Ref } from 'vue'
import { applyRoleAvatar, generatePet } from '@/features/pets/types/petPresets'
import { findSpawnPosition } from '@/features/pets/motion/petMovement'
import { createPetInstance } from '@/features/pets/composables/usePetWorld'
import type { PetInstance } from '@/features/pets/types/types'
import type { ChatSummary, ContextBreakdown } from '@/services/agentApi'
import type {
  StreamState,
  StreamChunkData,
  StagedChunkData,
  ChunkMessage,
  NotificationMessage,
  ApprovalState,
} from '../types'
import {
  accumulateStaged,
  pushHistoryItem,
  fillSenseResultInHistory,
} from '../data/streamAccumulator'
import { defaultBounds } from '../data/streamAccumulator'
import {
  removeQuestionBatch,
  upsertQuestionBatch,
  type QuestionBatchPayload,
} from '../actions/questionBatch'
import { removeApprovalById } from '../actions/approvalActions'
import { turnChildIntoGhost } from '../data/petLifecycle'

/** role_created 通知 / chatSessions effect 共享的子 agent 诞生载荷。 */
type RoleCreatedData = {
  taskId?: string
  chatId?: string
  parentChatId?: string
  type?: string
  prompt?: string
  wake?: 'immediate' | 'deferred' | 'barrier'
  brain?: string
  senseGroup?: string
  avatar?: string
}

/**
 * 确保 chatId 对应的 StreamState 存在。不存在则创建默认结构。
 * 兼容历史 StreamState（已存在但无 approvalQueue / historyDirty / questionBatches 字段）→ 补初始化。
 */
export function ensureStream(
  streams: Ref<Record<string, StreamState>>,
  chatId: string,
): StreamState {
  let s = streams.value[chatId]
  if (!s) {
    s = {
      thinking: '',
      content: '',
      // 结构初始化不得断言 run 活跃：工作态由真正起跑路径（sendMessage/resumeAgent/
      // routeChunk stream chunk/attachRunningChats）显式置 true。默认 true 会让纯读历史
      // （getHistory→ensureStream）fabricate 出工作态，污染 hasActiveChatRun → 新 pet 抽屉永显「正在输入」。
      isWorking: false,
      history: [],
      historyLoaded: false,
      historyDirty: true, // 默认 dirty；首次 loaded notification 或显式预加载后清
      runningTools: [],
      approvalQueue: [],
      questionBatches: [],
    }
    streams.value[chatId] = s
  }
  // 兼容历史 StreamState（已存在但缺新字段）
  if (!s.approvalQueue) s.approvalQueue = []
  if (s.historyDirty === undefined) s.historyDirty = true
  if (!s.questionBatches) s.questionBatches = []
  return s
}

/**
 * 注册 requestId→chatId（流式 RPC 调用后立即调用，先于 response/ chunks）。
 * 供 routeChunk/routeNotification 路由用。
 */
export function trackRequest(
  requestMap: Map<string, string>,
  requestId: string,
  chatId: string,
): void {
  if (requestId) requestMap.set(requestId, chatId)
}

export function createStreamRouter(
  streams: Ref<Record<string, StreamState>>,
  pets: Ref<PetInstance[]>,
  requestMap: Map<string, string>,
  setWorking: (pet: PetInstance | undefined, working: boolean, freezeUntil?: number) => void,
  dismissApproval: (chatId: string) => void,
  // 跨模块依赖（打破循环：sendMessage/resumeAgent 在 index.ts 定义，用 standalone ensureStream/trackRequest）
  recoverChildChat: (chatId: string) => Promise<void>,
  resumeAgent: (chatId: string) => Promise<void>,
  pickGhostFace: (tribe: string, pets: readonly PetInstance[], selfId?: string) => string,
  allChatsCache: Ref<ChatSummary[]>,
) {
  /**
   * 路由 chunk 到对应 pet 的 StreamState（按 requestId→chatId）。
   * - stream chunk：实时增量，累积到 thinking/content（CP1/CP2 双气泡）
   * - staged chunk：历史回放（chat.get），累积到 stream.history（CP4 HistoryDrawer）
   * 后端 chat.get handler 逐消息行 emit：thinking_end → content_end → sense_end×N（顺序固定）。
   * 累积策略：thinking_end 开新 assistant item；content_end 按 role 分流；sense_end 挂当前 assistant item。
   * 未跟踪的 requestId 静默忽略。
   */
  function routeChunk(chunk: unknown): void {
    const c = chunk as ChunkMessage | null
    if (!c || !c.requestId) return
    const chatId = c.chatId ?? requestMap.get(c.requestId)
    if (!chatId) {
      console.log('[agents] routeChunk: requestId 未找到映射', {
        requestId: c.requestId,
        type: c.type,
      })
      return
    }

    const stream = ensureStream(streams, chatId)
    if (c.runId && !stream.activeRunId) stream.activeRunId = c.runId

    if (c.type === 'staged') {
      // 实时 staged（chat.send/resume 执行中，带 runId）现携预分配 msgId（= 落库 id），
      // 与 chat.get 回放（无 runId）同 id → 两者都累积进 stream.history，由 accumulateStaged
      // 既有 msgId/id 去重兜底（thinking_end 开 item / content_end 合并 / sense_end 挂卡）。
      // 执行过程中的每轮 thinking、工具调用卡逐项实时渲染，不再等整轮结束。
      accumulateStaged(stream, c.data as StagedChunkData | undefined)
      // 历史载入非工作态：不动 isWorking / pet action
      return
    }

    // stream chunk：实时增量累积
    // 普通历史回放不渲染临时气泡。只有仍在运行的 chat 才允许用回放
    // chunk 重建最后一个未结束 run；旧 run 的 done/error 会在 notification
    // 路径清掉其暂存文本，因而不会把前几轮串到当前 run。
    if (stream.replaying && !stream.replayLiveChunks) return
    const pet = pets.value.find((p) => p.chatId === chatId)
    // 看门狗终止后，网络缓冲区仍可能投递旧 stream chunk。ghost 是终态，
    // 忽略迟到增量，避免 HistoryDrawer 又显示该子 agent「输入中」。
    if (pet?.isGhost) {
      stream.isWorking = false
      stream.activeRunId = undefined
      return
    }
    const data = (c.data ?? {}) as StreamChunkData
    if (data.thinking) stream.thinking += data.thinking
    if (data.content) stream.content += data.content
    stream.isWorking = true

    setWorking(pet, true)
  }

  /**
   * 路由 notification：更新工作状态 / 审批 / 子 agent 生命周期。
   * done/error：工作态解除（+ 子 agent done 回传/注入按 wait 决策）。
   * loaded：chat.get staged 回放完成 → historyLoaded=true。
   * interrupt/accept/rejected：审批状态机（CP5 ApprovalCard 数据源）。
   * role_created/destroyed：子 pet 生命周期（CP3）。
   */
  function routeNotification(notif: unknown): void {
    const n = notif as NotificationMessage | null
    if (!n || !n.type) return
    const requestId = n.requestId
    const chatId = n.chatId ?? (requestId ? requestMap.get(requestId) : undefined)
    const type = n.type

    if (type === 'done' || type === 'error') {
      if (chatId) {
        markHistoryAncestorsDirty(chatId)
        // T9（wake 策略版）：主一律本轮 yieldTurn 停等子；子完成后端按 wake 策略推 role_reply 唤主（immediate 立即推 / deferred+barrier 静默暂存）。
        // 子 done 不再触发前端回传/注入（spawnWaits 已废）。仅清工作态（下方）。
        const stream = streams.value[chatId]
        if (stream) {
          stream.isWorking = false
          if (!n.runId || n.runId === stream.activeRunId) stream.activeRunId = undefined
          if (stream.replaying && stream.replayLiveChunks) {
            // 回放中的终态属于已完成旧 run；清掉其积累，随后 seq 更大的
            // 未结束 run 会成为刷新后应显示的当前气泡。
            stream.thinking = ''
            stream.content = ''
          }
          // 问题指示器直接由 questionBatches 派生；runningTools 只保存实时 auto sense。
          stream.runningTools = []
          // 修复：回放期间跳过 retainUntil，防止历史 done 触发气泡保留（sync 与 resume 回放都跳过终态副作用）
          if (!stream.replaying && type === 'done') stream.retainUntil = Date.now() + 20000
          // 本轮末条 assistant 权威回复 → pushHistoryItem 写 history（msgId 幂等兜底）。
          // 同 msgId 命中既有（B staged/实时）→ 就地补 content/thinking，不再内联 dedup（层②删）。
          if (type === 'done') {
            const fm = (
              n.data as
                | {
                    finalMessage?: {
                      msgId: string
                      role: 'assistant'
                      content: string
                      thinking?: string
                      createdAt: number
                      agentChatId?: string
                      contextCompaction?: boolean
                      contextCompactionTokens?: number
                    }
                  }
                | undefined
            )?.finalMessage
            if (fm) {
              pushHistoryItem(stream, {
                role: fm.role,
                content: fm.content,
                ...(fm.thinking ? { thinking: fm.thinking } : {}),
                createdAt: fm.createdAt,
                msgId: fm.msgId,
                // 反向溯源：该消息由当前 chat 生成（agentChatId = chatId）
                agentChatId: fm.agentChatId ?? chatId,
                ...(fm.contextCompaction ? { contextCompaction: true } : {}),
                ...(fm.contextCompactionTokens !== undefined
                  ? { contextCompactionTokens: fm.contextCompactionTokens }
                  : {}),
              })
            }
          }
        }
        const pet = pets.value.find((p) => p.chatId === chatId)
        // Req 7: done 后保留期内 pet 冻结不移动（freezeUntil=retainUntil）；error 立即恢复
        setWorking(pet, false, type === 'done' ? stream?.retainUntil : undefined)
        // CP7: done notification 携带 contextUsage（token/brain.contextLimit）→ 更新 pet.contextUsage（ContextBar 消费）
        // 子 agent done（finished=true）→ 转 ghost（灵魂态保留），pick 灵魂 emoji 按 tribe 序号取（selfId 排除已置 isGhost 的自身）
        if (type === 'done' && pet) {
          const d = (n.data ?? {}) as {
            contextUsage?: number
            used?: number
            total?: number
            contextBreakdown?: ContextBreakdown
            finished?: boolean
            canResume?: boolean
          }
          if (typeof d.contextUsage === 'number') pet.contextUsage = d.contextUsage
          if (typeof d.used === 'number') pet.contextUsed = d.used
          if (typeof d.total === 'number') pet.contextTotal = d.total
          if (d.contextBreakdown) pet.contextBreakdown = d.contextBreakdown
          // 统一暂停语义：done 携带权威 canResume（computeCanResume 派生），取代旧 done→false 硬编码。
          // paused（末条非 ended）→ true 显继续按钮；ended（末条 assistant 无 senseCalls）→ false 无按钮。
          if (typeof d.canResume === 'boolean') pet.canResume = d.canResume
          if (d.finished === true && !pet.isMaster) {
            // 解除 done 保留期冻结（ghost 无气泡），立即入队跟随。
            turnChildIntoGhost(pet, pets.value, pickGhostFace)
          }
        }
      }
      if (requestId) requestMap.delete(requestId)
      // CP2 → P3：错误时填 stream.error（UI 显 error-bubble），保留 console.error 供调试
      if (type === 'error' && chatId) {
        // 修复：回放期间跳过实时副作用，防止历史 error 重显 error-bubble / 覆盖 chat.list 权威 canResume（sync/resume 都跳过）
        if (streams.value[chatId]?.replaying) return
        const stream = streams.value[chatId]
        const d = (n.data ?? {}) as { message?: string; canResume?: boolean }
        const errMsg = d.message ?? '系统出了点小问题'
        if (stream) {
          stream.error = errMsg
          // error 不保留气泡（即时隐藏 content/thinking）；30s 后清 stream.error（error-bubble 自动消失）
          stream.retainUntil = Date.now() + 30000
        }
        // 统一暂停语义：AI 报错归 paused，据 notification.canResume 显继续按钮（可重试）
        const pet = pets.value.find((p) => p.chatId === chatId)
        if (pet && typeof d.canResume === 'boolean') pet.canResume = d.canResume
        console.error('[agents] stream error:', errMsg)
      }
      return
    }

    if (type === 'loaded') {
      // chat.get staged 全部 emit 完 → 标记历史载入完成（HistoryDrawer 据此显骨架→内容）
      // dirty 清：缓存可用，下次 drawer 打开零 RPC
      if (chatId) {
        const stream = streams.value[chatId]
        if (stream) {
          stream.historyLoaded = true
          stream.historyDirty = false
        }
      }
      if (requestId) requestMap.delete(requestId)
      return
    }

    if (type === 'auto_compacted') {
      // 自动压缩事件：reason=`usage`(80% 强制)/`overflow`(估算溢出)。
      // 本轮已结束，未做 prompt 改造；仅亮前端 toast 让用户感知；
      // 下次 send 自动触发。PetToolbar 也可亮 compact 按钮供手动再触一次。
      const d = (n.data ?? {}) as { reason?: string; usedBefore?: number; total?: number }
      // 修复：回放期间跳过，避免历史 auto_compacted 重弹 toast（sync/resume 都跳过）
      if (chatId && streams.value[chatId]?.replaying) return
      const reason = d.reason === 'overflow' ? '上下文溢出' : '用量阈值'
      const used = typeof d.usedBefore === 'number' ? d.usedBefore : 0
      const total = typeof d.total === 'number' && d.total > 0 ? d.total : 0
      const msg =
        total > 0
          ? `已自动压缩（约 ${used}/${total} tokens，触发：${reason}）`
          : `已自动压缩（触发：${reason}）`
      // 轻量提示：使用 element-plus ElMessage（不阻塞流）；toast 由项目的根 component 全局导入，
      // 这里走 dynamic import 避免 hot-module 副作用 → 失败时退化为 console.log。
      void import('element-plus')
        .then((mod) => {
          mod.ElMessage.info({ message: msg, duration: 2400, offset: 24 })
        })
        .catch(() => console.log(`[autoCompact] ${msg}`))
      if (requestId) requestMap.delete(requestId)
      return
    }

    if (type === 'interrupt') {
      // 感官审批请求（streamMapper sense_end → interrupt，仅 smart/manual 推送；auto sense 不推）。
      // 后端 InterruptNotificationData: {approvalId, senseName, arguments, supervisionLevel, needsApproval, waitTime, createdAt}
      // 多审批堆叠：当前 approval 已存在 → 新审批入队（不覆盖，用户可依次处理）
      const d = (n.data ?? {}) as {
        approvalId?: string
        senseName?: string
        arguments?: string
        needsApproval?: boolean
        waitTime?: number
        createdAt?: number
      }
      if (!d.approvalId || !d.senseName) {
        console.warn('[agents] interrupt: 字段残缺', d)
        return
      }
      if (chatId) {
        const stream = ensureStream(streams, chatId)
        // 不再 skip 'sync' 回放：currentState.apply 已权威 replace stream.approval/runningTools，
        // 回放期事件流继续推进（parked 子 chat 气泡/spinner 由 currentState 决定，不由事件流重设）。
        const newApproval: ApprovalState = {
          approvalId: d.approvalId,
          senseName: d.senseName,
          args: d.arguments,
          waitTime: d.waitTime ?? 0,
          createdAt: d.createdAt ?? Date.now(),
        }
        if (stream.approval) {
          stream.approvalQueue.push(newApproval)
          console.log('[agents] interrupt: 当前 approval 已在气泡展示，新审批入队', {
            chatId,
            queued: newApproval.approvalId,
            queueLen: stream.approvalQueue.length,
          })
        } else {
          stream.approval = newApproval
        }
      }
      return
    }

    if (type === 'sense_started') {
      // auto 工具开始执行（streamMapper sense_end auto 分支）。维护「运行中工具」列表，pet bar 显 icon。
      // id=sense 调用 id，accept（approvalId=id）到达时移除。
      const d = (n.data ?? {}) as { id?: string; senseName?: string }
      if (!d.id || !d.senseName) {
        console.warn('[agents] sense_started: 字段残缺', d)
        return
      }
      if (chatId) {
        const stream = ensureStream(streams, chatId)
        // 不再 skip 'sync' 回放：runningTools 由 currentState 权威给定，回放期事件流推进与快照一致即可。
        if (!stream.runningTools.some((t) => t.id === d.id)) {
          stream.runningTools.push({ id: d.id, name: d.senseName })
        }
      }
      return
    }

    if (type === 'accept' || type === 'rejected') {
      // 审批已处理（用户 accept/reject 或超时/断连触发）→ 从 approval 或 approvalQueue 按 id 移除；当前 approval 清空时自动从 queue head pop 下一个。
      // accept（approvalId=sense id）→ 移除运行中工具同 id 项；rejected 同（smart/manual 工具未入 running 栈，filter 幂等）。
      // 实时把工具结果写入对应 history senseCall（执行过程实时渲染；与 chat.get 回放 content_end role=sense 同源，
      // 旧「暂不累积，后续 content 覆盖」假设已被实时 staged 设计取代）。
      if (chatId) {
        const stream = streams.value[chatId]
        if (stream) {
          // 不再 skip 'sync' 回放：accept/rejected 按 approvalId 移除是幂等操作，回放期推进与 currentState 一致。
          const d = (n.data ?? {}) as { approvalId?: string; result?: string; reason?: string }
          const id = d.approvalId
          if (id) {
            removeApprovalById(stream, id)
            stream.runningTools = stream.runningTools.filter((t) => t.id !== id)
            if (type === 'accept' && typeof d.result === 'string') {
              fillSenseResultInHistory(stream, id, d.result)
            } else if (type === 'rejected' && typeof d.reason === 'string') {
              fillSenseResultInHistory(stream, id, `被拒绝: ${d.reason}`)
            }
          } else if (stream.approval) {
            // 没有 id 字段（旧协议兼容）→ 仍按当前 approval 处理
            stream.approval = undefined
            if (stream.approvalQueue.length > 0) {
              stream.approval = stream.approvalQueue.shift()
            }
          }
        }
      }
      return
    }

    if (type === 'question_requested' || type === 'question_answered') {
      // 旧逐题事件只用于协议兼容。chat.get/chat.sync 的权威批次快照会替换历史投影。
      return
    }

    if (type === 'question_batch_requested') {
      const data = (n.data ?? {}) as Partial<QuestionBatchPayload>
      if (
        !chatId ||
        typeof data.batchId !== 'string' ||
        typeof data.assistantMessageId !== 'string' ||
        typeof data.createdAt !== 'number' ||
        !Array.isArray(data.questions)
      ) {
        console.warn('[agents] question_batch_requested: 字段残缺', data)
        return
      }
      upsertQuestionBatch(ensureStream(streams, chatId), data as QuestionBatchPayload)
      return
    }

    if (type === 'question_batch_completed') {
      const data = (n.data ?? {}) as { batchId?: string }
      if (chatId && data.batchId) {
        const stream = streams.value[chatId]
        if (stream) removeQuestionBatch(stream, data.batchId)
      }
      return
    }

    if (type === 'role_created') {
      // 身份生命周期由 ChatSession catalog 消费并驱动 reconcilePetsFromSessions。
      // agents router 仍处理 legacy stream/interaction，但不再双写 pet 树。
      return
    }

    if (type === 'role_destroyed') {
      const d = (n.data ?? {}) as { chatId?: string }
      if (!d.chatId) {
        console.warn('[agents] role_destroyed: 缺 chatId', d)
        return
      }
      const idx = pets.value.findIndex((p) => p.chatId === d.chatId)
      if (idx >= 0) pets.value.splice(idx, 1)
      delete streams.value[d.chatId]
      return
    }

    if (type === 'child_abandoned') {
      // 看门狗超时掐断子 agent：前端据 childChatId 即时转 ghost（不等 role_reply 的 WS 投递兜底）。
      // 与 role_reply 并列：role_reply 负责主唤醒 + 历史注入；child_abandoned 仅负责 ghost 视觉。
      // 不 resume 主、不 pushHistoryItem——主由 role_reply 唤；role_reply 丢投递时主由 chat.list.resumePending 兜底。
      const d = (n.data ?? {}) as {
        parentChatId?: string
        childChatId?: string
        type?: string
        reason?: string
      }
      if (!d.childChatId) {
        console.warn('[agents] child_abandoned: 缺 childChatId', d)
        return
      }
      const childPet = pets.value.find((p) => p.chatId === d.childChatId)
      if (childPet) childPet.canResume = false
      turnChildIntoGhost(childPet, pets.value, pickGhostFace)
      // 子 stream 清工作态（与 ghost 对齐：不再 running）
      const childStream = streams.value[d.childChatId]
      if (childStream) {
        childStream.isWorking = false
        childStream.activeRunId = undefined
        childStream.retainUntil = undefined
        childStream.thinking = ''
        childStream.content = ''
      }
      return
    }

    if (type === 'role_reply') {
      // ChatSessionStore 是 role 回复、父会话续跑和 working 状态的唯一所有者。
      // 此处若再写 legacy stream 或 resume，会与 canonical run.status 竞争，并让
      // 回放边界失效；Pet 由 ChatSession 投影渲染实时 role 消息。
      return
    }

    // consumed / replaced / 其他：CP1 不处理
  }

  function markHistoryAncestorsDirty(startChatId: string): void {
    const visited = new Set<string>()
    let chatId: string | undefined = startChatId
    while (chatId && !visited.has(chatId)) {
      visited.add(chatId)
      const stream = streams.value[chatId]
      if (stream) stream.historyDirty = true
      const parentChatId = pets.value.find((pet) => pet.chatId === chatId)?.parentChatId
      chatId = parentChatId
    }
  }

  /**
   * 子 agent 诞生 → 建 pet + allChatsCache + 触发子 chat 恢复。
   * 幂等（pet 已存在即 early-return）：routeNotification 与 chatSessions.onRoleCreated
   * 双订阅下同一事件可能二次到达，故全程幂等。
   */
  function applyRoleCreated(
    data: RoleCreatedData,
    options: { recover?: boolean; working?: boolean; finished?: boolean } = {},
  ): void {
    // taskId/prompt 属于 eager launcher 的任务信息；创建可视 pet 只需要身份字段。
    // 重放或裁剪通知缺少可选任务描述时，仍必须显示子 pet。
    if (!data.chatId || !data.parentChatId || !data.type) {
      console.warn('[agents] role_created: 字段残缺', data)
      return
    }
    // 幂等：pet 已存在 = 本事件已处理过
    if (pets.value.some((p) => p.chatId === data.chatId)) return
    const master = pets.value.find((p) => p.chatId === data.parentChatId)
    if (!master) {
      console.warn('[agents] role_created: 主 pet 未找到', data.parentChatId)
      return
    }
    // Event replay is normal after reconnect: create visual state once, then
    // let the server-side task claim decide whether any child work starts.
    const bounds = defaultBounds()
    const usedFaces = new Set(pets.value.map((p) => p.face))
    const preset = applyRoleAvatar(generatePet('emoji', usedFaces), data.avatar)
    const pet = createPetInstance(preset, bounds, false, master.instanceId, {
      chatId: data.chatId,
      parentChatId: data.parentChatId,
      agentType: data.type,
      finished: options.finished,
    })
    pet.runtime = {
      brain: data.brain ?? '',
      senseGroup: data.senseGroup ?? '',
      mcpServers: [],
    }
    const pos = findSpawnPosition({ x: master.x, y: master.y }, pets.value, bounds)
    pet.x = pos.x
    pet.y = pos.y
    pet.targetX = pos.x
    pet.targetY = pos.y
    pets.value.push(pet)
    // 同步到 allChatsCache（getHistory 用它找子 chat）
    if (!allChatsCache.value.some((chat) => chat.chatId === data.chatId)) {
      allChatsCache.value.push({
        chatId: data.chatId,
        parentChatId: data.parentChatId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    }
    // 回放只恢复 pet/cache；旧 role_created 不再重复启动任务。其独立
    // chat 的恢复由启动时 chat.list 扫描承担，避免一条历史事件制造副作用。
    if (options.finished) return
    if (ensureStream(streams, data.parentChatId).replaying) return
    // 后端 eager launcher 已负责启动。这里必须对子 chat 单独 attach →
    // sync → history；不能借用父 chat 订阅，也不能再次 startSpawn。
    // 子任务由后端 eager launcher 启动。role_created 抵达即进入工作态，不能等
    // attach 或首个 stream chunk 才显示执行中的子 pet。
    const working = options.working ?? true
    ensureStream(streams, data.chatId).isWorking = working
    setWorking(pet, working)
    if (options.recover !== false) void recoverChildChat(data.chatId)
  }

  return {
    ensureStream: (chatId: string) => ensureStream(streams, chatId),
    routeChunk,
    routeNotification,
    applyRoleCreated,
    trackRequest: (requestId: string, chatId: string) =>
      trackRequest(requestMap, requestId, chatId),
  }
}
