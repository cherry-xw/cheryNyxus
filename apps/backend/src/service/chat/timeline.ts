import { createHash } from 'node:crypto'
import type {
  CanonicalMessage,
  TimelineNode,
  TimelineActor,
  ExecutionEdgeFact,
  GraphToolCall,
  TodoPlanItem,
  TodoPlanSnapshot,
  ActiveRunFact,
  RootTimelineSnapshot,
} from '../message/types.js'
import { getChat, collectDescendantsChatIds, getTimelineRevision, bumpTimelineRevision } from '@/db/chat.js'
import { getMessages, parseMessageRow, getLastMessage } from '@/db/message.js'
import { getChildReturnMessageIds, getMessageLinksForRoot, upsertMessageLink } from '@/db/messageLink.js'
import { listPendingInputs } from '@/db/pendingInput.js'
import {
  annotateExecutionNode,
  listExecutionEdges,
  listExecutionNodes,
  listLatestExecutionRuns,
  removeExecutionEdge,
  upsertExecutionEdge,
  upsertExecutionNode,
  upsertToolCallOwner,
} from '@/db/executionGraph.js'
import { getQuestionAnsweredAt } from '@/db/question.js'
import { getSpawnTaskByChild, setSpawnTaskOwnership, getRootEvents } from '@/db/delivery.js'
import { safeJsonParse } from '@/utils/json.js'
import type { RuntimeSelection } from '@/agent/runtimeResolver.js'
import { getActiveChatRunId } from './runtimeCache.js'
import { computeGenerations, generationWindowFloor } from './generations.js'
import { toTreeControlState } from './treeControl.js'
import { buildActiveTurns } from './activeTurns.js'
import { assertChatExists } from './guards.js'
import { pendingInputSnapshot } from './pendingInputs.js'
import { projectMessageRuntime } from './runtimeProvenance.js'
/** Construct the backend-owned canonical timeline projection. */
export function buildCanonicalTimeline(chatId: string): CanonicalMessage[] {
  const rows = getMessages(chatId)
  const chat = getChat(chatId)
  const parentChatId = chat?.parent_chat_id ?? undefined
  // child_return 链接的消息（wakeParent 注入的子返回/超时）-> 标 childReturn，
  // 前端 canonicalToChatMessage 据此设 mergedView=child-to-master 从主轴过滤（与 live 一致）。
  const childReturnIds = getChildReturnMessageIds(chatId)
  const senseResults = new Map<string, { content: string; revoked: boolean }>()
  for (const row of rows) {
    if (row.role === 'sense') {
      senseResults.set(row.id, { content: row.content ?? '', revoked: row.revoked === 1 })
    }
  }
  let lastRuntime: RuntimeSelection | undefined
  // sense 行是工具执行结果，已通过上方 senseResults 并入所属 assistant 的 senseCalls（按 call.id 匹配）；
  // 不作为独立 CanonicalMessage 输出，否则前端 canonicalToChatMessage 会把 sense→assistant，
  // 把工具结果渲染成一条主 agent 气泡。与 buildRootTimeline conversation 视图（L541 if sense -> continue）一致。
  const visibleRows = rows.filter((row) => row.role !== 'sense')
  return visibleRows.map((row) => {
    const parsed = parseMessageRow(row)
    const projection = projectMessageRuntime(parsed.role, parsed.runtime, lastRuntime)
    lastRuntime = projection.next
    const runtime = projection.current
    const senseCalls = (parsed.senseCall ?? []).map((call) => {
      const result = senseResults.get(call.id)
      return {
        ...call,
        ...(result && result.content ? { result: result.content } : {}),
        status: result?.revoked
          ? ('rejected' as const)
          : result?.content
            ? ('accepted' as const)
            : ('pending' as const),
      }
    })
    const origin = parentChatId ? { parentChatId, childChatId: chatId } : undefined
    return {
      id: row.id,
      chatId,
      role:
        parsed.role === 'subagent'
          ? 'role'
          : parsed.role === 'system'
            ? 'role'
            : (parsed.role as CanonicalMessage['role']),
      content: parsed.content ?? '',
      ...(parsed.thinking ? { thinking: parsed.thinking } : {}),
      createdAt: row.created_at,
      updatedAt: row.created_at,
      status: row.revoked === 1 ? 'revoked' : 'committed',
      ...(runtime ? { runtime } : {}),
      ...(senseCalls.length > 0 ? { senseCalls } : {}),
      ...(origin ? { origin } : {}),
      ...(childReturnIds.has(row.id) ? { childReturn: true } : {}),
    }
  })
}

