import type { WorkflowHistoryRequest, WorkflowHistoryResponse } from '@chery/protocol'

type HistoryReader = (request: WorkflowHistoryRequest) => Promise<WorkflowHistoryResponse>

function uniqueBy<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>()
  return values.filter((value) => {
    const id = key(value)
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}

/** Reads one immutable history window. A stale caller receives no partial result. */
export async function readWorkflowHistoryPages(
  request: WorkflowHistoryRequest,
  read: HistoryReader,
  stale: () => boolean = () => false,
): Promise<WorkflowHistoryResponse | undefined> {
  const first = await read(request)
  if (stale()) return undefined
  let page = first
  const facts = [...first.facts]
  const events = [...(first.events ?? [])]
  const occurrences = [...(first.occurrences ?? [])]
  const gaps = [...(first.gaps ?? [])]
  let hasEvents = first.events !== undefined
  let hasOccurrences = first.occurrences !== undefined
  let hasGaps = first.gaps !== undefined
  const seenCursors = new Set<string>()

  while (!page.complete) {
    if (!page.nextCursor || seenCursors.has(page.nextCursor))
      throw new Error('历史分页未完成，请重新加载')
    seenCursors.add(page.nextCursor)
    page = await read({ ...request, cursor: page.nextCursor })
    if (stale()) return undefined
    if (
      page.chatId !== first.chatId ||
      page.boundary !== first.boundary ||
      page.upperSequence !== first.upperSequence
    )
      throw new Error('历史分页边界已变化，请重新加载')
    hasEvents ||= page.events !== undefined
    hasOccurrences ||= page.occurrences !== undefined
    hasGaps ||= page.gaps !== undefined
    facts.push(...page.facts)
    events.push(...(page.events ?? []))
    occurrences.push(...(page.occurrences ?? []))
    gaps.push(...(page.gaps ?? []))
  }

  return {
    ...first,
    ...page,
    nextCursor: undefined,
    complete: true,
    facts: uniqueBy(facts, (fact) => fact.id).sort(
      (left, right) => left.orderKey - right.orderKey || left.id.localeCompare(right.id),
    ),
    ...(hasEvents
      ? {
          events: uniqueBy(events, (event) => event.eventId).sort(
            (left, right) =>
              left.sequence - right.sequence || left.eventId.localeCompare(right.eventId),
          ),
        }
      : {}),
    ...(hasOccurrences
      ? {
          occurrences: uniqueBy(occurrences, (occurrence) => occurrence.occurrenceId).sort(
            (left, right) =>
              left.firstSequence - right.firstSequence ||
              left.occurrenceId.localeCompare(right.occurrenceId),
          ),
        }
      : {}),
    ...(hasGaps
      ? {
          gaps: uniqueBy(gaps, (gap) => gap.gapId).sort(
            (left, right) =>
              left.fromSequence - right.fromSequence || left.gapId.localeCompare(right.gapId),
          ),
        }
      : {}),
  }
}
