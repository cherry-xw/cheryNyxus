import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'vue/compiler-sfc'
import { describe, expect, it } from 'vitest'
import { ref, shallowRef } from 'vue'
import { headerAttentionPosition } from '../../src/features/agent/workbench/runtime-diagram/headerAttentionPosition'
import {
  useWorkflowNodePresentation,
  visibleTemplateAnchor,
} from '../../src/features/agent/workbench/runtime-diagram/useWorkflowNodePresentation'
import { projectWorkflowGraph } from '../../src/features/agent/workbench/runtime-diagram/graphModel'
import { topologyMatrixSnapshot } from '../fixtures/executionGraphFixtures'

// Template ownership check, not a browser/visual acceptance test.
interface TemplateNode {
  type: number
  tag?: string
  tagType?: number
  props?: Array<{ type: number; name?: string; arg?: { content?: string } }>
  children?: TemplateNode[]
}
function slotOwners(file: string, name: string): string[] {
  const { descriptor } = parse(readFileSync(resolve(file), 'utf8'))
  const owners: string[] = []
  function visit(node: TemplateNode, owner?: string) {
    if (node.type === 1 && node.tag === 'template' && node.props?.some((prop) =>
      prop.type === 7 && prop.name === 'slot' && prop.arg?.content === name)) owners.push(owner ?? '')
    for (const child of node.children ?? []) visit(child, node.tagType === 1 ? node.tag : owner)
  }
  visit(descriptor.template!.ast as unknown as TemplateNode)
  return owners
}

function scriptSetupSource(file: string): string {
  return parse(readFileSync(resolve(file), 'utf8')).descriptor.scriptSetup?.content ?? ''
}

function templateSource(file: string): string {
  return parse(readFileSync(resolve(file), 'utf8')).descriptor.template?.content ?? ''
}

function projectedWith(expanded: readonly string[], wholeCollapsed = false) {
  const initial = projectWorkflowGraph(undefined, topologyMatrixSnapshot(), 'none')
  const headerId = initial.activeHeaderId!
  return projectWorkflowGraph(undefined, topologyMatrixSnapshot(), 'none', {}, [], {
    expanded: { [headerId]: expanded },
    overrides: wholeCollapsed ? { [`${headerId}:header`]: true } : {},
  })
}

