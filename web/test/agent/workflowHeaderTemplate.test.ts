import { describe, expect, it } from 'vitest'
import {
  WORKFLOW_HEADER_TEMPLATE as template,
  headerEdgePoints,
  headerNodePorts,
  headerHandleId,
  headerEdgeLabelPoint,
} from '../../src/features/agent/workbench/runtime-diagram/headerTemplate'
import {
  absoluteGraphPosition,
  boundsOverlap,
} from '../../src/features/agent/workbench/runtime-diagram/headerGraph'
import { projectWorkflowGraph } from '../../src/features/agent/workbench/runtime-diagram/graphModel'
import { topologyMatrixSnapshot } from '../fixtures/executionGraphFixtures'

describe('complete header template', () => {
  it('limits unrelated edge crossings and shared segments', () => {
    let crossings = 0
    let overlaps = 0
    const segments = template.edges.flatMap((edge) => {
      const points = headerEdgePoints(edge)
      return points.slice(1).map((end, index) => ({ edge, start: points[index]!, end }))
    })
    for (const [index, a] of segments.entries())
      for (const b of segments.slice(index + 1)) {
        if (a.edge.id === b.edge.id) continue
        const ah = a.start.y === a.end.y,
          bh = b.start.y === b.end.y
        if (ah === bh) {
          const same = ah ? a.start.y === b.start.y : a.start.x === b.start.x
          const axis = ah ? 'x' : 'y'
          if (
            same &&
            Math.min(Math.max(a.start[axis], a.end[axis]), Math.max(b.start[axis], b.end[axis])) >
              Math.max(Math.min(a.start[axis], a.end[axis]), Math.min(b.start[axis], b.end[axis]))
          )
            overlaps++
        } else {
          const h = ah ? a : b,
            v = ah ? b : a
          if (
            v.start.x > Math.min(h.start.x, h.end.x) &&
            v.start.x < Math.max(h.start.x, h.end.x) &&
            h.start.y > Math.min(v.start.y, v.end.y) &&
            h.start.y < Math.max(v.start.y, v.end.y)
          )
            crossings++
        }
      }
    // Previous arrangement had 20 crossings and 10 overlapping segment pairs.
    expect(crossings).toBeLessThanOrEqual(4)
    expect(overlaps).toBe(0)
  })
  it('does not elect a different active branch when task identity is missing or invalid', () => {
    const timeline = topologyMatrixSnapshot()
    timeline.taskId = 'task'
    timeline.activeBranchId = 'missing-branch'
    expect(projectWorkflowGraph(undefined, timeline).activeHeaderId).toBeUndefined()
  })
  it('contains each required path, conditional exit and independent semantic return loop', () => {
    const adjacent = (path: string[]) =>
      path
        .slice(1)
        .every((target, index) =>
          template.edges.some((edge) => edge.source === path[index] && edge.target === target),
        )
    for (const path of [
      [
        'submission',
        'queue',
        'input',
        'command',
        'request',
        'model',
        'response',
        'checkpoint',
        'decision',
        'result',
      ],
      [
        'response',
        'tool-list',
        'validation',
        'authorization',
        'approval-needed',
        'approval',
        'preflight',
        'execution',
        'tool-result',
        'checkpoint',
      ],
      ['approval-needed', 'preflight'],
      ['approval', 'rejection', 'tool-result'],
      ['validation', 'rejection'],
      ['authorization', 'rejection'],
      ['preflight', 'rejection'],
      ['execution', 'rejection'],
      ['model', 'retry', 'model'],
      ['decision', 'request'],
      ['decision', 'wait', 'wake', 'input'],
      ['execution', 'dispatch', 'child-run', 'child-return', 'parent-receive', 'wait'],
      ['request', 'compact-request', 'compact-summary', 'compact-applied', 'request'],
      ['resume', 'preflight'],
    ])
      expect(adjacent(path), path.join(' → ')).toBe(true)
    expect(template.edges.find((edge) => edge.id === 'retry:model')?.role).toBe('retry')
    expect(template.edges.find((edge) => edge.id === 'decision:request')?.role).toBe('loop')
    expect(template.edges.find((edge) => edge.id === 'compact-applied:request')?.role).toBe(
      'compact',
    )
  })

  it('uses legal endpoints and orthogonal routes contained by the complete bounding box', () => {
    const ids = new Set(template.nodes.map((node) => node.id))
    const errors: string[] = []
    for (const edge of template.edges) {
      expect(ids.has(edge.source) && ids.has(edge.target)).toBe(true)
      expect(['left', 'right', 'top', 'bottom']).toContain(edge.sourcePort)
      expect(['left', 'right', 'top', 'bottom']).toContain(edge.targetPort)
      expect(headerNodePorts(edge.source).map((port) => port.id)).toContain(
        headerHandleId('out', edge.sourcePort, edge.sourceOffset),
      )
      expect(headerNodePorts(edge.target).map((port) => port.id)).toContain(
        headerHandleId('in', edge.targetPort, edge.targetOffset),
      )
      const points = headerEdgePoints(edge)
      for (const [index, point] of points.entries()) {
        expect(point.x).toBeGreaterThanOrEqual(0)
        expect(point.x).toBeLessThanOrEqual(template.width)
        expect(point.y).toBeGreaterThanOrEqual(0)
        expect(point.y).toBeLessThanOrEqual(template.height)
        const previous = points[index - 1]
        if (!previous) continue
        if (previous.x !== point.x && previous.y !== point.y) errors.push(`${edge.id}: diagonal`)
        for (const node of template.nodes) {
          if ([edge.source, edge.target].includes(node.id)) continue
          const x = node.position.x,
            y = node.position.y
          const crosses =
            previous.x === point.x
              ? point.x > x &&
                point.x < x + node.width &&
                Math.max(previous.y, point.y) > y &&
                Math.min(previous.y, point.y) < y + node.height
              : point.y > y &&
                point.y < y + node.height &&
                Math.max(previous.x, point.x) > x &&
                Math.min(previous.x, point.x) < x + node.width
          if (crosses) errors.push(`${edge.id}: crosses ${node.id}`)
        }
      }
    }
    expect(errors).toEqual([])
  })

  it('places edge labels on their own route and outside node bodies', () => {
    for (const edge of template.edges.filter((edge) => edge.label)) {
      const label = headerEdgeLabelPoint(edge)
      const points = headerEdgePoints(edge)
      expect(
        points.slice(1).some((end, index) => {
          const start = points[index]!
          return start.x === end.x
            ? label.x === start.x &&
                label.y >= Math.min(start.y, end.y) &&
                label.y <= Math.max(start.y, end.y)
            : label.y === start.y &&
                label.x >= Math.min(start.x, end.x) &&
                label.x <= Math.max(start.x, end.x)
        }),
        edge.id,
      ).toBe(true)
      for (const node of template.nodes)
        expect(
          boundsOverlap(
            {
              x: label.x - edge.label!.length * 6 - 8,
              y: label.y - 13,
              width: edge.label!.length * 12 + 16,
              height: 26,
            },
            { ...node.position, width: node.width, height: node.height },
          ),
          `${edge.id} label / ${node.id}`,
        ).toBe(false)
    }
  })

  it('keeps result history stationary and full/compact heads disjoint including long other lanes', () => {
    const timeline = topologyMatrixSnapshot()
    const projection = projectWorkflowGraph(undefined, timeline)
    const topLevel = projection.nodes.filter((node) => !node.parentNode)
    for (const [index, left] of topLevel.entries())
      for (const right of topLevel.slice(index + 1)) {
        expect(
          boundsOverlap(
            { ...left.position, width: Number(left.width), height: Number(left.height) },
            { ...right.position, width: Number(right.width), height: Number(right.height) },
          ),
          `${left.id} / ${right.id}`,
        ).toBe(false)
      }
    const children = projection.nodes.filter(
      (node) => node.data.kind === 'header-step' || node.data.kind === 'header-calls',
    )
    for (const [index, left] of children.entries())
      for (const right of children.slice(index + 1)) {
        expect(
          boundsOverlap(
            {
              ...absoluteGraphPosition(left, projection.nodes),
              width: Number(left.width),
              height: Number(left.height),
            },
            {
              ...absoluteGraphPosition(right, projection.nodes),
              width: Number(right.width),
              height: Number(right.height),
            },
          ),
          `${left.id} / ${right.id}`,
        ).toBe(false)
      }
    const selected = projectWorkflowGraph(undefined, timeline, 'none', {
      [projection.activeHeaderId!]: { callId: 'missing' },
    })
    expect(selected.nodes.filter((node) => node.data.kind === 'content')).toEqual(
      projection.nodes.filter((node) => node.data.kind === 'content'),
    )
    expect(projection.edges.filter((edge) => edge.type === 'header-flow')).toHaveLength(
      template.edges.length,
    )
    expect(
      projection.edges
        .filter((edge) => edge.type === 'header-flow')
        .every((edge) => edge.data?.semantic === 'template' && !edge.data.evidenced),
    ).toBe(true)
  })
})
