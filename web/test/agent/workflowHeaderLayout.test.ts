import { describe, expect, it } from 'vitest'
import {
  HEADER_BOARDS,
  boardParent,
  boardPath,
  layoutHeader,
  portPoint,
  rectOverlaps,
  segmentHitsRect,
  segmentsCross,
} from '../../src/features/agent/workbench/runtime-diagram/headerLayout'
import { WORKFLOW_HEADER_TEMPLATE as template } from '../../src/features/agent/workbench/runtime-diagram/headerTemplate'
import { boardZoomIntent } from '../../src/features/agent/workbench/runtime-diagram/useHeaderBoardNavigation'

describe('recursive circuit packages', () => {
  for (const board of HEADER_BOARDS)
    it(`${board}: conserves relations and routes isolated single-layer nets`, () => {
      const graph = layoutHeader(board)
      const visible = [...new Set(graph.edges.flatMap((edge) => edge.memberIds))]
      expect([...visible, ...graph.internalEdgeIds, ...graph.externalEdgeIds].sort()).toEqual(
        template.edges.map((edge) => edge.id).sort(),
      )
      for (const [i, item] of graph.items.entries()) {
        expect([item.x, item.y, item.width, item.height].every(Number.isFinite)).toBe(true)
        expect(item.x).toBeGreaterThanOrEqual(0)
        expect(item.y).toBeGreaterThanOrEqual(0)
        expect(item.x + item.width).toBeLessThanOrEqual(graph.width)
        expect(item.y + item.height).toBeLessThanOrEqual(graph.height)
        for (const other of graph.items.slice(i + 1))
          expect(rectOverlaps(item, other), `${item.id} overlaps ${other.id}`).toBe(false)
        if (item.kind === 'step')
          expect(template.nodes.find((node) => node.id === item.id)?.group).toBe(board)
        if (item.kind === 'group') expect(boardParent(item.id)).toBe(board)
        for (const port of graph.ports[item.id] ?? []) {
          expect(Math.abs(port.offset)).toBeLessThanOrEqual(item.height / 2 - 8)
        }
        if (item.terminal) {
          expect(template.edges.find((e) => e.id === item.terminal!.relationId)).toMatchObject({
            source: item.terminal.source,
            target: item.terminal.target,
          })
          expect(template.nodes.some((node) => node.id === item.terminal!.peerNodeId)).toBe(true)
        }
      }
      for (const edge of graph.edges) {
        for (const end of ['source', 'target'] as const) {
          const item = graph.items.find((candidate) => candidate.id === edge[end])!
          const port = graph.ports[item.id]?.find(
            (candidate) => candidate.id === edge[`${end}Handle`],
          )!
          expect(port).toBeDefined()
          expect(end === 'source' ? edge.points[0] : edge.points.at(-1)).toEqual(
            portPoint(item, port.side, port.offset),
          )
        }
        expect(edge.points.length).toBeLessThanOrEqual(6)
        for (const [i, b] of edge.points.slice(1).entries()) {
          const a = edge.points[i]!
          expect(a.x === b.x || a.y === b.y).toBe(true)
          for (const item of graph.items)
            expect(segmentHitsRect(a, b, item), `${edge.id} penetrates ${item.id}`).toBe(false)
        }
        if (edge.label) expect(edge.labelPoint).toBeDefined()
      }
      const segments = graph.edges.flatMap((edge) =>
        edge.points.slice(1).map((b, i) => ({ id: edge.id, a: edge.points[i]!, b })),
      )
      const model = graph.items.find((item) => item.id === 'model')
      if (model)
        for (const segment of segments) {
          expect(
            segmentHitsRect(segment.a, segment.b, {
              x: model.x,
              y: model.y + model.height + 8,
              width: 280,
              height: 180,
            }),
          ).toBe(false)
        }
      for (const edge of graph.edges.filter((e) => e.label && e.labelPoint)) {
        const width = edge.label!.length * 12 + 20
        const box = {
          x: edge.labelPoint!.x - width / 2,
          y: edge.labelPoint!.y - 12,
          width,
          height: 24,
        }
        for (const item of graph.items) expect(rectOverlaps(box, item)).toBe(false)
        for (const segment of segments)
          expect(segmentHitsRect(segment.a, segment.b, box)).toBe(false)
      }
      for (const [i, a] of segments.entries())
        for (const b of segments.slice(i + 1)) {
          if (a.id === b.id) continue
          expect(segmentsCross(a.a, a.b, b.a, b.b), `${a.id} touches ${b.id}`).toBe(false)
        }
    })
  it('encapsulates descendants and keeps architecture depth distinct from execution order', () => {
    expect(HEADER_BOARDS.flatMap((board) => layoutHeader(board).items.filter((item) => item.kind === 'step').map((item) => item.id)).sort()).toEqual(template.nodes.map((node) => node.id).sort())
    const top = layoutHeader()
    expect(top.items.filter((item) => item.kind === 'group').map((item) => item.id)).toEqual([
      'intake',
      'loop',
    ])
    expect(top.items.some((item) => item.id === 'model')).toBe(false)
    expect(top.representatives.model).toBe('loop')
    expect(layoutHeader('record').representatives.model).toBe('tools')
    expect(boardPath('model-layer')).toEqual([
      'overview',
      'loop',
      'record',
      'tools',
      'retry-layer',
      'model-layer',
    ])
    expect(layoutHeader('tools').items.some((item) => item.id === 'calls')).toBe(true)
    expect(layoutHeader('loop').items.some((item) => item.id === 'calls')).toBe(false)
    expect(layoutHeader('invalid')).toBe(top)
  })
  it('keeps normal reading zoom separate from deliberate depth changes', () => {
    expect(boardZoomIntent(1, -20, true, 'loop')).toBeUndefined()
    expect(boardZoomIntent(1.5, -20, false, 'loop')).toBeUndefined()
    expect(boardZoomIntent(1.5, -20, true, 'loop')).toBe('enter')
    expect(boardZoomIntent(0.5, 20, false, 'loop')).toBe('back')
    expect(boardZoomIntent(0.5, 20, false, 'overview')).toBeUndefined()
  })
})
