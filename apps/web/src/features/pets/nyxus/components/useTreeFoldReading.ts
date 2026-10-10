import { ref, watch, type Ref } from 'vue'
import type { MessageBranchTreeControllerProps } from './treeControllerTypes'
import type { useTreeGraphProjection } from './useTreeGraphProjection'
import type { PositionedExecutionNode } from '../graph/executionLayout'
import type { ExecutionFoldMember } from '../graph/executionGraph'

/** Fold member selection, unread counts and reading protection. */
export function useTreeFoldReading({
  props,
  graph,
  foldProjection,
  pinnedDetailNodeId,
  hoveredDetailNodeId,
  selectedCallId,
  detailNode,
  detailFoldMember,
}: {
  props: MessageBranchTreeControllerProps
  graph: ReturnType<typeof useTreeGraphProjection>['graph']
  foldProjection: ReturnType<typeof useTreeGraphProjection>['foldProjection']
  pinnedDetailNodeId: Ref<string | undefined>
  hoveredDetailNodeId: Ref<string | undefined>
  selectedCallId: Ref<string | undefined>
  detailNode: () => PositionedExecutionNode | undefined
  detailFoldMember: () => ExecutionFoldMember | undefined
}) {
  const selectedFoldMembers = ref<Map<string, string>>(new Map())
  const unreadFoldMembers = ref<Map<string, number>>(new Map())
  const readingFoldId = ref<string>()
  function updateStringMap(
    target: typeof selectedFoldMembers,
    update: (next: Map<string, string>) => void,
  ): void {
    const next = new Map(target.value)
    update(next)
    target.value = next
  }
  function updateNumberMap(
    target: typeof unreadFoldMembers,
    update: (next: Map<string, number>) => void,
  ): void {
    const next = new Map(target.value)
    update(next)
    target.value = next
  }
  function memberContainingNode(
    members: readonly ExecutionFoldMember[],
    nodeId?: string,
  ): ExecutionFoldMember | undefined {
    if (!nodeId) return undefined
    return members.find(
      (member) => member.id === nodeId || member.nodes.some((node) => node.id === nodeId),
    )
  }
  function selectedFoldMember(
    node: PositionedExecutionNode | undefined,
  ): ExecutionFoldMember | undefined {
    const members = node?.fold?.members ?? []
    return (
      memberContainingNode(members, pinnedDetailNodeId.value) ??
      memberContainingNode(members, selectedFoldMembers.value.get(node?.id ?? '')) ??
      members.at(-1)
    )
  }
  function selectFoldMember(foldId: string, memberId: string): void {
    updateStringMap(selectedFoldMembers, (next) => next.set(foldId, memberId))
    const fold = graph.value.nodes.find((node) => node.id === foldId)
    if (fold?.fold?.members.at(-1)?.id === memberId) {
      updateNumberMap(unreadFoldMembers, (next) => next.set(foldId, 0))
    }
    selectedCallId.value = undefined
  }
  /** 常驻窗口标题分页器：按步进（-1/1）切换当前过程组/整轮的折叠成员页。 */
  function stepFoldDetail(delta: number): void {
    const node = detailNode()
    if (
      (node?.kind !== 'fold' && node?.kind !== 'round') ||
      !node.fold?.members.length
    )
      return
    const members = node.fold.members
    const currentIndex = Math.max(
      0,
      members.findIndex((member) => member.id === detailFoldMember()?.id),
    )
    const nextIndex = currentIndex + delta
    if (nextIndex < 0 || nextIndex >= members.length) return
    const member = members[nextIndex]
    if (!member) return
    selectFoldMember(node.id, member.id)
  }
  function onFoldRailInteraction(foldId: string, active: boolean): void {
    if (active) {
      readingFoldId.value = foldId
      return
    }
    const detailStillOpen =
      hoveredDetailNodeId.value === foldId || pinnedDetailNodeId.value === foldId
    if (!detailStillOpen && readingFoldId.value === foldId) readingFoldId.value = undefined
  }
  let knownFoldCounts = new Map<string, number>()
  // 首次进入/切根时，数据布局与工作台视口可能分两拍就绪。保留待 fit 状态，直到两者都有效，
  // 避免早到的 resetLayout 静默失败后一直使用默认相机；成功后即停止，不能抢走用户视角。
  watch(
    () =>
      foldProjection.value.ranges.map((range) => ({
        id: range.id,
        members: range.members,
      })),
    (ranges) => {
      if (props.foldMode === 'none') return
      const selected = new Map(selectedFoldMembers.value)
      const unread = new Map(unreadFoldMembers.value)
      const nextCounts = new Map<string, number>()
      for (const range of ranges) {
        const count = range.members.length
        const previousCount = knownFoldCounts.get(range.id) ?? 0
        const current = memberContainingNode(range.members, selected.get(range.id))
        const pinned = memberContainingNode(range.members, pinnedDetailNodeId.value)
        const protectedReading = readingFoldId.value === range.id || !!pinned
        const latest = range.members.at(-1)
        if (pinned) {
          selected.set(range.id, pinned.id)
          if (latest?.id === pinned.id) unread.set(range.id, 0)
        } else if (!current || (!protectedReading && count > previousCount)) {
          if (latest) selected.set(range.id, latest.id)
          unread.set(range.id, 0)
        } else if (protectedReading && count > previousCount) {
          unread.set(range.id, (unread.get(range.id) ?? 0) + count - previousCount)
        }
        nextCounts.set(range.id, count)
      }
      selectedFoldMembers.value = selected
      unreadFoldMembers.value = unread
      knownFoldCounts = nextCounts
    },
    { immediate: true },
  )
  function resetFoldReading(): void {
    selectedFoldMembers.value = new Map()
    unreadFoldMembers.value = new Map()
    knownFoldCounts = new Map()
  }
  return {
    selectedFoldMembers,
    unreadFoldMembers,
    readingFoldId,
    memberContainingNode,
    selectedFoldMember,
    selectFoldMember,
    stepFoldDetail,
    onFoldRailInteraction,
    resetFoldReading,
  }
}
