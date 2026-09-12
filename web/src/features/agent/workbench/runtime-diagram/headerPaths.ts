import type { HeaderPoint } from './headerTemplate'

/** Interruptible layout paths keep their first and last segments orthogonal to moving handles. */
export function moveHeaderPath(
  points: readonly HeaderPoint[],
  source: HeaderPoint,
  target: HeaderPoint,
): HeaderPoint[] {
  if (points.length < 2) return []
  if (points.length === 2) {
    if (points[0]!.x === points[1]!.x) {
      const mid = (source.y + target.y) / 2
      return [source, { x: source.x, y: mid }, { x: target.x, y: mid }, target]
    }
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
