import type { PixiExecutionScene } from './ExecutionGraphPixiRenderer'

/**
 * Pixi scene equality used to skip redundant static redraws.
 * Geometry is part of the scene: layout-mode changes can move the same node/edge IDs.
 */
export function executionSceneSignature(scene: PixiExecutionScene, visibleKey = ''): string {
  return [
    visibleKey,
    scene.presentation ?? 'vertical-classic',
    ...scene.nodes.map((node) =>
      [
        node.id,
        node.x,
        node.y,
        node.accent,
        node.glyph,
        node.title,
        node.visualKind ?? '',
        node.effect ?? '',
        node.termination ?? '',
        node.foldCount ?? '',
        Number(node.running),
        Number(node.detailActive),
        node.branchAnchorKind ?? '',
        Number(node.paused),
        Number(node.error),
        Number(node.containsErrorMessage),
        Number(node.revoked),
        Number(node.deemphasized),
        Number(node.detailBranch),
      ].join('\u0001'),
    ),
    '\u0002',
    ...scene.edges.map((edge) =>
      [
        edge.id,
        edge.from.x,
        edge.from.y,
        edge.to.x,
        edge.to.y,
        edge.routeX ?? '',
        edge.routeY ?? '',
        edge.color,
        Number(edge.active),
        edge.phaseSeconds,
        Number(edge.deemphasized),
        Number(edge.detailBranch),
        edge.fromHalfWidth ?? '',
        edge.toHalfWidth ?? '',
      ].join('\u0001'),
    ),
  ].join('\u0000')
}
