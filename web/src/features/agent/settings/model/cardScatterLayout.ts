/** Spread landing points across one canvas; overlap is intentional. */
export function initialScatterPosition(
  canvas: { width: number; height: number },
  card: { width: number; height: number },
  index: number,
  randomX: number,
  randomY: number,
): { x: number; y: number } {
  const padding = 12
  const maxX = Math.max(padding, canvas.width - card.width - padding)
  const maxY = Math.max(padding, canvas.height - card.height - padding)
  const column = index % 3
  const row = Math.floor(index / 3)
  const x = Math.max(0, Math.min(1, column / 2 + (randomX - 0.5) * 0.18))
  const y = Math.max(0, Math.min(1, row / 2 + (randomY - 0.5) * 0.18))
  return { x: padding + x * (maxX - padding), y: padding + y * (maxY - padding) }
}