/**
 * 位置型消息关系：由消息所在会话与 root 的拓扑唯一决定（懒回填按拓扑推导的这一类）。
 * 与之相对的显式关系（child_return/system/tool_result）由 wake 等写路径带语义写入，
 * 拓扑推导无法代替，自愈逻辑不得重写它们。
 */
const POSITIONAL_LINK_RELATIONS = new Set([
  'root_input',
  'child_input',
  'agent_output',
  'child_output',
])

type Candidate = {
  node: Omit<TimelineNode, 'orderKey'>
  branchChatId: string
  rank: number
  relation: string
}

function repairTimelineLinks(rootChatId: string) {
  const chatIds = [rootChatId, ...collectDescendantsChatIds(rootChatId)]
  const persistedLinks = new Map(
    getMessageLinksForRoot(rootChatId).map((link) => [link.messageId, link]),
  )
  const existingLinkIds = new Set(persistedLinks.keys())
  // Lazy backfill makes pre-V2 conversations progressively auditable without
  // a destructive one-shot migration. Ambiguous parent role rows are left
  // unlinked so the projector can apply its conservative matcher below.
  let linksRepaired = false
  for (const chatId of chatIds) {
    const child = chatId !== rootChatId
    for (const row of getMessages(chatId)) {
      if (!child && row.role === 'role') continue
      if (!existingLinkIds.has(row.id)) {
        upsertMessageLink(row.id, chatId, {
          relation: child
            ? row.role === 'user'
              ? 'child_input'
              : 'child_output'
            : row.role === 'user'
              ? 'root_input'
              : row.role === 'sense'
                ? 'tool_result'
                : 'agent_output',
        })
        existingLinkIds.add(row.id)
        continue
      }
      // 自愈历史脏数据：位置型 relation 必须与消息所在会话的拓扑一致（root 会话只能是
      // root_input/agent_output，子会话只能是 child_input/child_output）。历史版本曾把
      // 子会话首条指令误写成 root_input，投影成主轴用户消息后前端持续报
      // illegal-user-child-input，且重新同步无法消除（懒回填只补缺失、不修错误）。
      // 仅重写四个位置型关系；child_return/system/tool_result 由显式写路径负责，不在此触碰。
      const persisted = persistedLinks.get(row.id)
      if (!persisted || (row.role !== 'user' && row.role !== 'assistant')) continue
      const expected = child
        ? row.role === 'user'
          ? 'child_input'
          : 'child_output'
        : row.role === 'user'
          ? 'root_input'
          : 'agent_output'
      if (persisted.relation !== expected && POSITIONAL_LINK_RELATIONS.has(persisted.relation)) {
        // 原行展开重写：upsert 是全字段覆盖，必须保留已有语义字段（防御未来写路径
        // 在位置型关系上补充 spawn 关联时不被自愈清空）。
        upsertMessageLink(row.id, chatId, { ...persisted, relation: expected })
        persistedLinks.set(row.id, { ...persisted, relation: expected })
        linksRepaired = true
      }
    }
  }
  const links = new Map(getMessageLinksForRoot(rootChatId).map((link) => [link.messageId, link]))
  return { chatIds, links, linksRepaired }
}

