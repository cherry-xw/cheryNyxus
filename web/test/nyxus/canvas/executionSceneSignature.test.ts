import { describe, expect, it } from 'vitest'
import type { PixiExecutionScene } from '../../../src/features/pets/nyxus/renderer/ExecutionGraphPixiRenderer'
import { executionSceneSignature } from '../../../src/features/pets/nyxus/renderer/executionSceneSignature'

function scene(): PixiExecutionScene {
  return {
    nodes: [
      {
        id: 'node-a',
        x: 0,
        y: 32,
        accent: '#fff',
        glyph: 'A',
        title: '节点 A',
        running: false,
        detailActive: false,
        paused: false,
        error: false,
        containsErrorMessage: false,
        revoked: false,
        deemphasized: false,
        detailBranch: false,
      },
    ],
    edges: [
      {
        id: 'edge-a-b',
        from: { x: 0, y: 32 },
        to: { x: 110, y: 114 },
        routeX: 55,
        color: '#fff',
        active: false,
        phaseSeconds: 0,
        deemphasized: false,
        detailBranch: false,
      },
    ],
  }
}

describe('Pixi execution scene signature', () => {
  it('changes when only node layout coordinates change', () => {
    const before = scene()
    const after = scene()
    after.nodes[0]!.y = 114

    expect(executionSceneSignature(after)).not.toBe(executionSceneSignature(before))
  })

  it('changes when only edge geometry changes', () => {
    const before = scene()
    const endpointMoved = scene()
    endpointMoved.edges[0]!.to.y = 196
    const routeMoved = scene()
    routeMoved.edges[0]!.routeX = 88

    expect(executionSceneSignature(endpointMoved)).not.toBe(executionSceneSignature(before))
    expect(executionSceneSignature(routeMoved)).not.toBe(executionSceneSignature(before))
  })

  it('changes when only node or edge emphasis changes', () => {
    const before = scene()
    const nodeDimmed = scene()
    nodeDimmed.nodes[0]!.deemphasized = true
    const edgeDimmed = scene()
    edgeDimmed.edges[0]!.deemphasized = true

    expect(executionSceneSignature(nodeDimmed)).not.toBe(executionSceneSignature(before))
    expect(executionSceneSignature(edgeDimmed)).not.toBe(executionSceneSignature(before))
  })

  it('changes when only node or edge detail-branch state changes', () => {
    const before = scene()
    const detailNode = scene()
    detailNode.nodes[0]!.detailBranch = true
    const detailEdge = scene()
    detailEdge.edges[0]!.detailBranch = true

    expect(executionSceneSignature(detailNode)).not.toBe(executionSceneSignature(before))
    expect(executionSceneSignature(detailEdge)).not.toBe(executionSceneSignature(before))
  })

  it('changes when a process group gains an error-message outline', () => {
    const before = scene()
    const after = scene()
    after.nodes[0]!.containsErrorMessage = true

    expect(executionSceneSignature(after)).not.toBe(executionSceneSignature(before))
  })

  it('stays stable for equivalent scenes', () => {
    expect(executionSceneSignature(scene(), 'visible-set')).toBe(
      executionSceneSignature(scene(), 'visible-set'),
    )
  })
})
