/**
 * 前端图片 token 估算（镜像后端 src/utils/token.ts 的 estimateImageTokens）。
 * 用于上传前「原图/压缩图」两种选择预计 token 消耗的即时展示；绝对准确度以后端/官方预检为准。
 */
export type ImageDetail = 'low' | 'default' | 'high'

/** 图片 token 估算（OpenAI 视觉规则：85 基础 + 170/tile，tile = ⌈w/512⌉×⌈h/512⌉）。 */
export function estimateImageTokens(
  width: number,
  height: number,
  detail: ImageDetail = 'default',
): number {
  if (!width || !height || width <= 0 || height <= 0) return 0
  if (detail === 'low') return 85
  const tiles = Math.ceil(width / 512) * Math.ceil(height / 512)
  if (detail === 'high') return 85 + 170 * tiles
  return 85 + 170 * Math.min(tiles, 4)
}
