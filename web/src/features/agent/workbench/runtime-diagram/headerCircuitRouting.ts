import type { HeaderPoint } from './headerTemplate'
import { segmentHitsRect, segmentsCross, type HeaderRect } from './headerLayout'

/** Visibility search carries entering direction: crossings are forbidden and bends cost space. */
export function circuitRoute(
  start: HeaderPoint,
  end: HeaderPoint,
  obstacles: HeaderRect[],
  used: HeaderPoint[][],
  width: number,
  height: number,
): HeaderPoint[] {
  const segments = used.flatMap((line) => line.slice(1).map((b, i) => ({ a: line[i]!, b })))
  const xs = [
    ...new Set([
      start.x,
      end.x,
      16,
      width - 16,
      ...obstacles.flatMap((r) => [r.x - 16, r.x + r.width + 16]),
      ...segments.flatMap((s) => [s.a.x - 16, s.a.x + 16, s.b.x - 16, s.b.x + 16]),
    ]),
  ]
    .filter((x) => x >= 16 && x <= width - 16)
    .sort((a, b) => a - b)
  const ys = [
    ...new Set([
      start.y,
      end.y,
      16,
      height - 16,
      ...obstacles.flatMap((r) => [r.y - 16, r.y + r.height + 16]),
      ...segments.flatMap((s) => [s.a.y - 16, s.a.y + 16, s.b.y - 16, s.b.y + 16]),
    ]),
  ]
    .filter((y) => y >= 16 && y <= height - 16)
    .sort((a, b) => a - b)
  const index = (x: number, y: number) => y * xs.length + x
  const point = (id: number) => ({ x: xs[id % xs.length]!, y: ys[Math.floor(id / xs.length)]! })
  const first = index(xs.indexOf(start.x), ys.indexOf(start.y)),
    last = index(xs.indexOf(end.x), ys.indexOf(end.y))
  const distance = new Map<number, number>(),
    previous = new Map<number, number>()
  const queue: { id: number; score: number }[] = []
  function push(id: number, score: number) {
    let i = queue.length
    queue.push({ id, score })
    while (i > 0) {
      const p = (i - 1) >> 1
      if (queue[p]!.score <= score) break
      queue[i] = queue[p]!
      i = p
    }
    queue[i] = { id, score }
  }
  function pop() {
    const result = queue[0]!,
      tail = queue.pop()!
    if (queue.length) {
      let i = 0
      while (i * 2 + 1 < queue.length) {
        let c = i * 2 + 1
        if (c + 1 < queue.length && queue[c + 1]!.score < queue[c]!.score) c++
        if (queue[c]!.score >= tail.score) break
        queue[i] = queue[c]!
        i = c
      }
      queue[i] = tail
    }
    return result
  }
  for (const axis of [0, 1]) {
    distance.set(first * 2 + axis, 0)
    push(first * 2 + axis, Math.abs(start.x - end.x) + Math.abs(start.y - end.y))
  }
  const blocked = new Map<string, boolean>()
  while (queue.length) {
    const current = pop(),
      vertex = Math.floor(current.id / 2),
      a = point(vertex)
    if (current.score > distance.get(current.id)! + Math.abs(a.x - end.x) + Math.abs(a.y - end.y))
      continue
    if (vertex === last) {
      const result = [a]
      let id = current.id
      while (previous.has(id)) {
        id = previous.get(id)!
        result.unshift(point(Math.floor(id / 2)))
      }
      return result
    }
    const x = vertex % xs.length,
      y = Math.floor(vertex / xs.length)
    for (const [nx, ny, axis] of [
      [x - 1, y, 0],
      [x + 1, y, 0],
      [x, y - 1, 1],
      [x, y + 1, 1],
    ]) {
      if (nx! < 0 || ny! < 0 || nx! >= xs.length || ny! >= ys.length) continue
      const v = index(nx!, ny!),
        b = point(v),
        key = vertex < v ? `${vertex}:${v}` : `${v}:${vertex}`
      let hit = blocked.get(key)
      if (hit === undefined) {
        hit =
          obstacles.some((r) =>
            segmentHitsRect(a, b, {
              x: r.x - 6,
              y: r.y - 6,
              width: r.width + 12,
              height: r.height + 12,
            }),
          ) || segments.some((s) => segmentsCross(a, b, s.a, s.b))
        blocked.set(key, hit)
      }
      if (hit) continue
      const id = v * 2 + axis!,
        cost =
          distance.get(current.id)! +
          Math.abs(a.x - b.x) +
          Math.abs(a.y - b.y) +
          (axis !== current.id % 2 ? 48 : 0)
      if (cost >= (distance.get(id) ?? Infinity)) continue
      distance.set(id, cost)
      previous.set(id, current.id)
      push(id, cost + Math.abs(b.x - end.x) + Math.abs(b.y - end.y))
    }
  }
  throw new Error('No planar circuit route')
}
