export type WindowGeometry = { x: number; y: number; width: number; height: number }
export type WindowViewport = { width: number; height: number }

export function fitWindow(geometry: WindowGeometry, viewport: WindowViewport): WindowGeometry {
  const margin = 8
  const availableWidth = Math.max(1, viewport.width - margin * 2)
  const availableHeight = Math.max(1, viewport.height - margin * 2)
  const width = Math.min(availableWidth, Math.max(Math.min(360, availableWidth), geometry.width))
  const height = Math.min(availableHeight, Math.max(Math.min(240, availableHeight), geometry.height))
  return {
    width,
    height,
    x: Math.max(margin, Math.min(viewport.width - margin - width, geometry.x)),
    y: Math.max(margin, Math.min(viewport.height - margin - height, geometry.y)),
  }
}
