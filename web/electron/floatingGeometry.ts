export interface Rectangle {
  x: number
  y: number
  width: number
  height: number
}

/** 将紧凑窗口完整约束在单个显示器工作区内；不构造多屏外包矩形。 */
export function clampRectangleToWorkArea(
  bounds: Rectangle,
  workArea: Rectangle,
  margin = 8,
): Rectangle {
  const width = Math.min(bounds.width, Math.max(1, workArea.width - margin * 2))
  const height = Math.min(bounds.height, Math.max(1, workArea.height - margin * 2))
  return {
    x: Math.round(Math.min(Math.max(bounds.x, workArea.x + margin), workArea.x + workArea.width - width - margin)),
    y: Math.round(Math.min(Math.max(bounds.y, workArea.y + margin), workArea.y + workArea.height - height - margin)),
    width,
    height,
  }
}

export function petSurfaceSize(count: number): { width: number; height: number } {
  if (count <= 2) return { width: 360, height: 300 }
  if (count <= 5) return { width: 480, height: 360 }
  return { width: 640, height: 420 }
}
