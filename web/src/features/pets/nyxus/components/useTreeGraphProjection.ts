import { computed, ref, watch } from 'vue'
import { effectiveRootLiveState } from '@/application/chat/public'
import { pendingInputAnchor, pendingInputPhase } from '../composables/mainInputState'
import {
  projectPersistentExecutionGraph,
  projectInputNodes,
  projectActiveTurnNodes,
  type ExecutionNode,
  type VirtualInputNode,
} from '../graph/executionGraph'
import {
  projectFoldExecutionGraph,
  projectRoundExecutionGraph,
  projectParticipantFoldExecutionGraph,
} from '../graph/foldProjection'
import { projectCoreFlowExecutionGraph } from '../graph/coreFlowProjection'
import { effectiveRunFacts } from '../graph/crtModel'
import { buildPaperStack } from '../paper/paperStackModel'
import type { MessageBranchTreeControllerProps } from './treeControllerTypes'
import type { useNyxusHost } from '../application/host'

/** Canonical, live and folded graph projection plus the paper reading cursor. */
export function useTreeGraphProjection(
  props: MessageBranchTreeControllerProps,
  chatSessions: ReturnType<typeof useNyxusHost>['chats'],
  nodeTitle: (node: ExecutionNode) => string,
  closeNodeDetail: () => void,
) {
  const timelineSnapshot = computed(
    () => props.timelineOverride ?? chatSessions.rootTimeline(props.rootChatId, 'tree'),
  )
  const timelineNodes = computed(() => timelineSnapshot.value?.nodes ?? [])
  const rootTransientState = computed(() => chatSessions.rootTimelineStates[props.rootChatId])
  const liveState = computed(() =>
    props.staticView
      ? { activeTurns: [], activeRuns: [] }
      : effectiveRootLiveState(
          props.rootChatId,
          rootTransientState.value,
          chatSessions.sessionsById,
        ),
  )
  let cachedActiveRunKey = ''
  let cachedActiveCrtRuns: ReturnType<typeof effectiveRunFacts> = []
  const activeCrtRuns = computed(() => {
    // Token deltas change turn content but not run topology. Keep the durable
    // projection graph from rebuilding until run IDs/statuses actually change.
    const canonicalRuns = timelineSnapshot.value?.activeRuns ?? []
    const key = [
      props.rootChatId,
      ...canonicalRuns.map((run) => `${run.chatId ?? ''}:${run.runId ?? ''}:${run.status ?? ''}`),
      ...liveState.value.activeRuns.map(
        (run) => `${run.chatId ?? ''}:${run.runId ?? ''}:${run.status ?? run.state ?? ''}`,
      ),
      ...liveState.value.activeTurns.map(
        (turn) => `${turn.chatId ?? ''}:${turn.runId ?? ''}:${turn.turnId}:${turn.status}`,
      ),
    ].join('\u0001')
    if (key === cachedActiveRunKey) return cachedActiveCrtRuns
    cachedActiveRunKey = key
    cachedActiveCrtRuns = effectiveRunFacts(
      props.rootChatId,
      canonicalRuns,
      liveState.value.activeRuns,
      liveState.value.activeTurns,
    )
    return cachedActiveCrtRuns
  })
  const pendingInputs = computed<VirtualInputNode[]>(() => {
    if (props.staticView) return []
    const rootState = rootTransientState.value
    const latest = Math.max(0, ...timelineNodes.value.map((node) => node.createdAt))
    return (rootState?.pendingInputs ?? [])
      .filter((input) => !input.chatId || input.chatId === props.rootChatId)
      .filter((input) => input.state !== 'cancelled' && input.state !== 'rejected')
      .map((input, index) => ({
        id: pendingInputAnchor(input),
        content: input.content,
        createdAt: input.acceptedAt ?? latest + index + 1,
        state: pendingInputPhase(input),
        ...(input.queueSequence === undefined ? {} : { queueSequence: input.queueSequence }),
      }))
      .sort(
        (a, b) =>
          (a.queueSequence ?? Number.MAX_SAFE_INTEGER) -
            (b.queueSequence ?? Number.MAX_SAFE_INTEGER) ||
          a.createdAt - b.createdAt ||
          a.id.localeCompare(b.id),
      )
  })
  const persistentGraph = computed(() =>
    projectPersistentExecutionGraph(
      timelineSnapshot.value
        ? { ...timelineSnapshot.value, activeRuns: activeCrtRuns.value }
        : {
            rootChatId: props.rootChatId,
            nodes: [],
            edges: [],
            activeRuns: activeCrtRuns.value,
            generations: [],
          },
    ),
  )
  const liveGraph = computed(() =>
    projectActiveTurnNodes(
      projectInputNodes(persistentGraph.value, pendingInputs.value),
      liveState.value.activeTurns,
      activeCrtRuns.value,
    ),
  )
  const foldProjection = computed(() => {
    if (props.foldMode === 'none') return { graph: liveGraph.value, ranges: [] }
    if (props.foldMode === 'round') return projectRoundExecutionGraph(liveGraph.value)
    if (props.foldMode === 'participant')
      return projectParticipantFoldExecutionGraph(liveGraph.value)
    return projectFoldExecutionGraph(liveGraph.value)
  })
  const graph = computed(() => foldProjection.value.graph)
  // 钢琴彩蛋触发状态机：consume 命中序列 → emit('easter-egg') 并吞掉本次节点点击。
  const coreFlowProjection = computed(() => projectCoreFlowExecutionGraph(graph.value))
  const paperGraph = computed(() => coreFlowProjection.value.paperGraph)
  type CachedPaperEntry = {
    version: string
    entry: ReturnType<typeof buildPaperStack>[number]
  }
  let paperEntryCache = new Map<string, CachedPaperEntry>()
  function paperTextHash(value?: string): number {
    if (!value) return 0
    let hash = 2166136261
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index)
      hash = Math.imul(hash, 16777619)
    }
    return hash >>> 0
  }
  function paperNodeVersion(node: ExecutionNode): string {
    const fact = node.sourceFact
    const own = [
      node.id,
      node.status,
      node.inputState ?? '',
      paperTextHash(node.content),
      paperTextHash(node.thinking),
      fact?.updatedAt ?? '',
      fact?.status ?? '',
      ...(fact?.toolCalls ?? []).flatMap((call) => [
        call.callId ?? '',
        call.status ?? '',
        paperTextHash(call.arguments),
        paperTextHash(call.result),
      ]),
    ]
    if (node.kind === 'fold') {
      own.push(
        ...(node.fold?.members ?? []).flatMap((member) => {
          const display = member.displayNode
          return [
            display.id,
            display.status,
            display.sourceFact?.updatedAt ?? '',
            paperTextHash(display.content),
            paperTextHash(display.thinking),
          ]
        }),
      )
    }
    return own.join('\u0001')
  }
  const paperEntries = computed(() => {
    const nextCache = new Map<string, CachedPaperEntry>()
    const entries = buildPaperStack(paperGraph.value.nodes, nodeTitle).map((entry) => {
      const version = paperNodeVersion(entry.node)
      const cached = paperEntryCache.get(entry.id)
      const stable =
        cached?.version === version && cached.entry.title === entry.title ? cached.entry : entry
      nextCache.set(entry.id, { version, entry: stable })
      return stable
    })
    paperEntryCache = nextCache
    return entries
  })
  const activePaperNodeId = ref<string>()
  const paperHasNewTail = ref(false)
  const paperCurrentIndex = computed(() => {
    const index = paperEntries.value.findIndex((entry) => entry.id === activePaperNodeId.value)
    return index >= 0 ? index : Math.max(0, paperEntries.value.length - 1)
  })
  function selectPaperNode(nodeId: string): void {
    const index = paperEntries.value.findIndex((entry) => entry.id === nodeId)
    if (index < 0) return
    activePaperNodeId.value = nodeId
    paperHasNewTail.value = index < paperEntries.value.length - 1 && paperHasNewTail.value
    closeNodeDetail()
  }
  function selectPaperIndex(index: number): void {
    const entry = paperEntries.value[index]
    if (!entry) return
    selectPaperNode(entry.id)
    if (index === paperEntries.value.length - 1) paperHasNewTail.value = false
  }
  function returnToLatestPaper(): void {
    selectPaperIndex(paperEntries.value.length - 1)
  }
  // ── 打包代际二层：点 pack 节点 → 抽屉已开则联动抽屉二层，否则本组件内弹窗 ──
  watch(
    paperEntries,
    (entries, previousEntries) => {
      if (!props.paperMode) return
      if (!entries.length) {
        activePaperNodeId.value = undefined
        paperHasNewTail.value = false
        return
      }
      const previousIds = new Set(previousEntries?.map((entry) => entry.id) ?? [])
      const previousActive = activePaperNodeId.value
      const wasAtTail =
        !previousEntries?.length || previousEntries.at(-1)?.id === previousActive || !previousActive
      if (previousActive && entries.some((entry) => entry.id === previousActive)) {
        if (wasAtTail && entries.at(-1)?.id !== previousActive) {
          activePaperNodeId.value = entries.at(-1)!.id
        } else if (!wasAtTail && entries.some((entry) => !previousIds.has(entry.id))) {
          paperHasNewTail.value = true
        }
        return
      }
      activePaperNodeId.value = entries.at(-1)!.id
    },
    { immediate: true },
  )
  function resetGraphProjection(): void {
    cachedActiveRunKey = ''
    cachedActiveCrtRuns = []
    paperEntryCache = new Map()
  }
  return {
    timelineSnapshot,
    timelineNodes,
    rootTransientState,
    liveState,
    activeCrtRuns,
    pendingInputs,
    persistentGraph,
    liveGraph,
    foldProjection,
    graph,
    coreFlowProjection,
    paperGraph,
    paperEntries,
    activePaperNodeId,
    paperHasNewTail,
    paperCurrentIndex,
    selectPaperNode,
    selectPaperIndex,
    returnToLatestPaper,
    resetGraphProjection,
  }
}
