import { describe, expect, it } from 'vitest'
import { circuitRoute } from '../../src/features/agent/workbench/runtime-diagram/headerCircuitRouting'
import {
  boardPath,
  layoutHeader,
  layerAncestors,
  portPoint,
  rectOverlaps,
  segmentHitsRect,
  segmentsCross,
} from '../../src/features/agent/workbench/runtime-diagram/headerLayout'
import {
  HEADER_LAYERS,
  WORKFLOW_HEADER_TEMPLATE as template,
} from '../../src/features/agent/workbench/runtime-diagram/headerTemplate'
import {
  headerPathString,
  moveHeaderPath,
} from '../../src/features/agent/workbench/runtime-diagram/headerPaths'

describe('coexisting nested circuit packages', () => {
  it('routes around an existing wire with few bends and rejects a sealed crossing', () => {
    const start = { x: 40, y: 100 },
      end = { x: 160, y: 100 }
    const wire = [
      { x: 100, y: 40 },
      { x: 100, y: 160 },
    ]
    const points = circuitRoute(start, end, [], [wire], 200, 200)
    const directions = points
      .slice(1)
      .map((p, i) => (p.x === points[i]!.x ? 'vertical' : 'horizontal'))
    expect(
      directions.filter((direction, i) => i > 0 && direction !== directions[i - 1]),
    ).toHaveLength(2)
    expect(points.slice(1).some((p, i) => segmentsCross(points[i]!, p, wire[0]!, wire[1]!))).toBe(
      false,
    )
    expect(() =>
      circuitRoute(
        start,
        end,
        [],
        [
          [
            { x: 100, y: 0 },
            { x: 100, y: 200 },
          ],
        ],
        200,
        200,
      ),
    ).toThrow('No planar circuit route')
  })
  it('keeps peripheral nodes visible, grows ancestors, and collapses back to a single component', () => {
    const closed = layoutHeader(),
      opened = layoutHeader('model-layer')
    expect(closed.items.map((n) => n.id)).toEqual(['intake', 'loop'])
    expect(closed.representatives.model).toBe('loop')
    for (const id of [
      'intake',
      'loop',
      'entry',
      'record',
      'input',
      'tools',
      'retry-layer',
      'model-layer',
      'model',
    ])
      expect(
        opened.items.some((n) => n.id === id),
        id,
      ).toBe(true)
    expect(opened.representatives.model).toBe('model')
    expect(opened.items.find((n) => n.id === 'loop')!.width).toBeGreaterThan(
      closed.items.find((n) => n.id === 'loop')!.width,
    )
    expect(layoutHeader()).toBe(closed)
    expect(boardPath('model-layer')).toEqual([
      'overview',
      'loop',
      'record',
      'tools',
      'retry-layer',
      'model-layer',
    ])
    expect(closed.width).toBeLessThan(700)
    expect(opened.width).toBeLessThan(3000)
  })
  it('conserves every relation and keeps geometry valid across all expansion combinations', () => {
    for (let mask = 0; mask < 1 << HEADER_LAYERS.length; mask++) {
      const graph = layoutHeader(HEADER_LAYERS.filter((_, i) => mask & (1 << i)).map((l) => l.id))
      expect(new Set(graph.items.map((n) => n.id)).size).toBe(graph.items.length)
      expect(new Set(graph.edges.map((e) => e.id)).size).toBe(graph.edges.length)
      const visible = new Set(graph.edges.flatMap((e) => e.memberIds))
      expect([...visible, ...graph.internalEdgeIds].sort()).toEqual(
        template.edges.map((e) => e.id).sort(),
      )
      for (const [i, item] of graph.items.entries()) {
        expect([item.x, item.y, item.width, item.height].every(Number.isFinite)).toBe(true)
        const parent = graph.items.find((n) => n.id === item.parent)
        const box = parent ?? { x: 0, y: 0, width: graph.width, height: graph.height }
        expect(item.x, `${mask}:${item.id} left`).toBeGreaterThanOrEqual(box.x)
        expect(item.y, `${mask}:${item.id} top`).toBeGreaterThanOrEqual(box.y)
        expect(item.x + item.width, `${mask}:${item.id} right`).toBeLessThanOrEqual(
          box.x + box.width,
        )
        expect(item.y + item.height, `${mask}:${item.id} bottom`).toBeLessThanOrEqual(
          box.y + box.height,
        )
        for (const other of graph.items.slice(i + 1)) {
          if (item.parent !== other.parent || !item.width || !other.width) continue
          expect(rectOverlaps(item, other), `${mask}:${item.id}/${other.id}`).toBe(false)
        }
      }
      for (const edge of graph.edges) {
        if (edge.label)
          expect(edge.labelPoint, `${mask}:${edge.id} missing condition label`).toBeDefined()
        for (const end of ['source', 'target'] as const) {
          const item = graph.items.find((n) => n.id === edge[end])!
          const port = graph.ports[item.id]!.find((p) => p.id === edge[`${end}Handle`])!
          expect(port, `${edge.id} ${end}`).toBeDefined()
          expect(end === 'source' ? edge.points[0] : edge.points.at(-1)).toEqual(
            portPoint(item, port.side, port.offset),
          )
        }
        const board = edge.id.split(':')[0]
        for (const [i, b] of edge.points.slice(1).entries()) {
          const a = edge.points[i]!
          expect(a.x === b.x || a.y === b.y).toBe(true)
          for (const item of graph.items.filter(
            (n) => (n.parent ?? 'overview') === board && n.width > 0 && !n.terminal?.boundary,
          ))
            expect(segmentHitsRect(a, b, item), `${mask}:${edge.id} penetrates ${item.id}`).toBe(
              false,
            )
        }
      }
      // Check every displayed layer together, including endpoint touches and all label boxes.
      for (const [i, edge] of graph.edges.entries()) {
        const board = edge.id.split(':')[0]
        const siblings = graph.items.filter((n) => (n.parent ?? 'overview') === board)
        const shell = graph.items.find((n) => n.id === board) ?? {
          x: 0,
          y: 0,
          width: graph.width,
          height: graph.height,
        }
        for (const p of edge.points) {
          expect(p.x, `${mask}:${edge.id} x`).toBeGreaterThanOrEqual(shell.x)
          expect(p.x).toBeLessThanOrEqual(shell.x + shell.width)
          expect(p.y, `${mask}:${edge.id} y`).toBeGreaterThanOrEqual(shell.y)
          expect(p.y).toBeLessThanOrEqual(shell.y + shell.height)
        }
        for (const end of ['source', 'target'] as const) {
          const item = graph.items.find((n) => n.id === edge[end])!
          const port = graph.ports[item.id]!.find((p) => p.id === edge[`${end}Handle`])!
          const tip = end === 'source' ? edge.points[0]! : edge.points.at(-1)!
          const next = end === 'source' ? edge.points[1]! : edge.points.at(-2)!
          const sign = item.terminal?.boundary ? -1 : 1
          const normal = {
            x: port.side === 'left' ? -1 : port.side === 'right' ? 1 : 0,
            y: port.side === 'top' ? -1 : port.side === 'bottom' ? 1 : 0,
          }
          expect(
            ((next.x - tip.x) * normal.x + (next.y - tip.y) * normal.y) * sign,
            `${mask}:${edge.id} ${end} normal`,
          ).toBeGreaterThan(0)
          expect(Math.abs(port.offset)).toBeLessThanOrEqual(
            (port.side === 'left' || port.side === 'right' ? item.height : item.width) / 2,
          )
        }
        for (const other of graph.edges.slice(i + 1)) {
          if (edge.memberIds[0] === other.memberIds[0]) continue
          const touches = edge.points
            .slice(1)
            .some((b, i) =>
              other.points
                .slice(1)
                .some((d, j) => segmentsCross(edge.points[i]!, b, other.points[j]!, d)),
            )
          expect(touches, `${mask}:${edge.id} touches ${other.id}`).toBe(false)
        }
        const model = siblings.find((n) => n.id === 'model')
        if (model)
          for (const [i, b] of edge.points.slice(1).entries())
            expect(
              segmentHitsRect(edge.points[i]!, b, {
                x: model.x,
                y: model.y + model.height + 8,
                width: 280,
                height: 180,
              }),
              `${mask}:${edge.id} live panel`,
            ).toBe(false)
        if (edge.labelPoint && edge.label) {
          const width = edge.label.length * 12 + 20
          const box = {
            x: edge.labelPoint.x - width / 2,
            y: edge.labelPoint.y - 12,
            width,
            height: 24,
          }
          for (const item of siblings)
            expect(rectOverlaps(box, item), `${mask}:${edge.id} label covers ${item.id}`).toBe(
              false,
            )
          for (const other of graph.edges)
            expect(
              other.points.slice(1).some((b, i) => segmentHitsRect(other.points[i]!, b, box)),
              `${mask}:${edge.id} label covers ${other.id}`,
            ).toBe(false)
          for (const other of graph.edges.slice(i + 1))
            if (other.labelPoint && other.label) {
              const w = other.label.length * 12 + 20
              expect(
                rectOverlaps(box, {
                  x: other.labelPoint.x - w / 2,
                  y: other.labelPoint.y - 12,
                  width: w,
                  height: 24,
                }),
                `${mask}:${edge.id}/${other.id} labels`,
              ).toBe(false)
            }
        }
      }
      // Every boundary pin physically joins its external package port for the same relation.
      for (const pin of graph.items.filter((n) => n.terminal?.boundary)) {
        const shell = graph.items.find((n) => n.id === pin.parent)!
        const external = graph.edges.find(
          (e) =>
            e.memberIds.includes(pin.terminal!.relationId) &&
            (e.source === shell.id || e.target === shell.id),
        )!
        expect(external, pin.id).toBeDefined()
        const endpoint =
          external.source === shell.id ? external.points[0]! : external.points.at(-1)!
        const port = graph.ports[pin.id]![0]!
        expect(endpoint, pin.id).toEqual(portPoint(pin, port.side, port.offset))
      }
    }
  }, 30000)
  it('keeps the complete circuit compact with four-way ports and short orthogonal paths', () => {
    const graph = layoutHeader(HEADER_LAYERS.map((l) => l.id))
    const responseFlow = graph.edges.find(
      (edge) => edge.memberIds[0] === 'response:channels',
    )!
    expect(responseFlow.points).toHaveLength(2)
    expect(responseFlow.points[1]!.x).toBe(responseFlow.points[0]!.x)
    expect(responseFlow.points[1]!.y).toBeGreaterThan(responseFlow.points[0]!.y)
    expect(graph.items.filter((n) => n.kind === 'step')).toHaveLength(template.nodes.length)
    expect(graph.internalEdgeIds).toEqual([])
    expect(graph.width).toBeLessThan(3000)
    expect(graph.height).toBeLessThan(2600)
    expect(
      new Set(
        Object.values(graph.ports)
          .flat()
          .map((p) => p.side),
      ),
    ).toEqual(new Set(['left', 'right', 'top', 'bottom']))
    expect(graph.items.find((n) => n.id === 'context')?.parent).toBe('model-layer')
    const input = graph.items.find((n) => n.id === 'input')!
    const command = graph.items.find((n) => n.id === 'command')!
    expect(input.x).toBe(command.x)
    expect(command.y).toBeGreaterThan(input.y + input.height)
    expect(graph.edges.find((e) => e.memberIds[0] === 'input:command')!.points).toHaveLength(2)
    const entryInput = graph.edges.find((e) => e.memberIds[0] === 'entry:input')!
    expect(entryInput.points).toHaveLength(2)
    expect(entryInput.points[0]!.y).toBe(entryInput.points[1]!.y)
    const modelLayer = graph.items.find((n) => n.id === 'model-layer')!
    const channels = graph.items.find((n) => n.id === 'channels')!
    expect(modelLayer.y + modelLayer.height - (channels.y + channels.height)).toBe(64)
    const upper = graph.items.find((n) => n.id === 'retry-layer')!
    const error = graph.items.find((n) => n.id === 'error')!
    const left = graph.items.find((n) => n.id === 'collaboration')!
    const right = graph.items.find((n) => n.id === 'rejection')!
    const toolResult = graph.items.find((n) => n.id === 'tool-result')!
    expect(upper.x).toBe(left.x)
    expect(upper.y + upper.height).toBeLessThan(left.y)
    expect(right.x).toBeGreaterThan(upper.x + upper.width)
    const checkpointDescent = graph.edges.find(
      (edge) => edge.id === 'retry-layer:channels:checkpoint',
    )!
    expect(error.x + error.width).toBeLessThan(checkpointDescent.points[0]!.x)
    expect(checkpointDescent.points).toHaveLength(2)
    expect(graph.items.find((n) => n.id === 'calls')).toBeUndefined()
    const checkpoint = graph.items.find((n) => n.id === 'checkpoint')!
    const decision = graph.items.find((n) => n.id === 'decision')!
    expect(toolResult.x + toolResult.width / 2).toBe(checkpoint.x + checkpoint.width / 2)
    expect(checkpoint.x + checkpoint.width / 2).toBe(decision.x + decision.width / 2)
    for (const memberId of ['tool-result:checkpoint', 'checkpoint:decision']) {
      const edge = graph.edges.find((e) => e.memberIds[0] === memberId)!
      expect(edge.points).toHaveLength(2)
      expect(edge.points[0]!.x).toBe(edge.points[1]!.x)
    }
    const collaboration = ['dispatch', 'child-run', 'child-return', 'parent-receive'].map((id) =>
      graph.items.find((n) => n.id === id)!,
    )
    expect(new Set(collaboration.map((n) => n.y)).size).toBe(1)
    expect(graph.items.find((n) => n.id === 'collaboration')!.width).toBeLessThan(900)
    for (const [i, node] of collaboration.slice(1).entries()) {
      expect(node.x).toBeGreaterThan(collaboration[i]!.x + collaboration[i]!.width)
      const edge = graph.edges.find((e) => e.memberIds[0] === `${collaboration[i]!.id}:${node.id}`)!
      expect(edge.points).toHaveLength(2)
      expect(edge.points[0]!.y).toBe(edge.points[1]!.y)
    }
    for (const edge of graph.edges) {
      expect(edge.points.length - 2, edge.id).toBeLessThanOrEqual(
        edge.id.startsWith('tools:') ? 3 : 4,
      )
      expect(headerPathString(edge.points)).not.toContain(' Q ')
    }
    for (const layer of HEADER_LAYERS) expect(layerAncestors(layer.id)).toContain(layer.id)
  })
  it('preserves vertical pin normals during an interrupted layout transition', () => {
    const points = moveHeaderPath(
      [
        { x: 20, y: 0 },
        { x: 20, y: 100 },
      ],
      { x: 30, y: 10 },
      { x: 50, y: 140 },
    )
    expect(points[0]!.x).toBe(points[1]!.x)
    expect(points.at(-1)!.x).toBe(points.at(-2)!.x)
  })
})
