import {
  HEADER_LAYERS,
  WORKFLOW_HEADER_TEMPLATE as template,
  headerHandleId,
  type HeaderNodePort,
  type HeaderPort,
} from './headerTemplate'
import {
  layerAncestors,
  relationTerminal,
  type HeaderLayout,
  type VisibleHeaderItem,
  type BoardRelation,
} from './headerLayout'
import { routeBoardEdges } from './headerBoardRouting'
import { placeCircuit, type PinSpec } from './headerCircuitPlacement'

const cache = new Map<string, { graph: HeaderLayout; pins: Record<string, PinSpec> }>()
export function buildNestedHeader(expanded: ReadonlySet<string>): HeaderLayout {
  function board(
    boardId: string,
    opened: ReadonlySet<string>,
  ): { graph: HeaderLayout; pins: Record<string, PinSpec> } {
    const key = `${boardId}:${HEADER_LAYERS.filter(
      (l) => opened.has(l.id) && (boardId === 'overview' || layerAncestors(l.id).includes(boardId)),
    )
      .map((l) => l.id)
      .join('|')}`
    const cached = cache.get(key)
    if (cached) return cached
    const groups = HEADER_LAYERS.filter((l) => (l.parent ?? 'overview') === boardId).map(
      (l) => l.id,
    )
    if (boardId === 'overview') groups.reverse()
    const visible = new Set([
      ...groups,
      ...template.nodes.filter((n) => n.group === boardId).map((n) => n.id),
    ])
    const representatives: Record<string, string> = {}
    for (const node of template.nodes) {
      const id = visible.has(node.id)
        ? node.id
        : layerAncestors(node.group).find((g) => visible.has(g))
      if (id) representatives[node.id] = id
    }
    const children = new Map(
      groups.map((id) => [id, board(id, opened.has(id) ? opened : new Set())]),
    )
    const relations: BoardRelation[] = []
    const boundaries: { edge: (typeof template.edges)[number]; incoming: boolean; id: string }[] =
      []
    for (const edge of template.edges) {
      let source = representatives[edge.source],
        target = representatives[edge.target]
      if ((!source && !target) || source === target) continue
      if (!source || !target) {
        const incoming = !source,
          id = `pin:${boardId}:${edge.id}`
        boundaries.push({ edge, incoming, id })
        if (incoming) source = id
        else target = id
      }
      relations.push({
        ...edge,
        source: source!,
        target: target!,
        label:
          representatives[edge.source] && !(groups.includes(source!) && opened.has(source!))
            ? edge.label
            : undefined,
      })
    }
    const interfaces = new Map<string, Record<string, PinSpec>>()
    const items: VisibleHeaderItem[] = [...visible].map((id) => {
      const child = children.get(id),
        open = !!child && opened.has(id)
      const item: VisibleHeaderItem = {
        id,
        kind: child ? 'group' : 'step',
        collapsed: !open,
        x: 0,
        y: 0,
        width: open ? child!.graph.width : 148,
        height: open ? child!.graph.height : 56,
      }
      if (child) {
        const pins: Record<string, PinSpec> = {}
        for (const side of ['left', 'right', 'top', 'bottom'] as const) {
          const peers = Object.entries(child.pins)
            .filter(([, p]) => p.side === side)
            .sort((a, b) => a[1].at - b[1].at)
          if (!open) {
            if (side === 'left' || side === 'right')
              item.height = Math.max(item.height, peers.length * 24 + 24)
            else item.width = Math.max(item.width, peers.length * 24 + 24)
          }
        }
        for (const side of ['left', 'right', 'top', 'bottom'] as const) {
          const peers = Object.entries(child.pins)
            .filter(([, p]) => p.side === side)
            .sort((a, b) => a[1].at - b[1].at)
          peers.forEach(([edge, p], i) => {
            pins[edge] = {
              side,
              at: open
                ? p.at
                : (side === 'left' || side === 'right' ? item.height : item.width) / 2 +
                  (i - (peers.length - 1) / 2) * 24,
            }
          })
        }
        interfaces.set(id, pins)
      }
      return item
    })
    const placement = placeCircuit(boardId, items, interfaces),
      { width, height } = placement
    const pins = placement.boundary
    for (const { edge, incoming, id } of boundaries) {
      const p = pins[edge.id]
      if (!p) throw new Error(`Missing boundary ${boardId}:${edge.id}`)
      const horizontal = p.side === 'top' || p.side === 'bottom'
      items.push({
        id,
        kind: 'terminal',
        width: 8,
        height: 8,
        x: horizontal ? p.at - 4 : p.side === 'left' ? 0 : width - 8,
        y: horizontal ? (p.side === 'top' ? 0 : height - 8) : p.at - 4,
        terminal: relationTerminal(
          edge.id,
          incoming ? edge.source : edge.target,
          true,
          incoming ? 'in' : 'out',
        ),
      })
    }
    const ports: Record<string, HeaderNodePort[]> = {}
    for (const item of items) {
      ports[item.id] = []
      for (const type of ['source', 'target'] as const) {
        const peers = relations.filter((e) => e[type] === item.id)
        for (const edge of peers) {
          let side: HeaderPort,
            offset = 0
          if (item.terminal) side = pins[edge.id]!.side
          else if (groups.includes(item.id)) {
            const p = interfaces.get(item.id)![edge.id]!
            side = p.side
            offset = p.at - (side === 'left' || side === 'right' ? item.height : item.width) / 2
          } else {
            const spec = placement.ends[`${edge.id}@${item.id}`]
            if (!spec) throw new Error(`Missing endpoint ${boardId}:${edge.id}@${item.id}`)
            side = spec.side
            offset = spec.offset ?? 0
          }
          ports[item.id]!.push({
            type,
            side,
            offset,
            id: headerHandleId(type === 'source' ? 'out' : 'in', side, offset),
          })
        }
      }
    }
    const edges = routeBoardEdges(items, relations, ports, { width, height })
    for (const edge of edges) edge.id = `${boardId}:${edge.id}`
    for (const item of items) item.parent = boardId === 'overview' ? undefined : boardId
    const flattened: VisibleHeaderItem[] = []
    for (const item of items) {
      flattened.push(item)
      if (!opened.has(item.id)) continue
      const child = children.get(item.id)?.graph
      if (!child) continue
      flattened.push(...child.items.map((n) => ({ ...n, x: n.x + item.x, y: n.y + item.y })))
      Object.assign(ports, child.ports)
      Object.assign(representatives, child.representatives)
      edges.push(
        ...child.edges.map((e) => ({
          ...e,
          points: e.points.map((p) => ({ x: p.x + item.x, y: p.y + item.y })),
          labelPoint: e.labelPoint
            ? { x: e.labelPoint.x + item.x, y: e.labelPoint.y + item.y }
            : undefined,
        })),
      )
    }
    const seen = new Set(edges.flatMap((e) => e.memberIds))
    const graph: HeaderLayout = {
      boardId,
      width,
      height,
      items: flattened,
      edges,
      ports,
      representatives,
      internalEdgeIds: template.edges.filter((e) => !seen.has(e.id)).map((e) => e.id),
      externalEdgeIds: [],
    }
    const result = { graph, pins }
    if (cache.size >= 128) cache.delete(cache.keys().next().value!)
    cache.set(key, result)
    return result
  }
  return board('overview', expanded).graph
}
