import { describe, expect, it } from 'vitest'
import { layoutHeader, layerAncestors, resolveCollapsedLayers, segmentHitsRect } from '../../src/features/agent/workbench/runtime-diagram/headerLayout'
import { WORKFLOW_HEADER_TEMPLATE as template, HEADER_NODE_SIZE } from '../../src/features/agent/workbench/runtime-diagram/headerTemplate'

describe('recursive header projection', () => {
  const core = ['loop', 'record', 'tools', 'retry-layer', 'model-layer']
  it('preserves every relation for all 32 core collapse settings', () => {
    for (let mask = 0; mask < 32; mask++) {
      const collapsed = new Set(core.filter((_, i) => mask & (1 << i)))
      const graph = layoutHeader(collapsed)
      const accounted = [...graph.internalEdgeIds, ...graph.edges.flatMap((e) => e.memberIds)]
      expect(accounted.sort()).toEqual(template.edges.map((e) => e.id).sort())
      for (const item of graph.items) {
        if (item.kind === 'step') expect(layerAncestors(template.nodes.find((n) => n.id === item.id)!.group).some((g) => collapsed.has(g))).toBe(false)
        if (item.collapsed) expect([item.width, item.height]).toEqual([HEADER_NODE_SIZE.width, HEADER_NODE_SIZE.height])
      }
      for (const edge of graph.edges) {
        expect(edge.source).not.toBe(edge.target)
        expect(graph.ports[edge.source]?.some((p) => p.id === edge.sourceHandle)).toBe(true)
        expect(graph.ports[edge.target]?.some((p) => p.id === edge.targetHandle)).toBe(true)
        for (let i = 1; i < edge.points.length; i++) {
          const a = edge.points[i - 1]!, b = edge.points[i]!
          expect(a.x === b.x || a.y === b.y).toBe(true)
          for (const item of graph.items) {
            if ((item.kind === 'group' && !item.collapsed) || [edge.source, edge.target].includes(item.id)) continue
            expect(segmentHitsRect(a, b, item), `${mask} ${edge.id} crosses ${item.id}`).toBe(false)
          }
        }
      }
    }
  }, 120000)
  it('retains edges between separately collapsed parents and hides nested panels', () => {
    const graph = layoutHeader(new Set(['loop', 'intake', 'compact', 'collaboration']))
    expect(graph.items.every((n) => n.kind === 'group')).toBe(true)
    expect(graph.edges.some((e) => e.source === 'intake' && e.target === 'loop')).toBe(true)
    expect(graph.edges.some((e) => e.source === 'loop' && e.target === 'compact')).toBe(true)
    expect(graph.edges.some((e) => e.source === 'collaboration' && e.target === 'loop')).toBe(true)
  })
  it('respects manual collapse over running descendants and isolates header overrides', () => {
    const active = new Set(['model-layer'])
    expect(resolveCollapsedLayers({headerId: 'h', active, follow: true}).has('loop')).toBe(false)
    expect(resolveCollapsedLayers({headerId: 'h', active, follow: true, overrides: {'h:tools': true}}).has('tools')).toBe(true)
    expect(resolveCollapsedLayers({headerId: 'other', active, follow: true, overrides: {'h:tools': true}}).has('tools')).toBe(false)
  })
})

it('reports layout route quality for the complete head', () => {
  const graph = layoutHeader()
  let crossings = 0, overlaps = 0

  const segments = graph.edges.flatMap((e) => e.points.slice(1).map((b,i) => ({id:e.id,collector:e.collector,a:e.points[i]!,b})))
  for (let i=0;i<segments.length;i++) for (let j=i+1;j<segments.length;j++) {
    const a=segments[i]!,b=segments[j]!
    if(a.id===b.id || (a.collector && b.collector)) continue
    const ah=a.a.y===a.b.y,bh=b.a.y===b.b.y
    if(ah===bh) {
      const axis=ah?'x':'y'
      if((ah?a.a.y===b.a.y:a.a.x===b.a.x)&&Math.min(Math.max(a.a[axis],a.b[axis]),Math.max(b.a[axis],b.b[axis]))>Math.max(Math.min(a.a[axis],a.b[axis]),Math.min(b.a[axis],b.b[axis]))) overlaps++
    } else {
      const h=ah?a:b,v=ah?b:a
      if(v.a.x>Math.min(h.a.x,h.b.x)&&v.a.x<Math.max(h.a.x,h.b.x)&&h.a.y>Math.min(v.a.y,v.b.y)&&h.a.y<Math.max(v.a.y,v.b.y)) crossings++
    }
  }
  expect(crossings).toBeLessThanOrEqual(4)
  expect(graph.edges.filter(e => e.label && !e.labelPoint)).toEqual([])
  expect(overlaps).toBe(0)
})

import { moveHeaderPath, headerCrossingPath } from '../../src/features/agent/workbench/runtime-diagram/headerPaths'
it('keeps moving endpoints attached with orthogonal segments and distinguishes crossings', () => {
  const source = {x: 20, y: 25}, target = {x: 260, y: 170}
  const path = moveHeaderPath([{x:0,y:0},{x:100,y:0},{x:100,y:100},{x:200,y:100}], source, target)
  expect(path[0]).toEqual(source)
  expect(path.at(-1)).toEqual(target)
  for(let i=1;i<path.length;i++) expect(path[i]!.x===path[i-1]!.x || path[i]!.y===path[i-1]!.y).toBe(true)
  expect(headerCrossingPath([{x:0,y:50},{x:100,y:50}], [[{x:50,y:0},{x:50,y:100}]]))
    .toBe('M 0 50 L 46 50 M 54 50 L 100 50')
})
