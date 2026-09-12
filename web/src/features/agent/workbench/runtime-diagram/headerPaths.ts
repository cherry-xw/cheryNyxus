import type { HeaderPoint } from './headerTemplate'

/** Interruptible layout paths keep their first and last segments orthogonal to moving handles. */
export function moveHeaderPath(
  points: readonly HeaderPoint[],
  source: HeaderPoint,
  target: HeaderPoint,
): HeaderPoint[] {
  if (points.length < 2) return []
  if (points.length === 2) {
    const mid = (source.x + target.x) / 2
    return [source, { x: mid, y: source.y }, { x: mid, y: target.y }, target]
  }
  const result = points.map((p) => ({ ...p }))
  const first = points[0]!,
    last = points.at(-1)!
  result[0] = source
  result[result.length - 1] = target
  if (points[1]!.x === first.x) result[1]!.x = source.x
  else result[1]!.y = source.y
  if (points.at(-2)!.x === last.x) result[result.length - 2]!.x = target.x
  else result[result.length - 2]!.y = target.y
  const orthogonal: HeaderPoint[] = []
  for (const point of result) {
    const previous = orthogonal.at(-1)
    if (previous && previous.x !== point.x && previous.y !== point.y)
      orthogonal.push({ x: point.x, y: previous.y })
    orthogonal.push(point)
  }
  return orthogonal
}
export function headerPathString(points: readonly HeaderPoint[]): string {
  return points.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ')
}
/** A break marks a crossing, never a junction. Earlier routes remain continuous. */
export function headerCrossingPath(
  points: readonly HeaderPoint[],
  previousPaths: readonly (readonly HeaderPoint[])[],
): string {
  const commands: string[] = points.length ? [`M ${points[0]!.x} ${points[0]!.y}`] : []
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!,
      b = points[i]!,
      horizontal = a.y === b.y,
      axis = horizontal ? 'x' : 'y'
    const cuts = new Set<number>()
    for (const other of previousPaths)
      for (let j = 1; j < other.length; j++) {
        const c = other[j - 1]!,
          d = other[j]!
        if (horizontal === (c.y === d.y)) continue
        const x = horizontal ? c.x : a.x,
          y = horizontal ? a.y : c.y
        if (
          x > Math.min(a.x, b.x) &&
          x < Math.max(a.x, b.x) &&
          y > Math.min(c.y, d.y) &&
          y < Math.max(c.y, d.y) &&
          horizontal
        )
          cuts.add(x)
        if (
          !horizontal &&
          y > Math.min(a.y, b.y) &&
          y < Math.max(a.y, b.y) &&
          x > Math.min(c.x, d.x) &&
          x < Math.max(c.x, d.x)
        )
          cuts.add(y)
      }
    const direction = Math.sign(b[axis] - a[axis])
    for (const cut of [...cuts].sort((x, y) => (x - y) * direction)) {
      if (Math.abs(cut - a[axis]) < 7 || Math.abs(b[axis] - cut) < 7) continue
      commands.push(
        horizontal
          ? `L ${cut - direction * 4} ${a.y} M ${cut + direction * 4} ${a.y}`
          : `L ${a.x} ${cut - direction * 4} M ${a.x} ${cut + direction * 4}`,
      )
    }
    commands.push(`L ${b.x} ${b.y}`)
  }
  return commands.join(' ')
}
