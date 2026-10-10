import type { ExecutionNode } from '../graph/executionGraph'
import { hasNodeHoverDetail, skinKeyForNode, type NodeSkinKey } from '../graph/nodeSkins'

export const PAPER_VISIBLE_HISTORY = 7
export const PAPER_VISIBLE_FUTURE = 4
export const PAPER_MAX_BUNDLE_DEPTH = 10
export const PAPER_ADAPTIVE_HISTORY_LIMIT = 14
export const PAPER_ADAPTIVE_FUTURE_LIMIT = 6
export const PAPER_TITLE_HEIGHT = 43
export const PAPER_TITLE_CLICK_GAP = 28
export const PAPER_BUNDLE_ENTRY_GAP = 16
/** The deepest decorative bundle page must stay at least this far above the rail bottom. */
export const PAPER_BUNDLE_BOTTOM_GAP = 15

export interface PaperScatter {
  x: number
  y: number
  rotation: number
}

export interface PaperStackEntry {
  id: string
  node: ExecutionNode
  title: string
  skin: NodeSkinKey
  scatter: PaperScatter
}

export interface PaperRenderWindow {
  start: number
  end: number
  indices: number[]
}

export type PaperTemporalRole = 'history' | 'current' | 'future'

export interface PaperNodeLayer {
  kind: 'node'
  index: number
  role: PaperTemporalRole
  distance: number
  opacity: number
}

export interface PaperBundleLayer {
  kind: 'bundle'
  role: Exclude<PaperTemporalRole, 'current'>
  hiddenCount: number
  depth: number
  distance: number
}

export type PaperStackLayer = PaperNodeLayer | PaperBundleLayer

export interface PaperTitleLayerPlacement {
  offset: number
  bundlePageSpan: number
}

export interface PaperVisibleLimits {
  history: number
  future: number
}

export interface PaperPlacement extends PaperScatter {
  scale: number
}

function comparePaperNodes(a: ExecutionNode, b: ExecutionNode): number {
  const aOrder = a.orderKey ?? Number.MAX_SAFE_INTEGER
  const bOrder = b.orderKey ?? Number.MAX_SAFE_INTEGER
  return aOrder - bOrder || a.createdAt - b.createdAt || a.id.localeCompare(b.id)
}

