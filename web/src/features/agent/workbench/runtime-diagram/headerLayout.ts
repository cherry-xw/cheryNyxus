import {
  HEADER_LAYERS,
  WORKFLOW_HEADER_TEMPLATE,
  type HeaderPoint,
  type HeaderPort,
  type HeaderNodePort,
} from './headerTemplate'
import { buildNestedHeader } from './headerNestedLayout'

export interface HeaderRect extends HeaderPoint {
  width: number
  height: number
}
export interface HeaderTerminal {
  relationId: string
  code: string
  source: string
  target: string
  peerNodeId: string
  boundary: boolean
  direction: 'in' | 'out'
  label: string
}
export interface VisibleHeaderItem extends HeaderRect {
  id: string
  parent?: string
  kind: 'group' | 'step' | 'terminal'
  collapsed?: boolean
  terminal?: HeaderTerminal
}
export interface VisibleHeaderEdge {
  id: string
  source: string
  target: string
  memberIds: string[]
  role: string
  label?: string
  collector?: boolean
  junction?: HeaderPoint
  sourceHandle: string
  targetHandle: string
  points: HeaderPoint[]
  labelPoint?: HeaderPoint
  labelAnchor?: HeaderPoint
}
export interface HeaderLayout {
  boardId: string
  width: number
  height: number
  items: VisibleHeaderItem[]
  edges: VisibleHeaderEdge[]
  representatives: Record<string, string>
  internalEdgeIds: string[]
  externalEdgeIds: string[]
  ports: Record<string, HeaderNodePort[]>
}
export const HEADER_BOARDS = ['overview', ...HEADER_LAYERS.map((layer) => layer.id)] as const
export function layerAncestors(id: string): string[] {
  const result: string[] = []
  let layer = HEADER_LAYERS.find((item) => item.id === id)
  while (layer) {
    result.push(layer.id)
    layer = HEADER_LAYERS.find((item) => item.id === layer!.parent)
  }
  return result
}
export function boardParent(id: string): string {
  return HEADER_LAYERS.find((layer) => layer.id === id)?.parent ?? 'overview'
}
export function boardTitle(id: string): string {
  return HEADER_LAYERS.find((layer) => layer.id === id)?.title ?? '封装总览'
}
export function boardPath(id: string): string[] {
  return ['overview', ...layerAncestors(id).reverse()]
}
export function headerGroupKey(headerId: string, layer: string): string {
  return `${headerId}:${layer}`
}
export function rectOverlaps(a: HeaderRect, b: HeaderRect, gap = 0): boolean {
  return (
    a.x < b.x + b.width + gap &&
    a.x + a.width + gap > b.x &&
    a.y < b.y + b.height + gap &&
    a.y + a.height + gap > b.y
  )
}
export function segmentHitsRect(a: HeaderPoint, b: HeaderPoint, r: HeaderRect): boolean {
  return a.x === b.x
    ? a.x > r.x &&
        a.x < r.x + r.width &&
        Math.max(a.y, b.y) > r.y &&
        Math.min(a.y, b.y) < r.y + r.height
    : a.y > r.y &&
        a.y < r.y + r.height &&
        Math.max(a.x, b.x) > r.x &&
        Math.min(a.x, b.x) < r.x + r.width
}
/** Includes T touches and corner contacts: unrelated nets may not touch. */
export function segmentsCross(
  a: HeaderPoint,
  b: HeaderPoint,
  c: HeaderPoint,
  d: HeaderPoint,
): boolean {
  const horizontal = a.y === b.y,
    otherHorizontal = c.y === d.y
  if (horizontal === otherHorizontal) {
    const axis = horizontal ? 'x' : 'y'
    if (horizontal ? a.y !== c.y : a.x !== c.x) return false
    return (
      Math.max(Math.min(a[axis], b[axis]), Math.min(c[axis], d[axis])) <=
      Math.min(Math.max(a[axis], b[axis]), Math.max(c[axis], d[axis]))
    )
  }
  const h = horizontal ? [a, b] : [c, d],
    v = horizontal ? [c, d] : [a, b]
  return (
    v[0]!.x >= Math.min(h[0]!.x, h[1]!.x) &&
    v[0]!.x <= Math.max(h[0]!.x, h[1]!.x) &&
    h[0]!.y >= Math.min(v[0]!.y, v[1]!.y) &&
    h[0]!.y <= Math.max(v[0]!.y, v[1]!.y)
  )
}

export interface BoardRelation {
  id: string
  source: string
  target: string
  role: string
  label?: string
}
export function relationTerminal(
  id: string,
  peerNodeId: string,
  boundary: boolean,
  direction: 'in' | 'out',
): HeaderTerminal {
  const index = WORKFLOW_HEADER_TEMPLATE.edges.findIndex((edge) => edge.id === id)
  const edge = WORKFLOW_HEADER_TEMPLATE.edges[index]!
  const title = (node: string) => WORKFLOW_HEADER_TEMPLATE.nodes.find((n) => n.id === node)!.title
  return {
    relationId: id,
    code: `P${String(index + 1).padStart(2, '0')}`,
    source: edge.source,
    target: edge.target,
    peerNodeId,
    boundary,
    direction,
    label: `${title(edge.source)} → ${title(edge.target)}${edge.label ? `（${edge.label}）` : ''}`,
  }
}
const cache = new Map<string, HeaderLayout>()
/** A board name expands its ancestry; explicit sets allow independent sibling packages. */
export function layoutHeader(expanded: readonly string[] | string = []): HeaderLayout {
  const layers = typeof expanded === 'string' ? layerAncestors(expanded) : expanded
  const normalized = HEADER_LAYERS.filter((layer) => layers.includes(layer.id)).map(
    (layer) => layer.id,
  )
  const key = normalized.join('|')
  let result = cache.get(key)
  if (!result) {
    result = buildNestedHeader(new Set(normalized))
    if (cache.size >= 64) cache.delete(cache.keys().next().value!)
    cache.set(key, result)
  }
  return result
}
export function portPoint(item: HeaderRect, side: HeaderPort, offset: number): HeaderPoint {
  return {
    x: item.x + (side === 'left' ? 0 : side === 'right' ? item.width : item.width / 2 + offset),
    y: item.y + (side === 'top' ? 0 : side === 'bottom' ? item.height : item.height / 2 + offset),
  }
}