function prepareTimelineInputs(rootChatId: string, chatIds: string[]) {
  const chatMeta = new Map<string, { type?: string; parent?: string; spawnCallId?: string }>()
  const childByType = new Map<string, string[]>()
  const childBySpawnCall = new Map<string, string[]>()
  const messagesByChat = new Map(chatIds.map((chatId) => [chatId, getMessages(chatId)]))
  const runtimeByMessageId = new Map<string, RuntimeSelection>()
  for (const chatId of chatIds) {
    const chat = getChat(chatId)
    const metadata = chat?.metadata
      ? (safeJsonParse(chat.metadata, {}) as Record<string, unknown>)
      : {}
    chatMeta.set(chatId, {
      type: typeof metadata.type === 'string' ? metadata.type : undefined,
      parent: chat?.parent_chat_id ?? undefined,
      spawnCallId:
        typeof metadata.spawnSenseCallId === 'string' ? metadata.spawnSenseCallId : undefined,
    })
    if (chatId !== rootChatId) {
      const type = chatMeta.get(chatId)?.type
      if (type) childByType.set(type, [...(childByType.get(type) ?? []), chatId])
      const spawnCallId = chatMeta.get(chatId)?.spawnCallId
      if (spawnCallId) {
        childBySpawnCall.set(spawnCallId, [...(childBySpawnCall.get(spawnCallId) ?? []), chatId])
      }
    }
    let lastUserRuntime: RuntimeSelection | undefined
    for (const row of messagesByChat.get(chatId) ?? []) {
      const parsed = parseMessageRow(row)
      const projection = projectMessageRuntime(parsed.role, parsed.runtime, lastUserRuntime)
      lastUserRuntime = projection.next
      const runtime = projection.current
      if (runtime) runtimeByMessageId.set(row.id, runtime)
    }
  }
  const actorForAgent = (chatId: string): TimelineActor => ({
    kind: 'agent',
    chatId,
    ...(chatMeta.get(chatId)?.type ? { roleType: chatMeta.get(chatId)!.type } : {}),
  })

  return {
    chatMeta,
    childByType,
    childBySpawnCall,
    messagesByChat,
    runtimeByMessageId,
    actorForAgent,
  }
}

