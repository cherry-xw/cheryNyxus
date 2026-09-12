import type { HeaderPoint } from './headerTemplate'

/** World anchor -> flow-host pixels. The overlay is outside the camera transform. */
export function headerAttentionPosition(
  position: HeaderPoint,
  size: { width: number; height: number },
  viewport: { x: number; y: number; zoom: number },
): { left: string; top: string; transform: string } {
  return {
    left: `${viewport.x + (position.x + size.width / 2) * viewport.zoom}px`,
    top: `${viewport.y + (position.y + size.height) * viewport.zoom + 12}px`,
    transform: 'translateX(-50%)',
  }
}
