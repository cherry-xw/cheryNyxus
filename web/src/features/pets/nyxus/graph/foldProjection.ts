import type {
  ExecutionEdge,
  ExecutionFoldMember,
  ExecutionGraph,
  ExecutionNode,
} from './executionGraph'
import { isQuestionCall, isSpawnCall } from './toolBatchDetails'

export interface FoldRange {
  id: string
  sourceChatId: string
  firstNodeId: string
  lastNodeId: string
  members: ExecutionFoldMember[]
  nodes: ExecutionNode[]
}

export interface FoldProjectionResult {
  graph: ExecutionGraph
  ranges: FoldRange[]
}

interface FoldUnit {
  id: string
  nodes: ExecutionNode[]
  displayNode: ExecutionNode
  terminal: boolean
}

const ACTIVE_RUN_STATES = new Set(['running', 'waiting', 'paused'])
const TERMINAL_RUN_STATES = new Set(['completed', 'failed'])
const TERMINAL_CALL_STATES = new Set(['completed', 'rejected', 'error'])

function compareNodes(a: ExecutionNode, b: ExecutionNode): number {
  const slots = { start: 0, persistent: 1, transient: 2 } as const
  return (
    slots[a.orderSlot] - slots[b.orderSlot] ||
    (a.orderKey ?? 0) - (b.orderKey ?? 0) ||
    a.id.localeCompare(b.id)
  )
}

function hasActiveRun(node: ExecutionNode): boolean {
  return node.activeRuns.some((run) => ACTIVE_RUN_STATES.has(run.status))
}

function runsAreTerminal(node: ExecutionNode): boolean {
  return (
    node.activeRuns.length > 0 &&
    node.activeRuns.every((run) => TERMINAL_RUN_STATES.has(run.status))
  )
}

export function isToolBatchActive(node: ExecutionNode): boolean {
  if (node.kind !== 'tool-batch' || node.status === 'revoked' || node.sourceFact?.termination) {
    return false
  }
  if (hasActiveRun(node)) return true
  if (runsAreTerminal(node)) return false
  return (node.sourceFact?.toolCalls ?? []).some(
    (call) => call.status === 'pending' || call.status === 'accepted',
  )
}

export function isToolBatchTerminal(node: ExecutionNode): boolean {
  if (node.kind !== 'tool-batch' || !node.sourceFact) return false
  if (node.status === 'revoked' || node.sourceFact.termination || runsAreTerminal(node)) return true
  if (isToolBatchActive(node)) return false
  const calls = node.sourceFact.toolCalls ?? []
  return calls.length > 0 && calls.every((call) => TERMINAL_CALL_STATES.has(call.status))
}

function isSelfAgentMessage(node: ExecutionNode): boolean {
  return (
    node.kind === 'message' &&
    node.actor.kind === 'agent' &&
    node.actor.chatId === node.sourceChatId &&
    node.direction === 'agent-to-user' &&
    !node.sourceFact?.termination
  )
}

function isFoldableBatch(node: ExecutionNode): boolean {
  return (
    node.kind === 'tool-batch' &&
    node.actor.kind === 'agent' &&
    node.actor.chatId === node.sourceChatId &&
    !!node.sourceFact &&
    !node.sourceFact.termination &&
    !(node.sourceFact.toolCalls ?? []).some(isSpawnCall) &&
    // 提问批次是不可隐藏的交互点（用户已回答），应保持为可见节点 + 多个 tab，而非折叠进过程组。
    !(node.sourceFact.toolCalls ?? []).some(isQuestionCall)
  )
}

function isFoldableNode(node: ExecutionNode): boolean {
  if (node.sourceFact?.forkAnchor) return false
  return isSelfAgentMessage(node) || isFoldableBatch(node)
}

function branchId(node: ExecutionNode): string {
  return node.sourceFact?.branchId ?? `legacy:${node.rootChatId}`
}

function branchChatKey(node: ExecutionNode): string {
  return `${branchId(node)}\u0000${node.sourceChatId}`
}