function buildTimelineCandidates(
  rootChatId: string,
  chatIds: string[],
  links: ReturnType<typeof repairTimelineLinks>['links'],
  inputs: ReturnType<typeof prepareTimelineInputs>,
): Candidate[] {
  const {
    chatMeta,
    childByType,
    childBySpawnCall,
    messagesByChat,
    runtimeByMessageId,
    actorForAgent,
  } = inputs
  const candidates: Candidate[] = []
  for (const chatId of chatIds) {
    const rows = messagesByChat.get(chatId) ?? []
    const child = chatId !== rootChatId
    for (const row of rows) {
      let link = links.get(row.id)
      const parsed = parseMessageRow(row)
      // Legacy role rows predate message_links. Recover an unambiguous
      // child-return association from the persisted role type prefix and the
      // child terminal content; ambiguous records remain unknown.
      if (!link && !child && row.role === 'role' && typeof row.content === 'string') {
        const match = /^\[角色\s+([^\]]+)\]\s*(.*)$/s.exec(row.content)
        const candidates = match ? (childByType.get(match[1]!) ?? []) : []
        const matched = candidates.filter((candidate) => {
          const last = getLastMessage(candidate)
          return !!last && (last.content ?? '') === (match?.[2] ?? '')
        })
        if (matched.length === 1) {
          const candidate = matched[0]!
          link = {
            messageId: row.id,
            rootChatId,
            sourceChatId: candidate,
            parentChatId: rootChatId,
            relation: 'child_return',
            relatedMessageId: getLastMessage(candidate)?.id,
            createdAt: row.created_at,
          }
        }
      }
      const runtime =
        runtimeByMessageId.get(row.id) ??
        (link?.relation === 'child_return' && link.relatedMessageId
          ? runtimeByMessageId.get(link.relatedMessageId)
          : undefined)
      const relation =
        link?.relation ??
        (child
          ? row.role === 'user'
            ? 'child_input'
            : 'child_output'
          : row.role === 'user'
            ? 'root_input'
            : 'agent_output')
      if (row.role === 'sense') continue
      let actor: TimelineActor
      let target: TimelineActor | undefined
      let direction: TimelineNode['direction']
      let kind: TimelineNode['kind'] = 'message'
      if (relation === 'root_input') {
        actor = { kind: 'user', actorId: 'human' }
        target = actorForAgent(rootChatId)
        direction = 'user-to-agent'
      } else if (relation === 'system') {
        actor = { kind: 'system' }
        target = actorForAgent(rootChatId)
        direction = 'internal'
        kind = 'system'
      } else if (relation === 'child_input') {
        actor = actorForAgent(chatMeta.get(chatId)?.parent ?? rootChatId)
        target = actorForAgent(chatId)
        direction = 'parent-to-child'
      } else if (relation === 'child_return') {
        actor = actorForAgent(link?.sourceChatId ?? chatId)
        target = actorForAgent(link?.parentChatId ?? rootChatId)
        direction = 'child-to-parent'
        kind = 'return'
      } else if (child) {
        actor = actorForAgent(chatId)
        target = actorForAgent(chatMeta.get(chatId)?.parent ?? rootChatId)
        direction = 'agent-to-user'
      } else {
        actor = actorForAgent(rootChatId)
        direction = 'agent-to-user'
      }
      const senseCalls: GraphToolCall[] = (parsed.senseCall ?? [])
        .map((call, fallbackIndex) => {
          const result = rows.find((candidate) => candidate.id === call.id)
          const childMatches = childBySpawnCall.get(call.id) ?? []
          return {
            callId: call.id,
            index: call.index ?? fallbackIndex,
            name: call.name ?? '',
            arguments: call.arguments,
            ...(result ? { result: result.content ?? '' } : {}),
            ...(childMatches.length === 1 ? { childChatId: childMatches[0] } : {}),
            ...(call.security ? { security: call.security } : {}),
            status:
              result?.revoked || result?.content?.startsWith('被拒绝:')
                ? ('rejected' as const)
                : result?.content?.startsWith('感官执行失败：')
                  ? ('error' as const)
                  : result
                    ? ('completed' as const)
                    : ('pending' as const),
          }
        })
        .sort((a, b) => a.index - b.index || a.callId.localeCompare(b.callId))
      const node: Omit<TimelineNode, 'orderKey'> = {
        id: row.id,
        rootChatId,
        sourceChatId: relation === 'child_return' ? (link?.sourceChatId ?? chatId) : chatId,
        sourceMessageId: row.id,
        kind,
        actor,
        ...(target ? { target } : {}),
        direction,
        visibility: 'conversation',
        content: parsed.content ?? '',
        ...(parsed.thinking ? { thinking: parsed.thinking } : {}),
        ...(runtime ? { runtime } : {}),
        ...(senseCalls.length > 0 ? { toolCalls: senseCalls } : {}),
        createdAt: row.created_at,
        updatedAt: row.created_at,
        status: row.revoked === 1 ? 'revoked' : 'committed',
        ...(row.epoch_id ? { epochId: row.epoch_id } : {}),
      }
      candidates.push({ node, branchChatId: chatId, rank: 0, relation })
      if (senseCalls.length > 0) {
        // 提问类工具（ask_user_question）：工具执行本身是「占位秒回」，真实等待发生在
        // 提问 → 回答之间。把回答时间（question_items.answered_at）带到工具节点，
        // 前端据此展示真实等待耗时。多题批次的题目同步落同一个 completedAt，取首个命中。
        const answeredAt = senseCalls.some((call) => call.name === 'ask_user_question')
          ? (() => {
              for (const call of senseCalls) {
                if (call.name !== 'ask_user_question') continue
                const at = getQuestionAnsweredAt(chatId, call.callId)
                if (at !== undefined) return at
              }
              return undefined
            })()
          : undefined
        candidates.push({
          node: {
            id: `batch:${row.id}`,
            rootChatId,
            sourceChatId: chatId,
            sourceMessageId: row.id,
            kind: 'tool-batch',
            actor,
            ...(target ? { target } : {}),
            direction: 'internal',
            visibility: 'detail',
            content: '',
            toolCalls: senseCalls,
            batchId: `batch:${row.id}`,
            createdAt: row.created_at,
            updatedAt: row.created_at,
            ...(answeredAt !== undefined ? { answeredAt } : {}),
            status: row.revoked === 1 ? 'revoked' : 'committed',
            ...(row.epoch_id ? { epochId: row.epoch_id } : {}),
          },
          branchChatId: chatId,
          rank: 1,
          relation: 'tool_batch',
        })
      }
    }
  }

  candidates.sort(
    (a, b) =>
      a.node.createdAt - b.node.createdAt ||
      a.node.sourceMessageId!.localeCompare(b.node.sourceMessageId!) ||
      a.rank - b.rank,
  )

  return candidates
}