describe('current-root question anchor', () => {
  it('passes the actual form to RuntimeDiagram, not the reader layout', () => {
    expect(slotOwners('web/src/features/agent/workbench/WorkbenchDialog.vue', 'attention')).toEqual(['RuntimeDiagram'])
  })

  it.each([0.35, 0.5, 1, 1.8])('uses flow-host coordinates and a fixed-size panel at zoom %s', (zoom) => {
    const result = headerAttentionPosition({ x: 100, y: 200 }, { width: 168, height: 64 }, { x: 20, y: -30, zoom })
    expect(parseFloat(result.left)).toBeCloseTo(20 + 184 * zoom)
    expect(parseFloat(result.top)).toBeCloseTo(-30 + 264 * zoom + 12)
    expect(result.transform).not.toContain('scale')
  })

  it('moves by exactly the pan delta, including at non-unit zoom', () => {
    const position = { x: 100, y: 200 }, size = { width: 168, height: 64 }
    const before = headerAttentionPosition(position, size, { x: 0, y: 0, zoom: 0.5 })
    const after = headerAttentionPosition(position, size, { x: -37, y: 95, zoom: 0.5 })
    expect(parseFloat(after.left) - parseFloat(before.left)).toBe(-37)
    expect(parseFloat(after.top) - parseFloat(before.top)).toBe(95)
    expect(after.transform).toBe(before.transform)
  })

  it('stays visible until pending work clears', () => {
    const initial = projectWorkflowGraph(undefined, topologyMatrixSnapshot(), 'none', {}, [], { follow: true })
    const graph = shallowRef(initial), pending = ref(1)
    const viewport = ref({ x: 0, y: 0, zoom: 0.5 })
    const presentation = useWorkflowNodePresentation({ graph: () => graph.value,
      pendingCount: () => pending.value, viewport: () => viewport.value, selection: () => undefined,
      step: () => undefined, host: () => undefined })
    const before = presentation.attentionOverlay.value!.style
    expect(before).toBeDefined()
    viewport.value = { ...viewport.value, y: 40 }
    expect(parseFloat(presentation.attentionOverlay.value!.style.top) - parseFloat(before.top)).toBe(40)
    const approval = initial.nodes.find(n => n.data?.kind === 'header-step' && n.data.template.id === 'approval')!
    expect(presentation.nodes.value.find(n => n.id === approval.id)?.data).toMatchObject({ slot: { status: 'waiting' } })
    expect(approval.data).not.toMatchObject({ slot: { status: 'waiting' } })
    graph.value = { ...initial, nodes: initial.nodes.filter(n => n.id !== approval.id) }
    expect(presentation.attentionOverlay.value).toBeUndefined()
    graph.value = initial
    pending.value = 0
    expect(presentation.attentionOverlay.value).toBeUndefined()
    expect(presentation.crtOverlay.value).toBeUndefined()
  })

  it('shows the CRT only while the active model node has a live streaming turn', () => {
    const graph = shallowRef(projectWorkflowGraph(undefined, topologyMatrixSnapshot(), 'none'))
    const viewport = ref({ x: 0, y: 0, zoom: 1 })
    const presentation = useWorkflowNodePresentation({
      graph: () => graph.value,
      pendingCount: () => 0,
      viewport: () => viewport.value,
      selection: () => undefined,
      step: () => undefined,
      host: () => undefined,
    })
    expect(presentation.crtOverlay.value).toBeUndefined()
    const liveTurn = {
      chatId: 'root',
      turnId: 'turn:live',
      runId: 'run:live',
      messageId: 'message:live',
      thinking: 'planning',
      content: 'streaming',
      status: 'running' as const,
      createdAt: 1,
    }
    graph.value = projectWorkflowGraph(undefined, topologyMatrixSnapshot(), 'none', {}, [liveTurn], { follow: true })
    expect(presentation.crtOverlay.value).toBeDefined()
    // CRT 属于“大模型响应”节点，锚点应落在该节点的可见代表上
    expect(visibleTemplateAnchor(graph.value, 'response')?.id).toBe(
      presentation.crtOverlay.value!.anchorId,
    )
    graph.value = projectWorkflowGraph(undefined, topologyMatrixSnapshot(), 'none', {}, [], { follow: true })
    expect(presentation.crtOverlay.value).toBeUndefined()
  })

  it('does not fall back to a page-fixed position before the viewport is ready', () => {
    const graph = projectWorkflowGraph(undefined, topologyMatrixSnapshot(), 'none', {}, [], { follow: true })
    const presentation = useWorkflowNodePresentation({ graph: () => graph,
      pendingCount: () => 1, viewport: () => undefined, selection: () => undefined,
      step: () => undefined, host: () => undefined })
    expect(presentation.attentionOverlay.value).toBeUndefined()
    expect(presentation.crtOverlay.value).toBeUndefined()
  })

  it('keeps the Vue Flow viewport ref intact in the runtime component', () => {
    const viewport = ref({ x: 12, y: 34, zoom: 0.75 })
    const store = shallowRef({ viewport })
    expect(store.value.viewport.value).toEqual({ x: 12, y: 34, zoom: 0.75 })
    const source = scriptSetupSource(
      'web/src/features/agent/workbench/runtime-diagram/RuntimeDiagram.vue',
    )
    expect(source).toContain('const flow = shallowRef<VueFlowStore>()')
    expect(source).not.toContain('const flow = ref<VueFlowStore>()')
  })

  it('preserves the stored fold state while pending work exists', () => {
    const source = scriptSetupSource(
      'web/src/features/agent/workbench/runtime-diagram/RuntimeDiagram.vue',
    )
    expect(source).toContain('follow: followRunning.value')
    expect(source).toContain('overrides: groupOverrides.value')
    expect(source).not.toContain('hasPendingAttention')
    expect(source).not.toContain('effectiveGroupOverrides')
  })

  it.each([
    ['approval', ['loop', 'record', 'tools'], ':template:approval'],
    ['approval', ['loop', 'record'], ':group:tools'],
    ['approval', ['loop'], ':group:record'],
    ['approval', [], ':group:loop'],
    ['model', ['loop', 'record', 'tools', 'retry-layer', 'model-layer'], ':template:model'],
    ['model', ['loop', 'record', 'tools', 'retry-layer'], ':group:model-layer'],
    ['model', ['loop', 'record', 'tools'], ':group:retry-layer'],
    ['model', ['loop', 'record'], ':group:tools'],
    ['model', ['loop'], ':group:record'],
    ['model', [], ':group:loop'],
    ['response', ['loop', 'record', 'tools', 'retry-layer', 'model-layer'], ':template:response'],
    ['response', ['loop', 'record', 'tools', 'retry-layer'], ':group:model-layer'],
    ['response', ['loop', 'record', 'tools'], ':group:retry-layer'],
    ['response', ['loop', 'record'], ':group:tools'],
    ['response', ['loop'], ':group:record'],
    ['response', [], ':group:loop'],
  ])('anchors %s to its nearest visible representative for %j', (templateId, expanded, suffix) => {
    expect(visibleTemplateAnchor(projectedWith(expanded), templateId)?.id).toMatch(new RegExp(`${suffix}$`))
  })

  it.each(['approval', 'model', 'response'])('anchors %s below the header when the whole header is collapsed', (templateId) => {
    const graph = projectedWith([], true)
    expect(visibleTemplateAnchor(graph, templateId)?.id).toBe(graph.activeHeaderId)
  })

  it('renders approval before CRT when both share an anchor and owns CRT outside the step node', () => {
    const overlays = templateSource(
      'web/src/features/agent/workbench/runtime-diagram/WorkflowAnchoredOverlays.vue',
    )
    expect(overlays.indexOf('<slot name="attention"')).toBeLessThan(overlays.indexOf('<WorkflowLiveCrt'))
    expect(scriptSetupSource(
      'web/src/features/agent/workbench/runtime-diagram/WorkflowAnchoredOverlays.vue',
    )).toContain('attentionHeight.value + 12')
    expect(templateSource(
      'web/src/features/agent/workbench/runtime-diagram/WorkflowHeaderStepNode.vue',
    )).not.toContain('WorkflowLiveCrt')
    expect(templateSource(
      'web/src/features/agent/workbench/runtime-diagram/RuntimeDiagram.vue',
    )).toContain('WorkflowAnchoredOverlays')
  })

  it('keeps pending content independent from historical scope selection', () => {
    const graph = shallowRef(projectWorkflowGraph(undefined, topologyMatrixSnapshot(), 'none', {}, [], { follow: true }))
    const header = graph.value.nodes.find(node => node.id === graph.value.activeHeaderId)?.data
    expect(header?.kind).toBe('header')
    if (header?.kind === 'header') header.state.scope.runId = 'historical-run'
    const presentation = useWorkflowNodePresentation({ graph: () => graph.value,
      pendingCount: () => 2, viewport: () => ({ x: 0, y: 0, zoom: 1 }),
      selection: () => undefined, step: () => undefined, host: () => undefined })
    expect(presentation.currentViewPendingCount.value).toBe(2)
    expect(presentation.attentionOverlay.value).toBeDefined()
  })
})
