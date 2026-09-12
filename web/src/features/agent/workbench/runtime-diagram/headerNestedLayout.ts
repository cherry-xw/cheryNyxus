import { HEADER_LAYERS, WORKFLOW_HEADER_TEMPLATE as template, headerHandleId, type HeaderNodePort } from './headerTemplate'
import { layerAncestors, relationTerminal, type HeaderLayout, type VisibleHeaderItem, type BoardRelation } from './headerLayout'
import { routeBoardEdges } from './headerBoardRouting'

// Each row sizes itself: an expanded chip never stretches the columns of its peripheral steps.
const rows: Record<string, string[][]> = {
  overview: [['intake', 'loop']],
  loop: [['entry'], ['record'], ['decision', 'wait', 'result']],
  record: [['input', 'command'], ['tools'], ['checkpoint']],
  tools: [['resume', 'retry-layer'], ['tool-list', 'validation', 'authorization', 'approval-needed'], ['rejection', 'approval', 'preflight'], ['tool-result', 'execution', 'collaboration']],
  'retry-layer': [['model-layer'], ['error', 'retry']],
  'model-layer': [['request', 'model', 'response'], ['compact', 'channels']],
  intake: [['submission', 'queue'], ['context', 'wake']],
  compact: [['compact-request', 'compact-summary', 'compact-applied']],
  collaboration: [['dispatch', 'child-run'], ['parent-receive', 'child-return']],
}
const pitch = 20, gapX = 112, gapY = 72, inset = 96
const isGroup = (id: string) => HEADER_LAYERS.some((layer) => layer.id === id)

export function buildNestedHeader(expanded: ReadonlySet<string>): HeaderLayout {
  function board(boardId: string): HeaderLayout {
    const boardRows = rows[boardId]!
    const visible = new Set(boardRows.flat())
    const representatives: Record<string, string> = {}
    for (const node of template.nodes) {
      const id = visible.has(node.id) ? node.id : layerAncestors(node.group).find((g) => visible.has(g))
      if (id) representatives[node.id] = id
    }
    const children = new Map<string, HeaderLayout>()
    for (const id of visible) if (isGroup(id) && expanded.has(id)) children.set(id, board(id))
    const relations: BoardRelation[] = []
    const boundary: { edge: typeof template.edges[number]; incoming: boolean; id: string }[] = []
    for (const edge of template.edges) {
      let source = representatives[edge.source], target = representatives[edge.target]
      if ((!source && !target) || source === target) continue
      if (!source || !target) {
        const incoming = !source, id = `pin:${boardId}:${edge.id}`
        boundary.push({ edge, incoming, id })
        if (incoming) source = id
        else target = id
      }
      relations.push({ ...edge, source: source!, target: target! })
    }
    const items: VisibleHeaderItem[] = []
    for (const id of visible) {
      const child = children.get(id)
      const degree = Math.max(relations.filter((r) => r.source === id).length, relations.filter((r) => r.target === id).length)
      items.push({ id, kind: isGroup(id) ? 'group' : 'step', collapsed: !child,
        x: 0, y: 0, width: child?.width ?? 168, height: child?.height ?? Math.max(56, degree * pitch + 16) })
    }
    const byId = new Map(items.map((item) => [item.id, item]))
    const rowWidths = boardRows.map((row) => row.reduce((sum, id) => sum + byId.get(id)!.width, 0) + (row.length - 1) * gapX)
    const width = Math.max(...rowWidths) + inset * 2
    let y = boardId === 'overview' ? 140 : 72
    for (const [index, row] of boardRows.entries()) {
      let x = (width - rowWidths[index]!) / 2
      const height = Math.max(...row.map((id) => byId.get(id)!.height + (id === 'model' ? 204 : 0)))
      for (const id of row) {
        const item = byId.get(id)!
        item.x = x; item.y = y
        x += item.width + gapX
      }
      y += height + gapY
    }
    if (boardId === 'tools') {
      items.push({ id: 'calls', kind: 'calls', x: inset, y, width: width - inset * 2, height: 196 })
      y += 196 + gapY
    }
    const height = Math.max(y, boundary.length * pitch + 144)
    // Internal and external handles meet exactly on the package boundary, not on another board.
    for (const { edge, incoming, id } of boundary) {
      const peers = boundary.filter((b) => b.incoming === incoming)
      const ordinal = peers.findIndex((b) => b.id === id)
      items.push({ id, kind: 'terminal', x: incoming ? 0 : width, y: height / 2 + (ordinal - (peers.length - 1) / 2) * pitch,
        width: 0, height: 0, terminal: relationTerminal(edge.id, incoming ? edge.source : edge.target, true, incoming ? 'in' : 'out') })
    }
    const ports: Record<string, HeaderNodePort[]> = {}
    for (const item of items) {
      ports[item.id] = []
      for (const type of ['source', 'target'] as const) {
        const edges = relations.filter((edge) => edge[type] === item.id)
        edges.forEach((_, i) => {
          const side = type === 'source' ? 'right' : 'left'
          const offset = (i - (edges.length - 1) / 2) * pitch
          ports[item.id]!.push({ type, side, offset, id: headerHandleId(type === 'source' ? 'out' : 'in', side, offset) })
        })
      }
    }
    const edges = routeBoardEdges(items, relations, ports, { minY: 48, compact: true })
    // Local fallback endpoints and edge segments need board-qualified identities.
    const rename = (id: string) => id.startsWith('junction:') ? `${boardId}:${id}` : id
    for (const item of items) if (item.parent === (boardId === 'overview' ? undefined : boardId)) {
      const id = rename(item.id)
      if (id !== item.id) { ports[id] = ports[item.id]!; delete ports[item.id]; item.id = id }
    }
    const localIds = new Set(relations.map((r) => r.id))
    for (const edge of edges) if (localIds.has(edge.id) || edge.id.startsWith('junction:') || relations.some((r) => edge.id === `${r.id}:source` || edge.id === `${r.id}:target`)) {
      edge.id = `${boardId}:${edge.id}`; edge.source = rename(edge.source); edge.target = rename(edge.target)
    }
    for (const item of items) item.parent = boardId === 'overview' ? undefined : boardId
    // Flatten in parent-before-child order; Vue Flow still owns genuine recursive parent nodes.
    const resultItems: VisibleHeaderItem[] = []
    for (const item of items) {
      resultItems.push(item)
      const child = children.get(item.id)
      if (!child) continue
      for (const nested of child.items) resultItems.push({ ...nested, x: nested.x + item.x, y: nested.y + item.y })
      Object.assign(ports, child.ports)
      Object.assign(representatives, child.representatives)
      edges.push(...child.edges.map((edge) => ({ ...edge,
        points: edge.points.map((p) => ({ x: p.x + item.x, y: p.y + item.y })),
        labelPoint: edge.labelPoint ? { x: edge.labelPoint.x + item.x, y: edge.labelPoint.y + item.y } : undefined,
      })))
    }
    const visibleEdges = new Set(edges.flatMap((e) => e.memberIds))
    return { boardId, width, height, items: resultItems, edges, ports, representatives,
      internalEdgeIds: template.edges.filter((e) => !visibleEdges.has(e.id)).map((e) => e.id), externalEdgeIds: [] }
  }
  return board('overview')
}