function applyTimelineTodoPlans(candidates: Candidate[]): void {
  // update_todo 的入参不要求模型提供 ID。这里在 canonical timeline 的唯一重建入口
  // 生成确定性身份：同一 callId 产生同一 planId，同一 Agent 下相同内容的任务项保持
  // 同一 itemId。计划按 sourceChatId 隔离，避免主/子 Agent 的清单互相覆盖。
  const digest = (value: string): string =>
    createHash('sha256').update(value).digest('hex').slice(0, 20)
  const todoPlanFromCall = (
    sourceChatId: string,
    call: GraphToolCall,
  ): TodoPlanSnapshot | undefined => {
    if (call.name !== 'update_todo') return undefined
    let parsed: unknown
    try {
      parsed = JSON.parse(call.arguments)
    } catch {
      return undefined
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !Array.isArray((parsed as { todos?: unknown }).todos)
    ) {
      return undefined
    }
    const occurrenceByContent = new Map<string, number>()
    const items: TodoPlanItem[] = []
    for (const [index, raw] of (parsed as { todos: unknown[] }).todos.entries()) {
      if (!raw || typeof raw !== 'object') continue
      const item = raw as { content?: unknown; status?: unknown; activeForm?: unknown }
      if (
        typeof item.content !== 'string' ||
        (item.status !== 'pending' && item.status !== 'in_progress' && item.status !== 'completed')
      ) {
        continue
      }
      const occurrence = occurrenceByContent.get(item.content) ?? 0
      occurrenceByContent.set(item.content, occurrence + 1)
      items.push({
        itemId: digest(`${sourceChatId}:todo-item:${item.content}:${occurrence}`),
        index,
        content: item.content,
        status: item.status,
        ...(typeof item.activeForm === 'string' ? { activeForm: item.activeForm } : {}),
      })
    }
    const planId = digest(`${sourceChatId}:todo-plan:${call.callId}`)
    const currentItemId = items.find((item) => item.status === 'in_progress')?.itemId
    return { planId, items, ...(currentItemId ? { currentItemId } : {}) }
  }

  for (const candidate of candidates) {
    const sourceChatId = candidate.node.sourceChatId
    let nodePlan: TodoPlanSnapshot | undefined
    for (const call of candidate.node.toolCalls ?? []) {
      const plan = todoPlanFromCall(sourceChatId, call)
      if (!plan) continue
      nodePlan = plan
      const current = plan.items.find((item) => item.itemId === plan.currentItemId)
      call.todoPlan = {
        planId: plan.planId,
        ...(current ? { itemId: current.itemId, index: current.index } : {}),
      }
    }
    // 计划快照只挂在产生 update_todo 的消息/工具批次上。后续普通响应
    // 仍属于同一执行过程，但不能冒充任务计划的锚点。显式写入 undefined
    // 也用于清除上一版错误地遗留在普通响应节点上的旧归属。
    candidate.node.todoPlan = nodePlan
  }
}

function persistTimelineCandidates(
  rootChatId: string,
  candidates: Candidate[],
  links: ReturnType<typeof repairTimelineLinks>['links'],
  linksRepaired: boolean,
) {
  const persistedById = new Map<string, TimelineNode>()
  // 回填改图检测：懒回填（spawn 边/return-continuation 等）不经消息写路径，不会自然推进
  // timeline_revision。图变更必须 bump（见返回前），否则客户端同 revision 丢弃增量 patch，
  // knownRevision 短路会冻结残缺快照（不变量：图变更 ⇒ revision 前进）。
  const nodeIdsBefore = new Set(listExecutionNodes(rootChatId).map((node) => node.id))
  const nodesBeforeById = new Map(listExecutionNodes(rootChatId).map((node) => [node.id, node]))
  // link 自愈同样属于图变更（改变节点 actor/direction/sourceChatId 投影），
  // 而 upsert 变更检测只比对 todoPlan/toolCalls，必须在此并入。
  let graphMutated = linksRepaired
  for (const candidate of candidates) {
    const persisted = upsertExecutionNode(candidate.node) as unknown as TimelineNode
    if (
      !nodeIdsBefore.has(persisted.id) ||
      JSON.stringify(nodesBeforeById.get(persisted.id)?.todoPlan) !==
        JSON.stringify(persisted.todoPlan) ||
      JSON.stringify(nodesBeforeById.get(persisted.id)?.toolCalls) !==
        JSON.stringify(persisted.toolCalls)
    ) {
      graphMutated = true
    }
    persistedById.set(persisted.id, persisted)
    if (persisted.kind === 'tool-batch') {
      for (const call of persisted.toolCalls ?? []) {
        upsertToolCallOwner({
          callId: call.callId,
          rootChatId,
          owningNodeId: persisted.id,
          batchId: persisted.batchId,
          index: call.index,
          resolution: 'owned',
        })
      }
    }
  }

  // Mark unresolved legacy IDs explicitly. A task id and a call id are not the
  // same identity space, so no edge is fabricated when ownership is unknown.
  for (const link of links.values()) {
    const legacyCallId = link.spawnCallId ?? link.spawnId
    if (!legacyCallId || persistedById.has(legacyCallId)) continue
    const owned = candidates.some((candidate) =>
      candidate.node.toolCalls?.some((call) => call.callId === legacyCallId),
    )
    if (!owned) {
      upsertToolCallOwner({
        callId: legacyCallId,
        rootChatId,
        resolution: 'unknown',
        detail: 'legacy spawn id has no unique owning tool batch',
      })
    }
  }

  return { persistedById, graphMutated }
}

