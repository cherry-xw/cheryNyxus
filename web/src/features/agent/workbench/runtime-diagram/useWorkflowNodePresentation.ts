import { computed } from 'vue'
import type { NyxusContentSelection } from '@/features/pets/nyxus/public'
import { resolveWorkflowGraphSelection, type WorkflowGraphProjection, type WorkflowGraphNode } from './graphModel'
import { absoluteGraphPosition, headerTemplateNodeId, type HeaderSelection } from './headerGraph'
import { headerAttentionPosition } from './headerAttentionPosition'

export interface WorkflowOverlayPlacement {
  anchorId: string
  style: ReturnType<typeof headerAttentionPosition>
}

export function visibleTemplateAnchor(
  graph: WorkflowGraphProjection,
  templateNodeId: string,
): WorkflowGraphNode | undefined {
  if (!graph.activeHeaderId) return undefined
  const originalId = headerTemplateNodeId(graph.activeHeaderId, templateNodeId)
  const representativeId = graph.representatives?.[originalId] ?? originalId
  return graph.nodes.find((node) => node.id === representativeId)
}

/** Selection and pending forms decorate the graph without changing execution evidence. */
export function useWorkflowNodePresentation(options: {
  graph: () => WorkflowGraphProjection
  selection: () => NyxusContentSelection | undefined
  step: () => HeaderSelection | undefined
  pendingCount: () => number | undefined
  viewport: () => { x: number; y: number; zoom: number } | undefined
  host: () => HTMLElement | null | undefined
}) {
  const selectedGraphNodeId = computed(() => {
    const selection = options.selection()
    if (!selection) return undefined
    const resolution = resolveWorkflowGraphSelection(options.graph(), selection)
    return resolution.status === 'available' ? resolution.graphNodeId : undefined
  })
  const currentViewPendingCount = computed(() => options.pendingCount() ?? 0)
  function projectNodeSelection(node: WorkflowGraphNode): WorkflowGraphNode {
    const data = node.data
    const className = [node.class, { selected: node.id === selectedGraphNodeId.value }]
    if (!data || data.kind !== 'header-step') {
      return { ...node, class: className }
    }
    const step = options.step()
    return {
      ...node,
      class: className,
      data: {
        ...data,
        slot: data.template.id === 'approval' && currentViewPendingCount.value
          ? { ...data.slot, status: 'waiting', statusText: '等待审批与回答' } : data.slot,
        selected: step?.headerId === data.headerId && step.templateNodeId === data.template.id,
      },
    }
  }
  function overlayPlacement(templateNodeId: string): WorkflowOverlayPlacement | undefined {
    const graph = options.graph()
    const node = visibleTemplateAnchor(graph, templateNodeId)
    const viewport = options.viewport()
    if (!node || !viewport) return undefined
    const position = absoluteGraphPosition(node, graph.nodes)
    return {
      anchorId: node.id,
      style: headerAttentionPosition(position,
        { width: Number(node.width ?? 168), height: Number(node.height ?? 64) }, viewport),
    }
  }
  const attentionOverlay = computed(() => currentViewPendingCount.value
    ? overlayPlacement('approval') : undefined)
  // 实时 CRT 属于“大模型响应”节点：只在该节点活动（存在正在返回数据的 live turn）时显示；
  // 空闲、终态或回放不保留占位面板。
  const crtOverlay = computed(() =>
    options.graph().activeLiveTurn ? overlayPlacement('response') : undefined,
  )

  function focusPendingAttention(): void {
    options.host()?.querySelector<HTMLElement>(
      '.workflow-attention-anchor input, .workflow-attention-anchor textarea, .workflow-attention-anchor button',
    )?.focus()
  }

  return { nodes: computed(() => options.graph().nodes.map(projectNodeSelection)), currentViewPendingCount,
    attentionOverlay, crtOverlay, focusPendingAttention }
}
