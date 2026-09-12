import type { HeaderNodePort, HeaderPoint } from './headerTemplate'
import { circuitRoute } from './headerCircuitRouting'
import {
  portPoint,
  rectOverlaps,
  segmentHitsRect,
  segmentsCross,
  type BoardRelation,
  type HeaderRect,
  type VisibleHeaderEdge,
  type VisibleHeaderItem,
} from './headerLayout'

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
/** Route all nets before placing labels; a label must never force an electrical detour. */
export function routeBoardEdges(
  items: VisibleHeaderItem[],
  relations: BoardRelation[],
  ports: Record<string, HeaderNodePort[]>,
  options: { width: number; height: number },
): VisibleHeaderEdge[] {
  const byId = new Map(items.map((n) => [n.id, n]))
  const endpoints = new Map<string, { point: HeaderPoint; escape: HeaderPoint; handle: string }>()
  for (const edge of relations)
    for (const type of ['source', 'target'] as const) {
      const item = byId.get(edge[type])!,
        peers = relations.filter((e) => e[type] === item.id),
        port = ports[item.id]!.filter((p) => p.type === type)[peers.indexOf(edge)]!
      const point = portPoint(item, port.side, port.offset),
        sign = item.terminal?.boundary ? -1 : 1
      const normal = {
        x: port.side === 'left' ? -1 : port.side === 'right' ? 1 : 0,
        y: port.side === 'top' ? -1 : port.side === 'bottom' ? 1 : 0,
      }
      endpoints.set(`${edge.id}:${type}`, {
        point,
        escape: { x: point.x + normal.x * sign * 24, y: point.y + normal.y * sign * 24 },
        handle: port.id,
      })
    }
  const obstacles: HeaderRect[] = [...items]
  const model = byId.get('model')
  if (model) obstacles.push({ x: model.x, y: model.y + model.height + 8, width: 280, height: 180 })
  let order = [...relations].sort((a, b) => {
    const distance = (e: BoardRelation) =>
      length([endpoints.get(`${e.id}:source`)!.point, endpoints.get(`${e.id}:target`)!.point])
    return distance(a) - distance(b) || a.id.localeCompare(b.id)
  })
  let edges: VisibleHeaderEdge[] = []
  const tried = new Set<string>()
  for (let attempt = 0; attempt < relations.length * 2 + 1; attempt++) {
    const key = order.map((e) => e.id).join('|')
    if (tried.has(key)) break
    tried.add(key)
    edges = []
    let failed: BoardRelation | undefined
    for (const edge of order) {
      const s = endpoints.get(`${edge.id}:source`)!,
        t = endpoints.get(`${edge.id}:target`)!,
        a = s.escape,
        b = t.escape
      const others = [...endpoints.values()].filter((p) => p !== s && p !== t)
      // A boundary terminal is a measured 8px pin, and its own net passes through it.
      const bodies = obstacles.filter(
        (r) =>
          r !== (byId.get(edge.source)?.terminal ? byId.get(edge.source) : undefined) &&
          r !== (byId.get(edge.target)?.terminal ? byId.get(edge.target) : undefined),
      )
      const used = [...edges.map((e) => e.points), ...others.map((p) => [p.point, p.escape])]
      const candidates = [
        ...(a.x === b.x || a.y === b.y ? [[a, b]] : []),
        [a, { x: a.x, y: b.y }, b],
        [a, { x: b.x, y: a.y }, b],
        ...[a.x, b.x, (a.x + b.x) / 2].map((x) => [a, { x, y: a.y }, { x, y: b.y }, b]),
        ...[a.y, b.y, (a.y + b.y) / 2].map((y) => [a, { x: a.x, y }, { x: b.x, y }, b]),
      ]
        .map((p) => clean([s.point, ...p, t.point]))
        .sort((a, b) => length(a) + 48 * a.length - length(b) - 48 * b.length)
      const valid = (p: HeaderPoint[]) =>
        p.every((q) => q.x >= 0 && q.y >= 0 && q.x <= options.width && q.y <= options.height) &&
        p
          .slice(1)
          .every(
            (b, i) =>
              !bodies.some((r) => segmentHitsRect(p[i]!, b, r)) &&
              !used.some((line) =>
                line.slice(1).some((d, j) => segmentsCross(p[i]!, b, line[j]!, d)),
              ),
          )
      let points = candidates.find(valid)
      if (!points) {
        try {
          points = clean([
            s.point,
            ...circuitRoute(a, b, obstacles, used, options.width, options.height),
            t.point,
          ])
        } catch {
          failed = edge
          break
        }
      }
      if (!valid(points)) {
        failed = edge
        break
      }
      edges.push({
        ...edge,
        memberIds: [edge.id],
        collector: false,
        sourceHandle: s.handle,
        targetHandle: t.handle,
        points,
      })
    }
    if (!failed) break
    order = [failed, ...order.filter((e) => e !== failed)]
    if (attempt === relations.length * 2 || tried.has(order.map((e) => e.id).join('|')))
      throw new Error(`Unroutable circuit relation ${failed.id}`)
  }
  if (edges.length !== relations.length) throw new Error('Incomplete circuit')
  const labels: HeaderRect[] = []
  for (const edge of edges)
    if (edge.label) {
      const width = edge.label.length * 12 + 20
      const candidates = edge.points.slice(1).flatMap((b, i) => {
        const a = edge.points[i]!
        return [0.5, 0.25, 0.75, 0, 1].flatMap((t) => {
          const mid = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
          return [24, 48, 32, 64, 88, 112].flatMap((d) =>
            a.x === b.x
              ? [0, 24, -24, 48, -48].flatMap((shift) => [
                  { x: mid.x + width / 2 + d, y: mid.y + shift },
                  { x: mid.x - width / 2 - d, y: mid.y + shift },
                ])
              : [0, 24, -24, 48, -48].flatMap((shift) => [
                  { x: mid.x + shift, y: mid.y - d },
                  { x: mid.x + shift, y: mid.y + d },
                ]),
          )
        })
      })
      const box = (p: HeaderPoint) => ({ x: p.x - width / 2, y: p.y - 12, width, height: 24 })
      edge.labelPoint = candidates.find((p) => {
        const r = box(p)
        return (
          r.x >= 8 &&
          r.y >= 40 &&
          r.x + r.width <= options.width - 8 &&
          r.y + 24 <= options.height - 8 &&
          ![...obstacles, ...labels].some((o) => rectOverlaps(r, o, 4)) &&
          !edges.some((e) => e.points.slice(1).some((b, i) => segmentHitsRect(e.points[i]!, b, r)))
        )
      })
      if (!edge.labelPoint) throw new Error(`No circuit label space for ${edge.id}`)
      labels.push(box(edge.labelPoint))
    }
  return edges
}
