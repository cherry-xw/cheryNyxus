export const DAILY_CHART_TOP = 64
export const DAILY_CHART_LEFT = 42
export const DAILY_CHART_GAP = 2

export function dailyCellLayout(width: number, height: number, yearColumns: number) {
  const cellHeight = Math.max(8, Math.floor((height - DAILY_CHART_TOP - 8) / 7) - DAILY_CHART_GAP)
  const cellWidth = Math.min(cellHeight, Math.max(6,
    Math.floor((width - DAILY_CHART_LEFT - 12) / yearColumns) - DAILY_CHART_GAP))
  return { width: cellWidth, height: cellHeight, radius: 1,
    pitchX: cellWidth + DAILY_CHART_GAP, pitchY: cellHeight + DAILY_CHART_GAP }
}

// This palette belongs to the daily calendar; legend and cells must use the same entries.
export const DAILY_COLOR_BANDS = [
  { value: -1, label: '范围外 / 未来 / 无数据', color: 'rgba(104, 112, 124, 0.1)' },
  { value: 0, label: '零消耗', color: '#d7dee8' },
  { gt: 0, lte: 25_000, label: '≤25K', color: '#a8c7fa' },
  { gt: 25_000, lte: 75_000, label: '25–75K', color: '#6f7fe8' },
  { gt: 75_000, lte: 150_000, label: '75–150K', color: '#b98bda' },
  { gt: 150_000, label: '>150K', color: '#8253b0' },
]

export function dailyCellColor(value: number): string {
  const normalized = value < 0 ? -1 : value
  return DAILY_COLOR_BANDS.find(band => band.value !== undefined ? band.value === normalized
    : value > band.gt! && (band.lte === undefined || value <= band.lte))!.color
}