function isNodeTerminal(node: ExecutionNode): boolean {
  if (node.status === 'revoked' || node.sourceFact?.termination || runsAreTerminal(node))
    return true
  if (hasActiveRun(node)) return false
  if (node.kind === 'tool-batch') return isToolBatchTerminal(node)
  return isSelfAgentMessage(node)
}

/** A standalone reply message that closes a round — the last thing the agent
 *  says, with no tool batch after it. It stays visible instead of folding so
 *  the tree never hides the round's answer under a fold card. */
function isReplyUnit(units: readonly FoldUnit[]): boolean {
  const last = units.at(-1)
  const onlyNode = last?.nodes.length === 1 ? last.nodes[0] : undefined
  return !!onlyNode && isSelfAgentMessage(onlyNode)
}

function foldUnits(branchNodes: readonly ExecutionNode[]): Array<FoldUnit | undefined> {
  const units: Array<FoldUnit | undefined> = []
  for (let index = 0; index < branchNodes.length; index += 1) {
    const node = branchNodes[index]!
    if (!isFoldableNode(node)) {
      units.push(undefined)
      continue
    }
    const next = branchNodes[index + 1]
    if (
      isSelfAgentMessage(node) &&
      next &&
      isFoldableBatch(next) &&
      node.sourceFact?.sourceMessageId === next.sourceFact?.sourceMessageId
    ) {
      units.push({
        id: next.id,
        nodes: [node, next],
        displayNode: next,
        terminal: isNodeTerminal(node) && isNodeTerminal(next),
      })
      index += 1
      continue
    }
    units.push({ id: node.id, nodes: [node], displayNode: node, terminal: isNodeTerminal(node) })
  }
  return units
}

function toRange(
  sourceChatId: string,
  units: FoldUnit[],
  rangeNamespace = sourceChatId,
): FoldRange | undefined {
  if (units.length < 2) return undefined
  const members = units.map<ExecutionFoldMember>((unit) => ({
    id: unit.id,
    displayNode: unit.displayNode,
    nodes: unit.nodes,
  }))
  const nodes = units.flatMap((unit) => unit.nodes)
  const first = nodes[0]!
  const last = nodes.at(-1)!
  return {
    id: `fold:${rangeNamespace}:${first.id}`,
    sourceChatId,
    firstNodeId: first.id,
    lastNodeId: last.id,
    members,
    nodes,
  }
}

/**
 * Finds terminal self-produced runs independently for every Agent branch.
 * Upstream/user, return, spawn, dispatch, system and pending-interaction facts
 * are hard boundaries. A terminal prefix with at least two semantic members
 * folds without revealing it when the next node is streaming or awaiting input.
 */
export function computeFoldRanges(graph: Readonly<ExecutionGraph>): FoldRange[] {
  const branches = new Map<
    string,
    { branchId: string; sourceChatId: string; nodes: ExecutionNode[] }
  >()
  const persistentNodes = graph.nodes.filter((item) => item.orderSlot === 'persistent')
  for (const node of persistentNodes) {
    const key = branchChatKey(node)
    const branch = branches.get(key) ?? {
      branchId: branchId(node),
      sourceChatId: node.sourceChatId,
      nodes: [],
    }
    branch.nodes.push(node)
    branches.set(key, branch)
  }
  // Cross-agent facts are boundaries on both sides of the interaction. In
  // particular, a child-sourced return targeting root must split the root's
  // completed tool segment even though its sourceChatId belongs to the child.
  for (const node of persistentNodes) {
    const targetChatId = node.target?.kind === 'agent' ? node.target.chatId : undefined
    if (!targetChatId || targetChatId === node.sourceChatId || isFoldableNode(node)) continue
    const key = `${branchId(node)}\u0000${targetChatId}`
    const targetBranch = branches.get(key) ?? {
      branchId: branchId(node),
      sourceChatId: targetChatId,
      nodes: [],
    }
    if (!targetBranch.nodes.some((candidate) => candidate.id === node.id))
      targetBranch.nodes.push(node)
    branches.set(key, targetBranch)
  }

  const ranges: FoldRange[] = []
  for (const { branchId: currentBranchId, sourceChatId, nodes: branch } of branches.values()) {
    const terminalUnits: FoldUnit[] = []
    const flush = (final = false): void => {
      // The round-closing reply is the last thing the agent says; keep it out
      // of the fold so it renders as a normal message node.
      const units = final && isReplyUnit(terminalUnits) ? terminalUnits.slice(0, -1) : terminalUnits
      const range = toRange(sourceChatId, units, `${currentBranchId}:${sourceChatId}`)
      if (range) ranges.push(range)
      terminalUnits.splice(0)
    }
    for (const unit of foldUnits(branch.slice().sort(compareNodes))) {
      if (!unit) {
        flush()
        continue
      }
      if (!unit.terminal) {
        flush()
        continue
      }
      terminalUnits.push(unit)
    }
    flush(true)
  }
  return ranges.sort(
    (a, b) =>
      (a.nodes[0]?.orderKey ?? Number.MAX_SAFE_INTEGER) -
        (b.nodes[0]?.orderKey ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id),
  )
}

