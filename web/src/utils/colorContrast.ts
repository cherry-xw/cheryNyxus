/**
 * 颜色对比度工具（WCAG 2.x 相对亮度与对比度）。
 *
 * 供两处复用：
 * - 颜色可读性扫描测试（web/test/styles/colorReadability.test.ts）计算硬编码前景色对比度；
 * - 未来选用新颜色时在组件内做一次快速自查，避免再次引入深色下不可读的硬编码色。
 *
 * 只含纯函数，不依赖 DOM；透明度不做合成，十六进制 4/8 位形式按不透明 RGB 处理。
 */

export type Rgb = [number, number, number]

/** 解析 #rgb / #rgba / #rrggbb / #rrggbbaa 为 RGB 通道（alpha 忽略，按不透明处理）。非法输入返回 null。 */
export function parseHex(hex: string): Rgb | null {
  const raw = hex.trim().replace(/^#/, '')
  const pair = (c: string): number => Number.parseInt(c + c, 16)
  if (/^[0-9a-f]{3}$/i.test(raw)) return raw.split('').map(pair) as Rgb
  if (/^[0-9a-f]{4}$/i.test(raw)) return raw.slice(0, 3).split('').map(pair) as Rgb
  if (/^[0-9a-f]{6}$/i.test(raw)) return raw.match(/../g)!.map((c) => Number.parseInt(c, 16)) as Rgb
  if (/^[0-9a-f]{8}$/i.test(raw))
    return raw
      .slice(0, 6)
      .match(/../g)!
      .map((c) => Number.parseInt(c, 16)) as Rgb
  return null
}

/** 相对亮度（WCAG 定义，0~1）。 */
export function luminance(rgb: Rgb): number {
  return rgb.reduce((sum, value, index) => {
    const s = value / 255
    return (
      sum +
      (s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][index]!
    )
  }, 0)
}

/** 对比度（WCAG 定义，1~21）。fg/bg 可传 #hex 或 RGB 数组。 */
export function contrastRatio(fg: string | Rgb, bg: string | Rgb): number {
  const a = luminance(typeof fg === 'string' ? parseHex(fg)! : fg)
  const b = luminance(typeof bg === 'string' ? parseHex(bg)! : bg)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

/** 是否达到指定对比度阈值（正文 4.5、必要控件/图标 3.0）。 */
export function isReadable(fg: string | Rgb, bg: string | Rgb, threshold = 4.5): boolean {
  return contrastRatio(fg, bg) >= threshold
}
