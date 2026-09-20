import { readFile } from 'node:fs/promises'
import { readComponentSource } from '../helpers/componentSource'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 2026-09-21 四个界面修复的回归契约（源码字符串断言，套件惯例，无 jsdom）。
 *
 * 1. 精简模式：工具图标从 13px 放大到 15px 并微上移（margin-bottom），
 *    与底部状态条留出空隙，不再粘连；
 * 2. 全部任务：卡片不再固定 200px 高 + overflow:hidden，内容随卡片撑开全部可见；
 * 3. 全部任务：移除顶部状态彩线与左侧未读亮条（边缘高亮），状态改由徽章+淡底色表达；
 * 4. 诊断弹窗：最小化/最大化/关闭按钮始终右对齐（margin-left:auto 挂在 actions 上，
 *    而非 signal——signal 在窄窗口会被容器查询隐藏导致按钮失去右对齐）。
 */
describe('UI regression fixes (2026-09-21)', () => {
  it('keeps the lite cluster icon larger and raised above the status bar', async () => {
    const [view, styles] = await Promise.all([
      readComponentSource(resolve('src/features/lite/LiteView.vue'), 'utf8'),
      readFile(resolve('web/src/features/lite/LiteView.styles.css'), 'utf8'),
    ])

    // 图标放大：13 → 15px。
    expect(view).toContain(':size="15"')
    expect(view).not.toContain(':size="13"')
    // 图标微上移，给底部状态条留空隙。
    expect(styles).toContain('.lite-cluster-icon')
    expect(styles).toContain('margin-bottom: 4px')
  })

  it('lets the task browser card grow with its content and drops edge highlight lines', async () => {
    const styles = await readFile(
      resolve('web/src/features/agent/workbench/TaskBrowser.styles.less'),
      'utf8',
    )

    // 卡片高度：不再固定 200px + overflow:hidden（否则内容被裁剪、下拉菜单也被裁剪）。
    expect(styles).toContain('min-height: 200px')
    expect(styles).not.toMatch(/^\s*height: 200px;/m)
    // 卡片容器规则块内不再有 overflow:hidden（「最近要求/详情」的单行省略处仍保留，属预期）。
    const cardBlock = styles.match(/\.task-browser-card\s*\{[^}]*\}/)?.[0] ?? ''
    expect(cardBlock).not.toContain('overflow: hidden')
    // 移除顶部状态彩线与左侧未读亮条（边缘高亮）。
    expect(styles).not.toMatch(/border-top-color: #[0-9a-f]{6}/)
    expect(styles).not.toMatch(/inset 3px 0 0 var\(--accent\)/)
  })

  it('right-aligns the cyber window title controls regardless of the signal visibility', async () => {
    const windowSource = await readComponentSource(
      resolve('src/features/desktop/CyberWindow.vue'),
      'utf8',
    )

    // 右对齐职责挂在 actions（按钮组）上，而不是 signal 上。
    expect(windowSource).toContain('.cyber-window-actions')
    expect(windowSource).toMatch(/\.cyber-window-actions\s*\{[^}]*margin-left: auto;/s)
    // signal 不再承担右对齐（避免窄窗口隐藏 signal 后按钮贴标题）。
    expect(windowSource).not.toMatch(/\.cyber-window-signal\s*\{[^}]*margin-left: auto;/s)
  })
})
