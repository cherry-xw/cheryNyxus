import { HEADER_LAYERS, HEADER_NODE_SIZE, WORKFLOW_HEADER_TEMPLATE, headerHandleId, type HeaderPoint, type HeaderPort, type HeaderNodePort } from './headerTemplate'

export interface HeaderRect extends HeaderPoint { width: number; height: number }
export interface VisibleHeaderItem extends HeaderRect { id: string; parent?: string; kind: 'group' | 'step' | 'calls'; collapsed?: boolean }
export interface VisibleHeaderEdge {
  id: string; source: string; target: string; memberIds: string[]; role: string; label?: string
  collector?: boolean; junction?: HeaderPoint; sourceHandle: string; targetHandle: string; points: HeaderPoint[]; labelPoint?: HeaderPoint; labelAnchor?: HeaderPoint
}
export interface HeaderLayout {
  width: number; height: number; items: VisibleHeaderItem[]; edges: VisibleHeaderEdge[]
  representatives: Record<string, string>; internalEdgeIds: string[]; ports: Record<string, HeaderNodePort[]>
}
const W = HEADER_NODE_SIZE.width, H = HEADER_NODE_SIZE.height, GAP = 112, PAD = 56, TOP = 76
export const HEADER_ROOTS = ['intake', 'loop', 'compact', 'collaboration'] as const
export function layerAncestors(id: string): string[] {
  const result: string[] = []
  let layer = HEADER_LAYERS.find((item) => item.id === id)
  while (layer) { result.push(layer.id); layer = HEADER_LAYERS.find((item) => item.id === layer!.parent) }
  return result
}
export function headerGroupKey(headerId: string, layer: string): string { return `${headerId}:${layer}` }
export function resolveCollapsedLayers(input: { headerId: string; overrides?: Readonly<Record<string, boolean>>; active?: ReadonlySet<string>; follow?: boolean; protectedLayers?: ReadonlySet<string> }): Set<string> {
  const opened = new Set<string>()
  for (const layer of [...(input.active ?? []), ...(input.protectedLayers ?? [])])
    for (const ancestor of layerAncestors(layer)) opened.add(ancestor)
  return new Set(HEADER_LAYERS.filter((layer) => input.overrides?.[headerGroupKey(input.headerId, layer.id)] ?? (input.follow === true && !opened.has(layer.id))).map((layer) => layer.id))
}
export function rectOverlaps(a: HeaderRect, b: HeaderRect, gap = 0): boolean {
  return a.x < b.x + b.width + gap && a.x + a.width + gap > b.x && a.y < b.y + b.height + gap && a.y + a.height + gap > b.y
}
export function segmentHitsRect(a: HeaderPoint, b: HeaderPoint, r: HeaderRect): boolean {
  return a.x === b.x
    ? a.x > r.x && a.x < r.x + r.width && Math.max(a.y, b.y) > r.y && Math.min(a.y, b.y) < r.y + r.height
    : a.y > r.y && a.y < r.y + r.height && Math.max(a.x, b.x) > r.x && Math.min(a.x, b.x) < r.x + r.width
}
function clean(points: HeaderPoint[]): HeaderPoint[] {
  const result: HeaderPoint[] = []
  for (const p of points) {
    if (result.at(-1)?.x === p.x && result.at(-1)?.y === p.y) continue
    while (result.length > 1) {
      const a = result.at(-2)!, b = result.at(-1)!
      if ((a.x === b.x && b.x === p.x) || (a.y === b.y && b.y === p.y)) result.pop()
      else break
    }
    result.push(p)
  }
  return result
}
function route(start: HeaderPoint, end: HeaderPoint, obstacles: HeaderRect[], used: HeaderPoint[][], channel: number, boundary?: HeaderRect): HeaderPoint[] {
  const within = (p: HeaderPoint) => !boundary || (p.x >= boundary.x && p.x <= boundary.x + boundary.width && p.y >= boundary.y && p.y <= boundary.y + boundary.height)
  const clear = (a: HeaderPoint, b: HeaderPoint) => within(a) && within(b) && !obstacles.some((r) => segmentHitsRect(a, b, r))
  const xs = [...new Set([start.x, end.x, channel, ...(boundary ? [boundary.x, boundary.x + boundary.width] : []), ...used.flatMap(path => path.flatMap(p => [p.x - 12, p.x + 12])), ...obstacles.flatMap((r) => [r.x - 20, r.x + r.width + 20])])].sort((a, b) => a - b)
  const ys = [...new Set([start.y, end.y, channel, ...(boundary ? [boundary.y, boundary.y + boundary.height] : []), ...used.flatMap(path => path.flatMap(p => [p.y - 12, p.y + 12])), ...obstacles.flatMap((r) => [r.y - 20, r.y + r.height + 20])])].sort((a, b) => a - b)
  const penalty = (a: HeaderPoint, b: HeaderPoint): number => {
    let cost = Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
    for (const path of used) for (let i = 1; i < path.length; i++) {
      const c = path[i - 1]!, d = path[i]!
      const horizontal = a.y === b.y, otherHorizontal = c.y === d.y
      if (horizontal === otherHorizontal) {
        const axis = horizontal ? 'x' : 'y', same = horizontal ? a.y === c.y : a.x === c.x
        if (same && Math.min(Math.max(a[axis], b[axis]), Math.max(c[axis], d[axis])) > Math.max(Math.min(a[axis], b[axis]), Math.min(c[axis], d[axis]))) cost += 10000
      } else {
        const h1 = horizontal ? a : c, h2 = horizontal ? b : d, v1 = horizontal ? c : a, v2 = horizontal ? d : b
        if (v1.x >= Math.min(h1.x, h2.x) && v1.x <= Math.max(h1.x, h2.x) && h1.y >= Math.min(v1.y, v2.y) && h1.y <= Math.max(v1.y, v2.y)) cost += 12000
      }
    }
    return cost
  }
  let best: HeaderPoint[] | undefined, bestCost = Infinity
  const consider = (points: HeaderPoint[]) => {
    const p = clean(points)
    let cost = p.length * 36
    for (let i = 1; i < p.length; i++) { if (!clear(p[i - 1]!, p[i]!)) return; cost += penalty(p[i - 1]!, p[i]!) }
    if (cost < bestCost) { best = p; bestCost = cost }
  }
  for (const x of xs) consider([start, { x, y: start.y }, { x, y: end.y }, end])
  for (const y of ys) consider([start, { x: start.x, y }, { x: end.x, y }, end])
  if (best && bestCost < Math.abs(start.x - end.x) + Math.abs(start.y - end.y) + 1100) return best
  // ponytail: bounded header only; visibility-grid search is a fallback for obstructed three-segment routes.
  const cols = xs.length, count = cols * ys.length
  const startId = ys.indexOf(start.y) * cols + xs.indexOf(start.x), endId = ys.indexOf(end.y) * cols + xs.indexOf(end.x)
  const scores = new Float64Array(count).fill(Infinity), previous = new Int32Array(count).fill(-1)
  const heap: Array<{ id: number; score: number }> = []
  function push(id: number, score: number): void {
    let i = heap.length; heap.push({ id, score })
    while (i > 0) { const p = (i - 1) >> 1; if (heap[p]!.score <= score) break; heap[i] = heap[p]!; i = p }
    heap[i] = { id, score }
  }
  function pop(): { id: number; score: number } {
    const result = heap[0]!, last = heap.pop()!
    if (heap.length) {
      let i = 0
      while (i * 2 + 1 < heap.length) { let c = i * 2 + 1; if (c + 1 < heap.length && heap[c + 1]!.score < heap[c]!.score) c++; if (heap[c]!.score >= last.score) break; heap[i] = heap[c]!; i = c }
      heap[i] = last
    }
    return result
  }
  scores[startId] = 0; push(startId, 0)
  const point = (id: number) => ({ x: xs[id % cols]!, y: ys[Math.floor(id / cols)]! })
  while (heap.length) {
    const {id: current, score: queuedScore} = pop()
    if (queuedScore > scores[current]!) continue
    if (current === endId) {
      const result: HeaderPoint[] = []
      for (let id = current; id >= 0; id = previous[id]!) result.unshift(point(id))
      const candidate = clean(result)
      let cost = candidate.length * 36
      for (let i = 1; i < candidate.length; i++) cost += penalty(candidate[i - 1]!, candidate[i]!)
      return best && cost >= bestCost ? best : candidate
    }
    const x = current % cols, y = Math.floor(current / cols), a = point(current)
    const neighbors = [x > 0 ? current - 1 : -1, x + 1 < cols ? current + 1 : -1, y > 0 ? current - cols : -1, y + 1 < ys.length ? current + cols : -1]
    for (const id of neighbors) {
      if (id < 0) continue
      const b = point(id)
      if (!clear(a, b)) continue
      const prev = previous[current]! >= 0 ? point(previous[current]!) : undefined
      const bend = prev && ((prev.x === a.x) !== (a.x === b.x)) ? 36 : 0
      const score = scores[current]! + penalty(a, b) + bend
      if (score >= scores[id]!) continue
      scores[id] = score; previous[id] = current; push(id, score)
    }
  }
  if (best) return best
  throw new Error('No obstacle-free header route: ' + JSON.stringify({ start, end, blocked: obstacles.filter(r => (start.x > r.x && start.x < r.x+r.width && start.y > r.y && start.y < r.y+r.height) || (end.x > r.x && end.x < r.x+r.width && end.y > r.y && end.y < r.y+r.height)) }))
}
const cache = new Map<string, HeaderLayout>()
export function layoutHeader(collapsed: ReadonlySet<string> = new Set()): HeaderLayout {
  const key = HEADER_LAYERS.filter((g) => collapsed.has(g.id) && !layerAncestors(g.id).slice(1).some((id) => collapsed.has(id))).map((g) => g.id).join('|')
  const cached = cache.get(key)
  if (cached) return cached
  const items: VisibleHeaderItem[] = [], representatives: Record<string, string> = {}
  function build(id: string, x: number, y: number, parent?: string): HeaderRect {
    const layer = HEADER_LAYERS.find((g) => g.id === id)!
    const shell: VisibleHeaderItem = { id, x, y, ...HEADER_NODE_SIZE, kind: 'group', parent, collapsed: collapsed.has(id) }
    items.push(shell)
    if (shell.collapsed) {
      for (const node of WORKFLOW_HEADER_TEMPLATE.nodes) if (layerAncestors(node.group).includes(id)) representatives[node.id] = id
      return shell
    }
    const put = (nodeId: string, nx: number, ny: number) => {
      items.push({ id: nodeId, parent: id, x: nx, y: ny, ...HEADER_NODE_SIZE, kind: 'step' }); representatives[nodeId] = nodeId
    }
    layer.before.forEach((node, i) => put(node, x + PAD, y + TOP + i * (H + GAP)))
    const centerX = x + PAD + (layer.before.length ? W + GAP : 0)
    let centerWidth = 0, centerHeight = 0
    if (layer.child) { const child = build(layer.child, centerX, y + TOP, id); centerWidth = child.width; centerHeight = child.height }
    if (layer.center?.length) {
      centerWidth = id === 'model-layer' ? 280 : W
      let offset = 0
      for (const node of layer.center) { put(node, centerX, y + TOP + offset); offset += H + GAP + (node === 'model' ? 196 : 0) }
      centerHeight = offset - GAP
    }
    const afterX = centerX + centerWidth + (centerWidth && layer.after.length ? GAP : 0)
    const afterOffset = id === 'retry-layer' ? H + GAP : 0
    layer.after.forEach((row, r) => row.forEach((node, c) => { if (node) put(node, afterX + c * (W + GAP), y + TOP + afterOffset + r * (H + GAP)) }))
    const afterWidth = layer.after.length ? Math.max(...layer.after.map((r) => r.length)) * (W + GAP) - GAP : 0
    let afterHeight = afterOffset + layer.after.length * (H + GAP) - GAP
    if (id === 'tools') {
      items.push({ id: 'calls', parent: id, kind: 'calls', x: afterX, y: y + TOP + afterHeight + GAP, width: afterWidth, height: 228 })
      afterHeight += GAP + 228
    }
    shell.width = afterX - x + afterWidth + PAD
    shell.height = TOP + Math.max(centerHeight, layer.before.length * (H + GAP) - GAP, afterHeight, H) + PAD
    return shell
  }
  const intake = build('intake', 64, 144)
  const loop = build('loop', intake.x + intake.width + 96, 144)
  const compact = build('compact', loop.x + 72, loop.y + loop.height + 112)
  const collaboration = build('collaboration', Math.max(compact.x + compact.width + 112, items.find(n => n.id === 'execution')?.x ?? loop.x + loop.width - 320), compact.y)
  const ports: Record<string, HeaderNodePort[]> = {}, internalEdgeIds: string[] = []
  const mapped = new Map<string, { source: string; target: string; role: string; label?: string; memberIds: string[] }>()
  for (const edge of WORKFLOW_HEADER_TEMPLATE.edges) {
    const source = representatives[edge.source]!, target = representatives[edge.target]!
    if (source === target) { internalEdgeIds.push(edge.id); continue }
    const edgeKey = `${source}:${target}:${edge.role}`
    const prior = mapped.get(edgeKey)
    if (prior) { prior.memberIds.push(edge.id); if (prior.label !== edge.label) prior.label = '多条关联' }
    else mapped.set(edgeKey, { source, target, role: edge.role, label: edge.label, memberIds: [edge.id] })
  }
  const byId = new Map(items.map((item) => [item.id, item]))
  const specs = [...mapped.entries()].map(([id, edge]) => {
    const s = byId.get(edge.source)!, t = byId.get(edge.target)!
    const forward = t.x >= s.x + s.width
    const vertical = Math.abs(t.x - s.x) < W / 2 && s.id !== 'model'
    let sourceSide: HeaderPort = vertical ? t.y > s.y ? 'bottom' : 'top' : forward ? 'right' : 'left'
    let targetSide: HeaderPort = vertical ? t.y > s.y ? 'top' : 'bottom' : forward ? 'left' : 'right'
    if (edge.target === 'rejection') { sourceSide = 'bottom'; targetSide = 'bottom' }
    if (edge.source === 'approval' && edge.target === 'preflight') { sourceSide = 'right'; targetSide = 'bottom' }
    if (edge.source === 'execution' && edge.target === 'dispatch') { sourceSide = 'top'; targetSide = 'right' }
    if (edge.source === 'parent-receive' && edge.target === 'input') { sourceSide = 'left'; targetSide = 'left' }
    if (edge.source === 'response' && edge.target === 'checkpoint') { sourceSide = 'top'; targetSide = 'top' }
    if (edge.source === 'resume' && edge.target === 'tool-result') { sourceSide = 'left'; targetSide = 'right' }
    if (edge.source === 'rejection' && edge.target === 'tool-result') { sourceSide = 'top'; targetSide = 'bottom' }
    if (edge.source === 'resume') { sourceSide = edge.target === 'tool-list' ? 'top' : 'bottom'; targetSide = 'bottom' }
    if (edge.role === 'loop' && edge.target === 'entry') { sourceSide = 'top'; targetSide = 'top' }
    if (edge.source === 'wait' && edge.target === 'wake') { sourceSide = 'bottom'; targetSide = 'bottom' }
    if (edge.role === 'compact' && ['request', 'compact-applied'].includes(edge.source)) { sourceSide = 'bottom'; targetSide = 'bottom' }
    return { id, ...edge, sourceSide, targetSide }
  })
  const ends = specs.flatMap((edge) => [
    { edge, node: edge.source, side: edge.sourceSide, type: 'source' as const, other: edge.target },
    { edge, node: edge.target, side: edge.targetSide, type: 'target' as const, other: edge.source },
  ])
  const endpoint = new Map<string, { point: HeaderPoint; escape: HeaderPoint; handle: string }>()
  for (const item of items) for (const side of ['left', 'right', 'top', 'bottom'] as const) {
    const list = ends.filter((end) => end.node === item.id && end.side === side).sort((a, b) => {
      const axis = side === 'left' || side === 'right' ? 'y' : 'x'
      return byId.get(a.other)![axis] - byId.get(b.other)![axis] || a.edge.id.localeCompare(b.edge.id) || a.type.localeCompare(b.type)
    })
    list.forEach((end, index) => {
      const length = side === 'left' || side === 'right' ? item.height : item.width
      const offset = end.node === 'rejection' && end.type === 'target' ? 0 : Math.round((index - (list.length - 1) / 2) * Math.min(14, (length - 24) / Math.max(1, list.length - 1)))
      const handle = headerHandleId(end.type === 'source' ? 'out' : 'in', side, offset)
      const point = side === 'left' || side === 'right' ? { x: item.x + (side === 'right' ? item.width : 0), y: item.y + item.height / 2 + offset } : { x: item.x + item.width / 2 + offset, y: item.y + (side === 'bottom' ? item.height : 0) }
      const escape = { x: point.x + (side === 'left' ? -24 : side === 'right' ? 24 : 0), y: point.y + (side === 'top' ? -24 : side === 'bottom' ? 24 : 0) }
      ;(ports[item.id] ??= []).push({ id: handle, type: end.type, side, offset })
      endpoint.set(`${end.edge.id}:${end.type}`, { point, escape, handle })
    })
  }
  const obstacles: HeaderRect[] = items.filter((item) => item.kind !== 'group' || item.collapsed).map((item) => ({ x: item.x - 8, y: item.y - 8, width: item.width + 16, height: item.height + 16 }))
  for (const item of items.filter((item) => item.kind === 'group' && !item.collapsed)) obstacles.push({ x: item.x, y: item.y, width: item.width, height: 48 })
  // Reserve the live preview even before a token arrives so streaming never changes geometry.
  const model = byId.get('model')
  if (model?.kind === 'step') obstacles.push({ x: model.x, y: model.y + H + 8, width: 280, height: 180 })
  const used: HeaderPoint[][] = [...endpoint.values()].map(end => [end.point, end.escape])
  const edges: VisibleHeaderEdge[] = []
  const groupFor = (id: string) => byId.get(id)?.kind === 'group' ? HEADER_LAYERS.find(g => g.id === id)?.parent : byId.get(id)?.parent
  const commonGroup = (source: string, target: string) => {
    const s = groupFor(source), t = groupFor(target)
    return s && t ? layerAncestors(s).find(id => layerAncestors(t).includes(id)) : undefined
  }
  const depth = (source: string, target: string) => { const id = commonGroup(source, target); return id ? layerAncestors(id).length : 0 }
  specs.sort((a, b) => Number(b.target === 'rejection') - Number(a.target === 'rejection') || depth(b.source, b.target) - depth(a.source, a.target) ||
    (Math.abs(byId.get(a.source)!.x - byId.get(a.target)!.x) + Math.abs(byId.get(a.source)!.y - byId.get(a.target)!.y)) -
    (Math.abs(byId.get(b.source)!.x - byId.get(b.target)!.x) + Math.abs(byId.get(b.source)!.y - byId.get(b.target)!.y)))
  for (const [index, spec] of specs.entries()) {
    const s = endpoint.get(`${spec.id}:source`)!, t = endpoint.get(`${spec.id}:target`)!
    const common = commonGroup(spec.source, spec.target)
    const box = common ? byId.get(common) : undefined
    const boundary = box ? { x: box.x + 12, y: box.y + 52, width: box.width - 24, height: box.height - 64 } : undefined
    const collector = spec.target === 'rejection' && byId.has('calls')
    const busY = (byId.get('calls')?.y ?? 0) - 44
    const path = collector
      ? [s.escape, { x: s.escape.x, y: busY }, { x: t.escape.x, y: busY }, t.escape]
      : route(s.escape, t.escape, obstacles, used, 32 + index * 3, boundary)
    const points = clean([s.point, ...path, t.point]); used.push(points)
    const labelObstacles = obstacles.map(r => r.height === 48 ? { ...r, width: Math.min(r.width, 420) } : r)
    let labelPoint: HeaderPoint | undefined, labelAnchor: HeaderPoint | undefined
    if (spec.label) {
      const width = spec.label.length * 12 + 20
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1]!, b = points[i]!
        if (a.y === b.y ? Math.abs(a.x - b.x) < width + 24 : Math.abs(a.y - b.y) < 48) continue
        const p = { x: (a.x + b.x) / 2, y: a.y }
        const box = { x: p.x - width / 2, y: p.y - 12, width, height: 24 }
        if (labelObstacles.some((r) => rectOverlaps(box, r, 4))) continue
        if ([...endpoint.values()].some((end) => segmentHitsRect(end.point, end.escape, box))) continue
        if (used.slice(0, -1).some((line) => line.slice(1).some((end, j) => segmentHitsRect(line[j]!, end, box)))) continue
        labelPoint = p; obstacles.push(box); break
      }
    }
    if (spec.label && !labelPoint) {
      const width = spec.label.length * 12 + 20
      outer: for (let i = 1; i < points.length; i++) {
        const a = points[i - 1]!, b = points[i]!
        if (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) < 40) continue
        for (const fraction of [0.5, 0.25, 0.75]) for (const side of [-1, 1]) {
          const anchor = { x: a.x + (b.x - a.x) * fraction, y: a.y + (b.y - a.y) * fraction }
          const p = a.x === b.x ? { x: anchor.x + side * (width / 2 + 14), y: anchor.y } : { x: anchor.x, y: anchor.y + side * 26 }
          const labelBox = { x: p.x - width / 2, y: p.y - 12, width, height: 24 }
          if (labelBox.x < 8 || labelBox.y < 80 || labelObstacles.some(r => rectOverlaps(labelBox, r, 4))) continue
          if (used.some(line => line.slice(1).some((end, j) => segmentHitsRect(line[j]!, end, labelBox)))) continue
          const leaderEnd = a.x === b.x ? { x: p.x - side * width / 2, y: p.y } : { x: p.x, y: p.y - side * 12 }
          if (labelObstacles.some(r => segmentHitsRect(anchor, leaderEnd, r))) continue
          labelPoint = p; labelAnchor = anchor; obstacles.push(labelBox); break outer
        }
      }
    }
    edges.push({ ...spec, collector, junction: collector ? { x: s.escape.x, y: busY } : undefined, sourceHandle: s.handle, targetHandle: t.handle, points, labelPoint, labelAnchor })
  }
  const layout = { width: Math.max(loop.x + loop.width, collaboration.x + collaboration.width) + 80, height: Math.max(compact.y + compact.height, collaboration.y + collaboration.height, intake.y + intake.height) + 80, items, edges, ports, representatives, internalEdgeIds }
  if (cache.size >= 40) cache.delete(cache.keys().next().value!)
  cache.set(key, layout)
  return layout
}