function foldNode(range: FoldRange, rootChatId: string): ExecutionNode {
  const first = range.nodes[0]!
  return {
    id: range.id,
    kind: 'fold',
    rootChatId,
    sourceChatId: range.sourceChatId,
    actor: first.actor,
    direction: first.direction,
    content: `${range.members.length} 个已完成节点`,
    createdAt: first.createdAt,
    status: 'transient',
    main: first.main,
    orderSlot: 'persistent',
    orderKey: first.orderKey,
    activeRuns: [],
    fold: {
      firstNodeId: range.firstNodeId,
      lastNodeId: range.lastNodeId,
      members: range.members,
      projectionNodes: range.nodes,
    },
  }
}

function projectedEdge(edge: ExecutionEdge, from: string, to: string): ExecutionEdge {
  if (from === edge.from && to === edge.to) return edge
  return { ...edge, id: `fold-edge:${edge.id}:${from}:${to}`, from, to }
}

/** A conversation round's boundary: a user-led message opens a new round. */
function isUserMessage(node: ExecutionNode): boolean {
  return node.kind === 'message' && node.actor.kind === 'user' && node.direction === 'user-to-agent'
}

/** The agent's own outbound reply message (candidate for a round's final answer). */
function isAgentReply(node: ExecutionNode): boolean {
  return (
    node.kind === 'message' && node.actor.kind === 'agent' && node.direction === 'agent-to-user'
  )
}

function toFullRange(
  round: ExecutionNode[],
  foldNodes: ExecutionNode[],
  sourceChatId = round[0]!.sourceChatId,
): FoldRange {
  const currentBranchId = branchId(round[0]!)
  const first = foldNodes[0]!
  const members = foldNodes.map<ExecutionFoldMember>((node) => ({
    id: node.id,
    displayNode: node,
    nodes: [node],
  }))
  return {
    id: `full-fold:${currentBranchId}:${sourceChatId}:${first.id}`,
    sourceChatId,
    firstNodeId: first.id,
    lastNodeId: foldNodes.at(-1)!.id,
    members,
    nodes: foldNodes,
  }
}

function hasMultipleFoldMembers(nodes: readonly ExecutionNode[]): boolean {
  return nodes.length >= 2
}

/**
 * Round-fold core: within each conversation round (user-led message → next user
 * message) keep the user messages, the round's final agent reply and branch
 * anchors; fold every other node into process cards split at those anchors (so
 * the quotient stays acyclic). Running rounds (any active run) stay expanded so
 * in-flight tool/answer state is never hidden.
 */