function hashNodeId(id: string): number {
  let hash = 2166136261
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function signedUnit(value: number): number {
  return ((value % 2001) - 1000) / 1000
}

/** Stable visual offsets prevent cards from jumping when live nodes are appended. */
export function paperScatterForId(id: string): PaperScatter {
  const hash = hashNodeId(id)
  return {
    x: Math.round(signedUnit(hash) * 4),
    y: Math.round(signedUnit(hash >>> 7) * 4),
    rotation: Math.round(signedUnit(hash >>> 13) * 20) / 10,
  }
}

/**
 * A paper's resting pose only depends on its stable ID scatter. Reading another
 * paper never moves the remaining chronology into a separate "removed" pile.
 */
export function paperPlacement(scatter: PaperScatter): PaperPlacement {
  return {
    x: scatter.x,
    y: scatter.y,
    rotation: scatter.rotation,
    scale: 1,
  }
}

/** Older papers sit below newer papers regardless of the current selection. */
export function paperChronologicalLayer(index: number): number {
  return Math.max(0, index) + 1
}

/** Nearby titles expose the largest click band; density increases slowly outward. */
export function paperTitleReadableGap(distance: number): number {
  return Math.max(PAPER_TITLE_CLICK_GAP, 34 - Math.floor(Math.max(0, distance - 1) / 2))
}

function paperBundleGapWeight(gapIndex: number): number {
  return Math.max(3, 10 - gapIndex)
}

export function paperBundlePreferredPageSpan(depth: number): number {
  let span = 0
  for (let gapIndex = 0; gapIndex < Math.max(0, depth - 1); gapIndex += 1) {
    span += paperBundleGapWeight(gapIndex)
  }
  return span
}

/** Deterministic per-page horizontal drift so the pile reads as layered, not aligned. */
export function paperBundleJitter(paperIndex: number): number {
  return Math.round(signedUnit((paperIndex + 1) * 7919) * 6)
}

export function paperBundlePageOffset(
  paperIndex: number,
  depth: number,
  availableSpan: number,
): number {
  if (depth <= 1 || paperIndex <= 0) return 0
  const preferredSpan = paperBundlePreferredPageSpan(depth)
  if (preferredSpan <= 0) return 0
  let preferredOffset = 0
  for (let gapIndex = 0; gapIndex < Math.min(paperIndex, depth - 1); gapIndex += 1) {
    preferredOffset += paperBundleGapWeight(gapIndex)
  }
  return Math.round((preferredOffset / preferredSpan) * Math.max(0, availableSpan))
}

export function paperVisibleLimits(
  length: number,
  currentIndex: number,
  railHeight: number,
): PaperVisibleLimits {
  if (length <= 1) return { history: 0, future: 0 }
  const current = Math.min(length - 1, Math.max(0, currentIndex))
  const availableHistory = current
  const availableFuture = length - current - 1
  let history = Math.min(availableHistory, PAPER_ADAPTIVE_HISTORY_LIMIT)
  let future = Math.min(availableFuture, PAPER_ADAPTIVE_FUTURE_LIMIT)
  const maxOffset = Math.max(0, Math.floor(railHeight) - PAPER_TITLE_HEIGHT)
  const preferredSpan = (): number =>
    paperStackLayers(length, current, history, future)
      .slice(1)
      .reduce((total, layer) => total + titleLayerPreferredGap(layer), 0)

  while (preferredSpan() > maxOffset && (history > 0 || future > 0)) {
    if (history > future && history > 0) history -= 1
    else if (future > 0) future -= 1
    else history -= 1
  }
  return { history, future }
}

function titleLayerPreferredGap(layer: PaperStackLayer): number {
  return layer.kind === 'node' ? paperTitleReadableGap(layer.distance) : PAPER_BUNDLE_ENTRY_GAP
}

/**
 * Fits the newest-to-oldest rail between the reader's real top and bottom edges.
 * Readable node gaps keep their click bands; only the decorative bundle span
 * flexes to consume the remaining space and visually reach the edge.
 */
export function paperTitleLayerPlacements(
  layers: readonly PaperStackLayer[],
  railHeight: number,
): PaperTitleLayerPlacement[] {
  if (!layers.length) return []
  const maxOffset = Math.max(0, Math.floor(railHeight) - PAPER_TITLE_HEIGHT)
  if (layers.length === 1) return [{ offset: Math.round(maxOffset / 2), bundlePageSpan: 0 }]

  const preferredGaps = layers.slice(1).map(titleLayerPreferredGap)
  const preferredTotal = preferredGaps.reduce((total, gap) => total + gap, 0)
  const gapScale = preferredTotal > maxOffset && preferredTotal > 0 ? maxOffset / preferredTotal : 1
  const fittedGaps = preferredGaps.map((gap) => gap * gapScale)
  const spareSpan = Math.max(0, maxOffset - fittedGaps.reduce((total, gap) => total + gap, 0))
  // Only the future bundle's downstream gap flexes to consume spare space. The
  // history bundle stays anchored to its last readable node and instead absorbs
  // the remaining room through its own downward page span.
  const expandableGapIndices = layers.flatMap((layer, index) => {
    if (layer.kind !== 'bundle') return []
    if (layer.role === 'future' && index < layers.length - 1) return [index]
    return []
  })
  const targetGapIndices = expandableGapIndices.length
    ? expandableGapIndices
    : fittedGaps.map((_, index) => index)
  for (const gapIndex of targetGapIndices) {
    fittedGaps[gapIndex] = fittedGaps[gapIndex]! + spareSpan / targetGapIndices.length
  }

  const offsets: number[] = [0]
  for (const gap of fittedGaps) offsets.push(offsets.at(-1)! + gap)

  return layers.map((layer, index) => {
    const offset = Math.round(offsets[index]!)
    if (layer.kind !== 'bundle') return { offset, bundlePageSpan: 0 }
    if (layer.role === 'future') {
      const span = Math.max(0, (offsets[index + 1] ?? railHeight) - offsets[index]!)
      const clamped = Math.max(
        0,
        Math.min(span, Math.max(0, railHeight - PAPER_BUNDLE_BOTTOM_GAP - offset)),
      )
      return { offset, bundlePageSpan: Math.round(clamped) }
    }
    // History bundle hugs the last readable node, then extends to the bottom margin.
    const anchor = Math.round((offsets[index - 1] ?? 0) + PAPER_BUNDLE_ENTRY_GAP)
    const span = Math.max(0, railHeight - PAPER_BUNDLE_BOTTOM_GAP - anchor)
    return { offset: anchor, bundlePageSpan: Math.round(span) }
  })
}

export function buildPaperStack(
  nodes: readonly ExecutionNode[],
  titleForNode: (node: ExecutionNode) => string,
): PaperStackEntry[] {
  return nodes
    .filter(hasNodeHoverDetail)
    .slice()
    .sort(comparePaperNodes)
    .map((node) => ({
      id: node.id,
      node,
      title: titleForNode(node).trim(),
      skin: skinKeyForNode(node),
      scatter: paperScatterForId(node.id),
    }))
}

export function paperRenderWindow(
  length: number,
  currentIndex: number,
  before = PAPER_VISIBLE_HISTORY,
  after = PAPER_VISIBLE_FUTURE,
): PaperRenderWindow {
  if (length <= 0) return { start: 0, end: -1, indices: [] }
  const current = Math.min(length - 1, Math.max(0, currentIndex))
  const start = Math.max(0, current - before)
  const end = Math.min(length - 1, current + after)
  return {
    start,
    end,
    indices: Array.from({ length: end - start + 1 }, (_, offset) => start + offset),
  }
}

/**
 * Builds a bounded title rail from newest (top) to oldest (bottom). Nearby
 * papers remain readable while remote chronology collapses into a decorative
 * bundle at the corresponding chronological end.
 */
export function paperStackLayers(
  length: number,
  currentIndex: number,
  historyLimit = PAPER_VISIBLE_HISTORY,
  futureLimit = PAPER_VISIBLE_FUTURE,
  maxBundleDepth = PAPER_MAX_BUNDLE_DEPTH,
): PaperStackLayer[] {
  if (length <= 0) return []
  const current = Math.min(length - 1, Math.max(0, currentIndex))
  const historyStart = Math.max(0, current - historyLimit)
  const futureEnd = Math.min(length - 1, current + futureLimit)
  const layers: PaperStackLayer[] = []

  const hiddenFuture = length - futureEnd - 1
  if (hiddenFuture > 0) {
    layers.push({
      kind: 'bundle',
      role: 'future',
      hiddenCount: hiddenFuture,
      depth: Math.min(maxBundleDepth, hiddenFuture),
      distance: futureEnd - current + 1,
    })
  }

  for (let index = futureEnd; index > current; index -= 1) {
    const distance = index - current
    layers.push({
      kind: 'node',
      index,
      role: 'future',
      distance,
      opacity: Math.round(Math.max(0.18, 0.58 - Math.max(0, distance - 1) * 0.12) * 100) / 100,
    })
  }

  layers.push({ kind: 'node', index: current, role: 'current', distance: 0, opacity: 1 })

  for (let index = current - 1; index >= historyStart; index -= 1) {
    const distance = current - index
    layers.push({
      kind: 'node',
      index,
      role: 'history',
      distance,
      opacity: Math.max(0.68, 1 - Math.max(0, distance - 1) * 0.045),
    })
  }

  const hiddenHistory = historyStart
  if (hiddenHistory > 0) {
    layers.push({
      kind: 'bundle',
      role: 'history',
      hiddenCount: hiddenHistory,
      depth: Math.min(maxBundleDepth, hiddenHistory),
      distance: current - historyStart + 1,
    })
  }

  return layers
}
