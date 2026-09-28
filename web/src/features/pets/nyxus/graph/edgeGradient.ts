/**
 * 渐变连线的路径取点（纯几何，不依赖渲染器/pixi，可在 node 环境单测）。
 *
 * 渐变描边需要把整条路径按进度 t∈[0,1] 切成若干段、逐段用 from→to 插值色描边。
 * 分段的关键约束是「不能切平拐角」：如果两段端点落在圆角正交转弯两侧，
 * 中间那段直线弦就会斜切过拐角弧线，产生生硬的折角。
 * 因此这里默认逐采样点输出（与单条折线描边完全一致，拐角天然保留），
 * 仅当样本数超过档位上限时才抽稀，且抽稀时保留所有拐角顶点、只在直线区间取点。
 */

/** 渐变描边路径上的一个折点（含沿路径累计距离，供颜色插值定位）。 */
export interface GradientPathPoint {
  x: number
  y: number
  distance: number
}

/** gradientPathPoints 只依赖的最小边结构；SampledEdge 等渲染结构可结构兼容。 */
export interface GradientEdgeSamples {
  geometry: { from: { x: number; y: number } }
  samples: Array<{ x: number; y: number; distance: number }>
  length: number
}

/**
 * 相邻采样段方向变化点积低于该值视为拐角：抽稀时永不合并跨过拐角，
 * 避免直角弯折被直线弦切平。cos(20°)≈0.94，可覆盖圆角正交转弯的逐段转角。
 */
export const GRADIENT_CORNER_DOT_THRESHOLD = 0.94

/**
 * 生成渐变描边路径点：默认逐采样点输出（拐角保留），
 * 仅当 `samples.length - 1 > maxSegments` 时抽稀到不超过 `maxSegments` 段，
 * 抽稀始终保留首尾与拐角顶点，其余预算在直线区间均匀取点。
 */
export function gradientPathPoints(
  edge: GradientEdgeSamples,
  maxSegments: number,
): GradientPathPoint[] {
  const samples = edge.samples
  if (samples.length <= 1) {
    return [{ x: edge.geometry.from.x, y: edge.geometry.from.y, distance: 0 }]
  }
  if (samples.length - 1 <= maxSegments) {
    return samples.map((sample) => ({ x: sample.x, y: sample.y, distance: sample.distance }))
  }
  const keep = new Set<number>([0, samples.length - 1])
  for (let index = 1; index < samples.length - 1; index += 1) {
    const a = samples[index - 1]!
    const b = samples[index]!
    const c = samples[index + 1]!
    const v1x = b.x - a.x
    const v1y = b.y - a.y
    const v2x = c.x - b.x
    const v2y = c.y - b.y
    const length1 = Math.hypot(v1x, v1y)
    const length2 = Math.hypot(v2x, v2y)
    if (length1 < 1e-6 || length2 < 1e-6) continue
    const dot = (v1x * v2x + v1y * v2y) / (length1 * length2)
    if (dot < GRADIENT_CORNER_DOT_THRESHOLD) keep.add(index)
  }
  const budget = maxSegments + 1
  const remaining = budget - keep.size
  if (remaining > 0) {
    const straight: number[] = []
    for (let index = 1; index < samples.length - 1; index += 1) {
      if (!keep.has(index)) straight.push(index)
    }
    if (straight.length > 0) {
      for (let step = 0; step < remaining; step += 1) {
        const pick = Math.round((step * (straight.length - 1)) / Math.max(1, remaining - 1))
        keep.add(straight[pick]!)
      }
    }
  }
  return [...keep]
    .sort((left, right) => left - right)
    .map((index) => {
      const sample = samples[index]!
      return { x: sample.x, y: sample.y, distance: sample.distance }
    })
}