function rebuildTimelineEdges(
  rootChatId: string,
  candidates: Candidate[],
  persistedById: Map<string, TimelineNode>,
  links: ReturnType<typeof repairTimelineLinks>['links'],
  graphMutated: boolean,
): boolean {
  const branchCandidates = new Map<string, Candidate[]>()
  for (const candidate of candidates) {
    const list = branchCandidates.get(candidate.branchChatId) ?? []
    list.push(candidate)
    branchCandidates.set(candidate.branchChatId, list)
  }
  const storedNodesBeforeEdges = listExecutionNodes(rootChatId) as unknown as Array<
    TimelineNode & { targetChatId?: string; callId?: string }
  >
  const storedNodeById = new Map(storedNodesBeforeEdges.map((node) => [node.id, node]))
  const existingEdgesBefore = listExecutionEdges(rootChatId) as unknown as ExecutionEdgeFact[]
  const edgeInputs: Array<Omit<ExecutionEdgeFact, 'orderKey'>> = []
  const addEdge = (
    kind: ExecutionEdgeFact['kind'],
    fromNodeId: string,
    toNodeId: string,
    sourceChatId: string,
    targetChatId: string,
    callId?: string,
  ): void => {
    if (fromNodeId === toNodeId) return
    edgeInputs.push({
      id: `edge:${kind}:${fromNodeId}:${toNodeId}`,
      rootChatId,
      fromNodeId,
      toNodeId,
      kind,
      sourceChatId,
      targetChatId,
      ...(callId ? { callId } : {}),
    })
  }

  for (const [branchChatId, branch] of branchCandidates) {
    branch.sort(
      (a, b) => persistedById.get(a.node.id)!.orderKey - persistedById.get(b.node.id)!.orderKey,
    )
    // Return nodes describe cross-branch delivery. They are not turns on the
    // parent's ordinary sequence, otherwise sibling returns become chained and
    // a spawn batch can "continue" into a child return instead of its parent.
    const sequenceBranch = branch.filter(
      (candidate) => persistedById.get(candidate.node.id)!.kind !== 'return',
    )
    for (let index = 1; index < sequenceBranch.length; index += 1) {
      const previous = persistedById.get(sequenceBranch[index - 1]!.node.id)!
      const current = persistedById.get(sequenceBranch[index]!.node.id)!
      const spawnBatch =
        previous.kind === 'tool-batch' &&
        previous.toolCalls?.some((call) => typeof call.childChatId === 'string')
      addEdge(
        spawnBatch ? 'continue' : 'sequence',
        previous.id,
        current.id,
        branchChatId,
        branchChatId,
      )
    }
  }

  for (const candidate of candidates) {
    const node = persistedById.get(candidate.node.id)!
    if (node.kind === 'tool-batch') {
      for (const call of node.toolCalls ?? []) {
        if (!call.childChatId) continue
        if (
          existingEdgesBefore.some(
            (edge) =>
              edge.kind === 'spawn' && edge.fromNodeId === node.id && edge.callId === call.callId,
          )
        )
          continue
        const spawnTarget = storedNodesBeforeEdges.find(
          (stored) =>
            stored.id.startsWith('spawn-target:') &&
            stored.targetChatId === call.childChatId &&
            stored.callId === call.callId,
        )
        const firstChild = (branchCandidates.get(call.childChatId) ?? []).find(
          (childCandidate) => persistedById.get(childCandidate.node.id)!.kind !== 'return',
        )
        const targetNodeId = spawnTarget?.id ?? firstChild?.node.id
        if (targetNodeId) {
          addEdge(
            'spawn',
            node.id,
            targetNodeId,
            candidate.branchChatId,
            call.childChatId,
            call.callId,
          )
          const task = getSpawnTaskByChild(call.childChatId)
          if (task) setSpawnTaskOwnership(task.taskId, call.callId, node.id)
        }
      }
    }
    if (node.kind === 'return') {
      const link = node.sourceMessageId ? links.get(node.sourceMessageId) : undefined
      const childBranch = branchCandidates.get(node.sourceChatId) ?? []
      const explicit = link?.causationNodeId
        ? storedNodeById.get(link.causationNodeId)
        : link?.relatedMessageId
          ? persistedById.get(link.relatedMessageId)
          : undefined
      const childTerminal =
        explicit ??
        childBranch
          .map((item) => persistedById.get(item.node.id)!)
          .filter(
            (item) =>
              item.orderKey < node.orderKey && item.kind !== 'tool-batch' && item.kind !== 'return',
          )
          .at(-1)
      if (childTerminal) {
        addEdge('return', childTerminal.id, node.id, node.sourceChatId, candidate.branchChatId)
      }
      const parentBranch = branchCandidates.get(candidate.branchChatId) ?? []
      const continuation = parentBranch
        .map((item) => persistedById.get(item.node.id)!)
        .find((item) => item.orderKey > node.orderKey && item.kind !== 'return')
      if (continuation) {
        addEdge(
          'return-continuation',
          node.id,
          continuation.id,
          node.sourceChatId,
          candidate.branchChatId,
        )
      }
    }
  }
  for (const spawnTarget of storedNodesBeforeEdges) {
    if (!spawnTarget.id.startsWith('spawn-target:') || !spawnTarget.targetChatId) continue
    const firstChild = (branchCandidates.get(spawnTarget.targetChatId) ?? []).find(
      (candidate) => persistedById.get(candidate.node.id)!.kind !== 'return',
    )
    if (firstChild) {
      addEdge(
        'sequence',
        spawnTarget.id,
        firstChild.node.id,
        spawnTarget.sourceChatId,
        spawnTarget.targetChatId,
      )
    }
  }
  const desiredGeneratedEdgeIds = new Set(edgeInputs.map((edge) => edge.id))
  const regeneratedKinds = new Set<ExecutionEdgeFact['kind']>([
    'sequence',
    'continue',
    'return',
    'return-continuation',
  ])
  for (const edge of existingEdgesBefore) {
    const generatedId = `edge:${edge.kind}:${edge.fromNodeId}:${edge.toNodeId}`
    if (
      regeneratedKinds.has(edge.kind) &&
      edge.id === generatedId &&
      !desiredGeneratedEdgeIds.has(edge.id)
    ) {
      if (removeExecutionEdge(edge.id)) graphMutated = true
    }
  }
  const edgeIdsBefore = new Set(existingEdgesBefore.map((edge) => edge.id))
  for (const edge of edgeInputs) {
    const persistedEdge = upsertExecutionEdge(edge)
    if (!edgeIdsBefore.has(persistedEdge.id)) graphMutated = true
  }

  if (syncReturnCausation(candidates, persistedById, links, edgeInputs)) graphMutated = true
  return graphMutated
}