function computeRoundFoldRanges(graph: Readonly<ExecutionGraph>): FoldRange[] {
  const persistent = graph.nodes
    .filter((item) => item.orderSlot === 'persistent')
    .sort(compareNodes)

  const rounds: ExecutionNode[][] = []
  const byBranch = new Map<string, ExecutionNode[]>()
  for (const node of persistent) {
    const list = byBranch.get(branchId(node)) ?? []
    list.push(node)
    byBranch.set(branchId(node), list)
  }
  for (const branch of byBranch.values()) {
    let current: ExecutionNode[] = []
    for (const node of branch) {
      if (isUserMessage(node) && current.length > 0) {
        rounds.push(current)
        current = [node]
      } else current.push(node)
    }
    if (current.length > 0) rounds.push(current)
  }

  const ranges: FoldRange[] = []
  for (const round of rounds) {
    if (round.some(hasActiveRun)) continue
    const keepIds = new Set<string>()
    for (const node of round) if (isUserMessage(node)) keepIds.add(node.id)
    for (const node of round) if (node.sourceFact?.forkAnchor) keepIds.add(node.id)
    // The final agent reply is the last outbound message; keep it visible.
    const finalReply = [...round].reverse().find(isAgentReply)
    if (finalReply) keepIds.add(finalReply.id)
    // Only genuine user-led rounds fold; boundary-less leading segments stay expanded.
    if (!round.some(isUserMessage)) continue
    // Split the fold at every kept (visible) node — user input, final reply and
    // branch anchor are fold-range boundaries. A process group must never sit on
    // both sides of the same anchor, or the quotient graph gains a 2-cycle.
    let segment: ExecutionNode[] = []
    const flush = (): void => {
      if (hasMultipleFoldMembers(segment)) ranges.push(toFullRange(round, segment))
      segment = []
    }
    for (const node of round) {
      if (keepIds.has(node.id)) {
        flush()
        continue
      }
      segment.push(node)
    }
    flush()
  }
  return ranges.sort(
    (a, b) =>
      (a.nodes[0]?.orderKey ?? Number.MAX_SAFE_INTEGER) -
        (b.nodes[0]?.orderKey ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id),
  )
}

/**
 * Full fold: within each conversation round keep only the user messages, the
 * round's final agent reply and branch anchors, and fold every other node into
 * process cards split at those anchors (so the quotient stays acyclic). One
 * strategy regardless of layout — fold granularity is independent of row density.
 */
export function computeFullFoldRanges(graph: Readonly<ExecutionGraph>): FoldRange[] {
  return computeRoundFoldRanges(graph)
}

/**
 * Participant fold keeps the explicit delegation DAG visible and independently
 * folds each participant's work between dispatch, return and convergence
 * boundaries.
 */
function isParticipantBoundary(node: ExecutionNode): boolean {
  return (
    node.kind === 'dispatch' ||
    node.kind === 'spawn' ||
    node.kind === 'return' ||
    (node.kind === 'tool-batch' && (node.sourceFact?.toolCalls ?? []).some(isSpawnCall))
  )
}

