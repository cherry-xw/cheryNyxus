import { describe, expect, it } from 'vitest'
import { WORKFLOW_HEADER_TEMPLATE as template } from '../../src/features/agent/workbench/runtime-diagram/headerTemplate'
import {
  absoluteGraphPosition,
  boundsOverlap,
} from '../../src/features/agent/workbench/runtime-diagram/headerGraph'
import { projectWorkflowGraph } from '../../src/features/agent/workbench/runtime-diagram/graphModel'
import { HEADER_BOARDS } from '../../src/features/agent/workbench/runtime-diagram/headerLayout'
import { topologyMatrixSnapshot } from '../fixtures/executionGraphFixtures'

describe('complete header template', () => {
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
        'entry',
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
      ['model', 'error', 'retry', 'request', 'model'],
      ['decision', 'entry', 'input'],
      ['decision', 'wait', 'wake', 'entry', 'input'],
      ['execution', 'dispatch', 'child-run', 'child-return', 'parent-receive', 'wake'],
      ['request', 'compact-request', 'compact-summary', 'compact-applied', 'request'],
      ['resume', 'tool-list', 'validation', 'authorization'],
    ])
      expect(adjacent(path), path.join(' → ')).toBe(true)
    expect(template.edges.find((edge) => edge.id === 'retry:request')?.role).toBe('retry')
    expect(template.edges.find((edge) => edge.id === 'decision:entry')?.role).toBe('loop')
    expect(template.edges.find((edge) => edge.id === 'compact-applied:request')?.role).toBe(
      'compact',
    )
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
    for (const board of HEADER_BOARDS) {
      const selectedBoard = projectWorkflowGraph(undefined, timeline, 'none', {}, [], {
        boards: { [projection.activeHeaderId!]: board },
      })
      expect(selectedBoard.nodes.filter((node) => node.data.kind === 'content')).toEqual(
        projection.nodes.filter((node) => node.data.kind === 'content'),
      )
      const prefix = `${projection.activeHeaderId}:edge:`
      const represented = new Set(
        [
          ...selectedBoard.edges.flatMap(
            (edge) => edge.data?.members?.map((member) => member.id) ?? [],
          ),
          ...(selectedBoard.internalEdgeIds ?? []),
        ].filter((id) => id.startsWith(prefix)),
      )
      expect([...represented].sort()).toEqual(
        template.edges.map((edge) => `${prefix}${edge.id}`).sort(),
      )
    }
    expect(
      projection.edges
        .filter((edge) => edge.type === 'header-flow')
        .every((edge) => edge.data?.semantic === 'template' && !edge.data.evidenced),
    ).toBe(true)
  })
})