function syncReturnCausation(
  candidates: Candidate[],
  persistedById: Map<string, TimelineNode>,
  links: ReturnType<typeof repairTimelineLinks>['links'],
  edgeInputs: Array<Omit<ExecutionEdgeFact, 'orderKey'>>,
): boolean {
  // 已建成 return 边的节点剥除冗余 causationId；未解析的旧关系保留供诊断。
  const returnTargetIds = new Set(
    edgeInputs.filter((edge) => edge.kind === 'return').map((edge) => edge.toNodeId),
  )
  let graphMutated = false
  for (const candidate of candidates) {
    const node = persistedById.get(candidate.node.id)
    if (!node || node.kind !== 'return') continue
    const link = node.sourceMessageId ? links.get(node.sourceMessageId) : undefined
    const causationNodeId = link?.causationNodeId
    if (returnTargetIds.has(node.id)) {
      if (node.causationId) {
        annotateExecutionNode(node.id, { causationId: undefined })
        graphMutated = true
      }
    } else if (causationNodeId && !node.causationId) {
      annotateExecutionNode(node.id, { causationId: causationNodeId })
      graphMutated = true
    }
  }

  return graphMutated
}

/**
 * Build the root-owned multi-agent projection. Raw messages remain in their
 * own chat; this function is the only place that assigns actor/direction and
 * hides standalone tool-result rows from the conversation view.
 */