export function computeParticipantFoldRanges(graph: Readonly<ExecutionGraph>): FoldRange[] {
  const persistent = graph.nodes
    .filter((item) => item.orderSlot === 'persistent')
    .sort(compareNodes)
  const rounds: ExecutionNode[][] = []
  const byBranch = new Map<string, ExecutionNode[]>()
  for (const node of persistent) {
    const list = byBranch.get(branchId(node)) ?? []
    list.push(node)
    byBranch.set(branchId(node), list)
  }
  for (const branch of byBranch.values()) {
    let current: ExecutionNode[] = []
    for (const node of branch) {
      if (isUserMessage(node) && current.length > 0) {
        rounds.push(current)
        current = [node]
      } else current.push(node)
    }
    if (current.length > 0) rounds.push(current)
  }

  const ranges: FoldRange[] = []
  for (const round of rounds) {
    if (!round.some(isUserMessage) || round.some(hasActiveRun)) continue

    const roundIds = new Set(round.map((node) => node.id))
    const roundEdges = graph.edges.filter(
      (edge) => roundIds.has(edge.from) && roundIds.has(edge.to),
    )
    const incidentChats = new Map<string, Set<string>>()
    for (const edge of roundEdges) {
      for (const nodeId of [edge.from, edge.to]) {
        const chats = incidentChats.get(nodeId) ?? new Set<string>()
        chats.add(edge.sourceChatId)
        chats.add(edge.targetChatId)
        incidentChats.set(nodeId, chats)
      }
    }
    const keepIds = new Set(
      round
        .filter(
          (node) =>
            isUserMessage(node) || isParticipantBoundary(node) || node.sourceFact?.forkAnchor,
        )
        .map((node) => node.id),
    )
    for (const edge of roundEdges) {
      if (edge.kind === 'spawn' || edge.kind === 'dispatch') {
        keepIds.add(edge.from)
        keepIds.add(edge.to)
      } else if (edge.kind === 'return-continuation') {
        keepIds.add(edge.from)
        keepIds.add(edge.to)
      }
    }
    const finalReply = [...round].reverse().find(isAgentReply)
    if (finalReply) keepIds.add(finalReply.id)

    const pendingByChat = new Map<string, ExecutionNode[]>()
    const flush = (chatId: string): void => {
      const nodes = pendingByChat.get(chatId)
      if (!nodes?.length) return
      if (!hasMultipleFoldMembers(nodes)) {
        pendingByChat.delete(chatId)
        return
      }
      const first = nodes[0]!
      ranges.push({
        id: `participant-fold:${branchId(first)}:${chatId}:${first.id}`,
        sourceChatId: chatId,
        firstNodeId: first.id,
        lastNodeId: nodes.at(-1)!.id,
        members: nodes.map((node) => ({ id: node.id, displayNode: node, nodes: [node] })),
        nodes: nodes.slice(),
      })
      pendingByChat.delete(chatId)
    }

    for (const node of round) {
      if (!keepIds.has(node.id)) {
        const pending = pendingByChat.get(node.sourceChatId) ?? []
        pending.push(node)
        pendingByChat.set(node.sourceChatId, pending)
        continue
      }

      const affectedChats = new Set<string>([node.sourceChatId])
      if (node.actor.kind === 'agent') affectedChats.add(node.actor.chatId)
      if (node.target?.kind === 'agent') affectedChats.add(node.target.chatId)
      for (const chatId of incidentChats.get(node.id) ?? []) affectedChats.add(chatId)
      for (const chatId of affectedChats) flush(chatId)
    }
    for (const chatId of pendingByChat.keys()) flush(chatId)
  }

  return ranges.sort(
    (a, b) =>
      (a.nodes[0]?.orderKey ?? Number.MAX_SAFE_INTEGER) -
        (b.nodes[0]?.orderKey ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id),
  )
}

/** Shared UI-only projection; canonical nodes, edges and their identities remain untouched. */
function projectRanges(graph: Readonly<ExecutionGraph>, ranges: FoldRange[]): FoldProjectionResult {
  if (ranges.length === 0) return { graph: graph as ExecutionGraph, ranges }

  const foldByNode = new Map<string, FoldRange>()
  for (const range of ranges) for (const node of range.nodes) foldByNode.set(node.id, range)
  const hiddenIds = new Set(foldByNode.keys())
  const nodes = graph.nodes.filter((node) => !hiddenIds.has(node.id))
  nodes.push(...ranges.map((range) => foldNode(range, graph.rootChatId)))
  const projectedEdges = graph.edges.flatMap((edge) => {
    const from = foldByNode.get(edge.from)?.id ?? edge.from
    const to = foldByNode.get(edge.to)?.id ?? edge.to
    return from === to ? [] : [projectedEdge(edge, from, to)]
  })
  const edges: ExecutionEdge[] = []
  const edgeKeys = new Set<string>()
  for (const edge of projectedEdges) {
    const key = `${edge.from}\u0000${edge.to}\u0000${edge.kind}`
    if (edgeKeys.has(key)) continue
    edgeKeys.add(key)
    edges.push(edge)
  }
  return { graph: { ...graph, nodes, edges }, ranges }
}

export function projectFoldExecutionGraph(graph: Readonly<ExecutionGraph>): FoldProjectionResult {
  return projectRanges(graph, computeFoldRanges(graph))
}

export function projectFullFoldExecutionGraph(
  graph: Readonly<ExecutionGraph>,
): FoldProjectionResult {
  return projectRanges(graph, computeFullFoldRanges(graph))
}

export function projectParticipantFoldExecutionGraph(
  graph: Readonly<ExecutionGraph>,
): FoldProjectionResult {
  return projectRanges(graph, computeParticipantFoldRanges(graph))
}
