export interface CrtPoint {
  x: number
  y: number
}

export interface CrtSize {
  width: number
  height: number
}

export interface CrtLayoutInput {
  id: string
  anchor: CrtPoint
  panel: CrtSize
  main: boolean
  actionable: boolean
  pinned?: boolean
  order: number
  /** Optional panel-local Y coordinate for the anchor line endpoint. */
  lineTargetOffsetY?: number
}

export interface CrtPlacement extends CrtLayoutInput {
  left: number
  top: number
  placement: 'left' | 'right'
  line: { from: CrtPoint; to: CrtPoint }
}

export interface CrtViewport extends CrtSize {
  margin?: number
}

const GAP = 34
const COLLISION_GAP = 10

function overlaps(
  a: { left: number; top: number; width: number; height: number },
  b: { left: number; top: number; width: number; height: number },
): boolean {
  return !(
    a.left + a.width + COLLISION_GAP <= b.left ||
    b.left + b.width + COLLISION_GAP <= a.left ||
    a.top + a.height + COLLISION_GAP <= b.top ||
    b.top + b.height + COLLISION_GAP <= a.top
  )
}

function containsAnchor(
  rect: { left: number; top: number; width: number; height: number },
  anchor: CrtPoint,
): boolean {
  const pad = 22
  return (
    anchor.x >= rect.left - pad &&
    anchor.x <= rect.left + rect.width + pad &&
    anchor.y >= rect.top - pad &&
    anchor.y <= rect.top + rect.height + pad
  )
}

function verticalOffsets(limit: number): number[] {
  const values = [0]
  for (let offset = 36; offset <= limit; offset += 36) values.push(offset, -offset)
  return values
}

/** Actionable cards are never hidden; passive cards are capped and aggregated by the caller. */
export function selectVisibleCrtIds(
  cards: readonly Pick<CrtLayoutInput, 'id' | 'actionable' | 'pinned' | 'order'>[],
  passiveLimit = 6,
): { visible: Set<string>; hiddenPassive: number } {
  const actionable = cards.filter((card) => card.actionable || card.pinned)
  const passive = cards
    .filter((card) => !card.actionable && !card.pinned)
    .sort((a, b) => b.order - a.order || a.id.localeCompare(b.id))
  const selected = [...actionable, ...passive.slice(0, passiveLimit)]
  return {
    visible: new Set(selected.map((card) => card.id)),
    hiddenPassive: Math.max(0, passive.length - passiveLimit),
  }
}

/** Deterministic anchored layout: outward branch placement, staggered main line, then least displacement. */
export function layoutAnchoredCrts(
  cards: readonly CrtLayoutInput[],
  viewport: CrtViewport,
): CrtPlacement[] {
  const margin = viewport.margin ?? 12
  const anchors = cards.map((card) => card.anchor)
  const placed: CrtPlacement[] = []
  const mainCards = cards.filter((card) => card.main).sort((a, b) => a.order - b.order)
  const mainIndex = new Map(mainCards.map((card, index) => [card.id, index]))
  const ordered = cards.slice().sort(
    (a, b) =>
      Number(b.actionable) - Number(a.actionable) ||
      Number(b.pinned) - Number(a.pinned) ||
      a.order - b.order ||
      a.id.localeCompare(b.id),
  )

  for (const card of ordered) {
    const preferred: 'left' | 'right' = card.main
      ? (mainIndex.get(card.id) ?? 0) % 2 === 0
        ? 'right'
        : 'left'
      : card.anchor.x < viewport.width / 2
        ? 'left'
        : 'right'
    const sides: Array<'left' | 'right'> = [preferred, preferred === 'left' ? 'right' : 'left']
    let best:
      | { left: number; top: number; placement: 'left' | 'right'; penalty: number }
      | undefined
    for (const placement of sides) {
      for (const dy of verticalOffsets(viewport.height)) {
        const rawLeft =
          placement === 'right'
            ? card.anchor.x + GAP
            : card.anchor.x - GAP - card.panel.width
        const rawTop = card.anchor.y - card.panel.height / 2 + dy
        const left = Math.max(margin, Math.min(viewport.width - card.panel.width - margin, rawLeft))
        const top = Math.max(margin, Math.min(viewport.height - card.panel.height - margin, rawTop))
        const rect = { left, top, ...card.panel }
        const collisions = placed.filter((other) =>
          overlaps(rect, { left: other.left, top: other.top, ...other.panel }),
        ).length
        const coveredAnchors = anchors.filter((anchor) => containsAnchor(rect, anchor)).length
        const penalty =
          collisions * 100_000 +
          coveredAnchors * 20_000 +
          Math.abs(dy) * 10 +
          (placement === preferred ? 0 : 2_000) +
          Math.abs(left - rawLeft) +
          Math.abs(top - rawTop)
        if (!best || penalty < best.penalty) best = { left, top, placement, penalty }
        if (penalty === 0) break
      }
    }
    if (!best) continue
    const edgeX = best.placement === 'right' ? best.left : best.left + card.panel.width
    const edgeY =
      card.lineTargetOffsetY === undefined
        ? Math.max(best.top + 18, Math.min(best.top + card.panel.height - 18, card.anchor.y))
        : best.top + Math.max(0, Math.min(card.panel.height, card.lineTargetOffsetY))
    placed.push({
      ...card,
      left: best.left,
      top: best.top,
      placement: best.placement,
      line: { from: card.anchor, to: { x: edgeX, y: edgeY } },
    })
  }
  return placed
}