export function buildRootTimeline(
  rootChatId: string,
  view: 'conversation' | 'tree' | 'audit' = 'conversation',
): RootTimelineSnapshot {
  assertChatExists(rootChatId)
  const { chatIds, links, linksRepaired } = repairTimelineLinks(rootChatId)
  const inputs = prepareTimelineInputs(rootChatId, chatIds)
  const candidates = buildTimelineCandidates(rootChatId, chatIds, links, inputs)

  applyTimelineTodoPlans(candidates)

  const persisted = persistTimelineCandidates(rootChatId, candidates, links, linksRepaired)
  const { persistedById } = persisted
  let { graphMutated } = persisted
  graphMutated = rebuildTimelineEdges(rootChatId, candidates, persistedById, links, graphMutated)

  const allNodes = listExecutionNodes(rootChatId) as unknown as TimelineNode[]
  const allEdges = listExecutionEdges(rootChatId) as unknown as ExecutionEdgeFact[]
  // 代际窗口：默认完整展示两代（当前代 + 上一代），更早代由前端按 generations 索引
  // 经 chat.timeline.generation.get 按需拉取。窗口过滤只影响返回的 snapshot，
  // 持久层（execution_nodes/execution_edges）与上方全量重建/回填逻辑不受影响。
  const generations = computeGenerations(rootChatId)
  const windowFloor = generationWindowFloor(generations)
  const nodes = windowFloor > 0 ? allNodes.filter((node) => node.orderKey > windowFloor) : allNodes
  const knownNodeIds = new Set(nodes.map((node) => node.id))
  const edges = allEdges.filter(
    (edge) => knownNodeIds.has(edge.fromNodeId) && knownNodeIds.has(edge.toNodeId),
  )
  const pendingInputs = chatIds.flatMap((chatId) =>
    listPendingInputs(chatId).map((entry) => pendingInputSnapshot(entry, chatId)),
  )
  const durableRuns = new Map(
    listLatestExecutionRuns(rootChatId)
      .filter((run) => chatIds.includes(run.chatId))
      .map((run) => [run.chatId, run]),
  )
  const liveRuns: ActiveRunFact[] = chatIds.flatMap((chatId) => {
    const runId = getActiveChatRunId(chatId)
    if (!runId) return []
    const turn = buildActiveTurns(chatId).find((candidate) => candidate.runId === runId)
    const nodeId = turn && persistedById.has(turn.messageId) ? turn.messageId : undefined
    const batchId = nodeId && persistedById.has(`batch:${nodeId}`) ? `batch:${nodeId}` : undefined
    return [
      {
        rootChatId,
        chatId,
        runId,
        status: 'running' as const,
        ...(turn ? { turnId: turn.turnId } : {}),
        ...(nodeId ? { nodeId } : {}),
        ...(batchId ? { batchId } : {}),
      },
    ]
  })
  for (const run of liveRuns) durableRuns.set(run.chatId, run)
  const activeRuns: ActiveRunFact[] = [...durableRuns.values()]
  const eventSeq = getRootEvents(rootChatId, Number.MAX_SAFE_INTEGER).latestSeq
  const controlState = toTreeControlState(rootChatId)
  // 本次 rebuild 实际改图（插入节点/边或删除边）：bump 必须先于下方 revision 读取，
  // 使 snapshot/patch 携带新 revision，客户端丢增量后可经全量拉取自愈。
  if (graphMutated) bumpTimelineRevision(rootChatId)
  return {
    rootChatId,
    view,
    revision: getTimelineRevision(rootChatId),
    nodes,
    edges,
    activeRuns,
    pendingInputs,
    generations,
    ...(controlState ? { controlState } : {}),
    capturedEventSeq: eventSeq,
  }
}
