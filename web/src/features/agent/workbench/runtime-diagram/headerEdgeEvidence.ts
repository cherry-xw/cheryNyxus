import type { WorkflowOccurrence } from '@chery/protocol'
import { matchesHeaderNode, type HeaderStateProjection } from './headerState'
import { WORKFLOW_HEADER_TEMPLATE } from './headerTemplate'
import { legacyHeaderPredecessor } from './headerLegacyPredecessor'

export interface HeaderEdgeEvidence {
  sourceOccurrenceId: string
  targetOccurrenceId: string
  targetStatus: WorkflowOccurrence['status']
  targetSequence: number
}

/** Structural relays carry a proven transition, but never acquire a step status. */
export function projectHeaderEdgeEvidence(
  state: HeaderStateProjection,
  history: readonly WorkflowOccurrence[] = [],
): Map<string, HeaderEdgeEvidence> {
  const evidence = new Map<string, HeaderEdgeEvidence>()
  const slots = state.slots
  const nodes = WORKFLOW_HEADER_TEMPLATE.nodes
  const edges = WORKFLOW_HEADER_TEMPLATE.edges
  const visibleOccurrences = Object.values(slots).flatMap((slot) => slot.occurrences)
  const chatId = state.occurrences[0]?.chatId
  // Slot selection follows the current node. The trace retains the whole run unless
  // the user explicitly selects a historical iteration, attempt or tool call.
  const participating = new Map([...history, ...visibleOccurrences]
    .filter((item) => item.orderQuality === 'exact' && item.chatId === chatId &&
      item.runId === state.scope.runId &&
      (state.selection.iteration === undefined || item.iteration === undefined || item.iteration === state.scope.iteration) &&
      (state.selection.attempt === undefined || item.attempt === undefined || item.attempt === state.scope.attempt) &&
      (!state.selection.callId || !item.callId || item.callId === state.scope.callId))
    .map(item => [item.occurrenceId, item]))
  const owns = (id: string, occurrence: WorkflowOccurrence) =>
    participating.has(occurrence.occurrenceId) &&
    nodes.some(node => node.id === id && matchesHeaderNode(node, occurrence) &&
      (node.group !== 'tools' || node.id === 'tool-list' || !!occurrence.callId))
  const primary = (occurrence: WorkflowOccurrence) =>
    nodes.filter((node) => !node.match && owns(node.id, occurrence))
  function record(ids: string[], source: WorkflowOccurrence, target: WorkflowOccurrence): void {
    for (const id of ids) {
      const previous = evidence.get(id)
      if (previous?.targetStatus === 'running' && target.status !== 'running') continue
      if (
        previous &&
        previous.targetStatus === target.status &&
        previous.targetSequence > target.lastSequence
      )
        continue
      evidence.set(id, {
        sourceOccurrenceId: source.occurrenceId,
        targetOccurrenceId: target.occurrenceId,
        targetStatus: target.status,
        targetSequence: target.lastSequence,
      })
    }
  }
  const occurrences = participating
  const sources = new Map(
    [...history, ...occurrences.values()]
      .filter((item) => item.orderQuality === 'exact')
      .map((item) => [item.occurrenceId, item]),
  )
  // Context is a real parallel prerequisite of request. The wire schema keeps one
  // execution cause, so this supply relation is proven by completed exact facts in the same run.
  for (const target of participating.values()) {
    if (target.kind !== 'request') continue
    const contexts = [...participating.values()]
      .filter((item) => item.kind === 'context' && item.status === 'succeeded' &&
        item.chatId === target.chatId && item.runId === target.runId &&
        item.firstSequence < target.firstSequence)
      .sort((left, right) => right.firstSequence - left.firstSequence)
    if (contexts[0] && contexts[0].firstSequence !== contexts[1]?.firstSequence)
      record(['context:request'], contexts[0], target)
  }
  // Intake can precede the run. Include only causal or message-anchored ancestors.
  for (const item of participating.values()) {
    const source = item.causeOccurrenceId ? sources.get(item.causeOccurrenceId)
      : legacyHeaderPredecessor(item, [...sources.values()])
    if (source && source.chatId === chatId && ['submission', 'queue'].includes(source.kind))
      participating.set(source.occurrenceId, source)
  }
  for (const target of occurrences.values()) {
    if (target.callId && state.selection.callId && target.callId !== state.scope.callId) continue
    // A response/error/wait alias describes the same observed event.
    for (const edge of edges) {
      const alias = nodes.find((node) => node.id === edge.target)
      if (
        alias?.match &&
        alias.match !== 'unobserved' &&
        owns(edge.source, target) &&
        owns(edge.target, target)
      ) {
        record([edge.id], target, target)
      }
      if (edge.target === 'channels' && edge.source === 'response' &&
        owns('response', target)) record([edge.id], target, target)
    }
    const source = target.causeOccurrenceId
      ? sources.get(target.causeOccurrenceId)
      : legacyHeaderPredecessor(target, [...sources.values()])
    if (
      !source ||
      (source.runId && source.runId !== target.runId && !['submission', 'queue'].includes(source.kind)) ||
      source.chatId !== target.chatId
    )
      continue
    if (source.callId && target.callId && source.callId !== target.callId) continue
    if (source.callId && state.selection.callId && source.callId !== state.scope.callId) continue
    const cause = source
    const starts = nodes.filter((node) => !node.match && matchesHeaderNode(node, source))
    const destinations = new Set(primary(target).map((node) => node.id))
    const paths: string[][] = []
    function visit(id: string, path: string[], seen: Set<string>): void {
      if (paths.length > 1) return
      if (destinations.has(id) && path.length) {
        paths.push(path)
        return
      }
      for (const edge of edges.filter((candidate) => candidate.source === id)) {
        if (seen.has(edge.target)) continue
        // A failed execution has two static routes to results; the failure fact selects
        // the rejection collector, not the normal direct execution-result edge.
        if (edge.id === 'execution:tool-result' && ['failed', 'rejected'].includes(cause.status)) continue
        const next = nodes.find((node) => node.id === edge.target)!
        const relay = next.match === 'unobserved' && ['entry', 'approval-needed', 'channels'].includes(next.id)
        const response = next.id === 'response' && cause.kind === 'model' &&
          cause.status === 'succeeded' && ['checkpoint', 'tool-list'].includes(target.kind)
        const alias = !!next.match && (response || matchesHeaderNode(next, cause) || owns(next.id, target))
        if (!destinations.has(next.id) && !relay && !alias) continue
        visit(next.id, [...path, edge.id], new Set([...seen, next.id]))
      }
    }
    for (const start of starts) visit(start.id, [], new Set([start.id]))
    if (paths.length === 1) record(paths[0]!, source, target)
  }
  return evidence
}
