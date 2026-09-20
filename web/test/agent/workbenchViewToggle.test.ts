import { readComponentSource } from '../helpers/componentSource'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 回归测试：视图切换高亮色块在「关闭工作台 → 重新打开」后宽度错误。
 *
 * 根因：色块位置曾用 getBoundingClientRect 测量，而工作台打开动画会给面板临时加
 * scale（useOverlayAnimation 的 dialog 入场），re-open 时测量恰落在动画内，
 * 缩小后的宽度被测入且不再自愈（transform 变化不触发 ResizeObserver）。
 * 修复后必须使用不受 CSS transform 影响的布局尺寸（offsetLeft/offsetWidth）测量。
 */
describe('workbench view toggle slider measurement', () => {
  it('measures slider geometry with transform-immune offset metrics', async () => {
    const toggle = await readComponentSource(
      resolve('src/features/agent/workbench/WorkbenchViewToggle.vue'),
      'utf8',
    )

    expect(toggle).toContain('cachedMaskW = mask.offsetWidth')
    expect(toggle).toContain('btn.offsetLeft - mask.offsetLeft + BLOCK_INSET')
    expect(toggle).toContain('btn.offsetWidth - BLOCK_INSET * 2')
    // 防回归：禁止再引入受入场 scale 动画影响的 rect 测量（调用形式）
    expect(toggle).not.toContain('getBoundingClientRect()')
  })
})
