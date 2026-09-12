import { headerHandleId, type HeaderNodePort, type HeaderPoint } from './headerTemplate'
import {
  portPoint,
  rectOverlaps,
  relationTerminal,
  segmentHitsRect,
  segmentsCross,
  type BoardRelation,
  type HeaderRect,
  type VisibleHeaderEdge,
  type VisibleHeaderItem,
} from './headerLayout'

interface Endpoint {
  point: HeaderPoint
  escape: HeaderPoint
  handle: string
  reserve: HeaderRect
  sign: number
}
const length = (points: HeaderPoint[]) =>
  points
    .slice(1)
    .reduce((sum, p, i) => sum + Math.abs(p.x - points[i]!.x) + Math.abs(p.y - points[i]!.y), 0)
function clean(points: HeaderPoint[]): HeaderPoint[] {
  const result: HeaderPoint[] = []
  for (const p of points) {
    if (result.at(-1)?.x === p.x && result.at(-1)?.y === p.y) continue
    while (result.length > 1) {
      const a = result.at(-2)!,
        b = result.at(-1)!
      if ((a.x === b.x && b.x === p.x) || (a.y === b.y && b.y === p.y)) result.pop()
      else break
    }
    result.push(p)
  }
  return result
}

/** Bounded short-route search. Every rejected route becomes explicit paired terminals, never a crossing. */
export function routeBoardEdges(
  items: VisibleHeaderItem[],
  relations: BoardRelation[],
  ports: Record<string, HeaderNodePort[]>,
  options: { minY?: number; compact?: boolean } = {},
): VisibleHeaderEdge[] {
  const byId = new Map(items.map((item) => [item.id, item]))
  const endpoints = new Map<string, Endpoint>()
  for (const edge of relations)
    for (const end of ['source', 'target'] as const) {
      const item = byId.get(edge[end])!,
        peers = relations.filter((candidate) => candidate[end] === item.id)
      const port = ports[item.id]!.filter((p) => p.type === end)[peers.indexOf(edge)]!
      const point = portPoint(item, port.side, port.offset),
        sign = port.side === 'right' ? 1 : -1
      const escape = { x: point.x + sign * 24, y: point.y }
      endpoints.set(`${edge.id}:${end}`, {
        point,
        escape,
        handle: port.id,
        sign,
        reserve: { x: escape.x + (sign < 0 ? -44 : 0), y: escape.y - 8, width: 44, height: 16 },
      })
    }
  const obstacles: HeaderRect[] = [...items]
  const model = byId.get('model')
  if (model) obstacles.push({ x: model.x, y: model.y + model.height + 8, width: 280, height: 180 })
  const used: HeaderPoint[][] = [],
    edges: VisibleHeaderEdge[] = []
  for (const edge of relations) {
    const s = endpoints.get(`${edge.id}:source`)!,
      t = endpoints.get(`${edge.id}:target`)!
    const a = s.escape,
      b = t.escape
    const otherEndpoints = [...endpoints.values()].filter(
      (endpoint) => endpoint !== s && endpoint !== t,
    )
    const blockers = [...obstacles, ...otherEndpoints.map((endpoint) => endpoint.reserve)]
    const lines = [...used, ...otherEndpoints.map((endpoint) => [endpoint.point, endpoint.escape])]
    const xs = [(a.x + b.x) / 2, a.x + 72, b.x - 72]
    const ys = [(a.y + b.y) / 2, Math.min(a.y, b.y) - 76, Math.max(a.y, b.y) + 76]
    const candidates: HeaderPoint[][] = [
      ...(a.x === b.x || a.y === b.y ? [[a, b]] : []),
      [a, { x: a.x, y: b.y }, b],
      [a, { x: b.x, y: a.y }, b],
      ...xs.map((x) => [a, { x, y: a.y }, { x, y: b.y }, b]),
      ...ys.map((y) => [a, { x: a.x, y }, { x: b.x, y }, b]),
    ]
      .map(clean)
      .sort((left, right) => left.length - right.length || length(left) - length(right))
    let selected: HeaderPoint[] | undefined, labelPoint: HeaderPoint | undefined
    for (const candidate of candidates) {
      if (
        candidate.some((p) => p.x < 8 || p.y < (options.minY ?? 140)) ||
        length(candidate) > Math.max(160, length([a, b]) * 1.8)
      )
        continue
      if (
        candidate.slice(1).some(
          (p, i) =>
            blockers.some((r) =>
              segmentHitsRect(candidate[i]!, p, {
                x: r.x - 6,
                y: r.y - 6,
                width: r.width + 12,
                height: r.height + 12,
              }),
            ) ||
            lines.some((line) =>
              line.slice(1).some((q, j) => segmentsCross(candidate[i]!, p, line[j]!, q)),
            ),
        )
      )
        continue
      const full = clean([s.point, ...candidate, t.point])
      // A connector must leave its own package, not double back through it.
      if (full.slice(1).some((p, i) => items.some((item) => segmentHitsRect(full[i]!, p, item))))
        continue
      if (edge.label) {
        const labelWidth = edge.label.length * 12 + 20
        const segment = full
          .slice(1)
          .map((p, i) => [full[i]!, p] as const)
          .find(([c, d]) => c.y === d.y && Math.abs(c.x - d.x) >= labelWidth + 16)
        if (!segment) continue
        const [c, d] = segment,
          point = { x: (c.x + d.x) / 2, y: c.y - 22 }
        const box = { x: point.x - labelWidth / 2, y: point.y - 12, width: labelWidth, height: 24 }
        if (
          blockers.some((r) => rectOverlaps(box, r, 6)) ||
          [...lines, full].some((line) =>
            line.slice(1).some((p, i) => segmentHitsRect(line[i]!, p, box)),
          )
        )
          continue
        labelPoint = point
        obstacles.push(box)
      }
      selected = full
      break
    }
    const common = { memberIds: [edge.id], role: edge.role, collector: false }
    if (selected) {
      used.push(selected)
      edges.push({
        ...common,
        ...edge,
        sourceHandle: s.handle,
        targetHandle: t.handle,
        points: selected,
        labelPoint,
      })
      continue
    }
    for (const [end, endpoint] of [
      ['source', s],
      ['target', t],
    ] as const) {
      const outgoing = end === 'source',
        id = `junction:${edge.id}:${end}`
      const terminal = relationTerminal(edge.id, '', false, outgoing ? 'out' : 'in')
      terminal.peerNodeId = outgoing ? terminal.target : terminal.source
      const side = endpoint.sign > 0 ? 'left' : 'right',
        type = outgoing ? 'target' : 'source'
      const handle = headerHandleId(outgoing ? 'in' : 'out', side)
      items.push({ id, kind: 'terminal', ...endpoint.reserve, terminal })
      ports[id] = [{ id: handle, type, side, offset: 0 }]
      const points = outgoing
        ? [endpoint.point, endpoint.escape]
        : [endpoint.escape, endpoint.point]
      used.push(points)
      edges.push({
        ...common,
        id: `${edge.id}:${end}`,
        source: outgoing ? edge.source : id,
        target: outgoing ? id : edge.target,
        sourceHandle: outgoing ? endpoint.handle : handle,
        targetHandle: outgoing ? handle : endpoint.handle,
        points,
      })
    }
  }
  return edges
}
