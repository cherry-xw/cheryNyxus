import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readComponentSource } from '../helpers/componentSource'

describe('frontend cold-start bundle boundaries', () => {
  it('loads heavy surfaces only when their application state opens them', async () => {
    const source = await readComponentSource(resolve('apps/web/src/App.vue'), 'utf8')

    expect(source).toContain('defineAsyncComponent')
    expect(source).toContain("import('@/features/agent/chat/AgentDialog.vue')")
    expect(source).toContain("import('@/features/agent/workbench/WorkbenchDialog.vue')")
    expect(source).toContain("import('@/features/agent/drawer/HistoryDrawer.vue')")
    expect(source).toContain("import('@/features/agent/settings/SettingsDialog.vue')")
    // 窗口外壳已收敛为 WorkspaceCyberWindow 管理器（App 不再直接异步挂 CyberWindow，
    // 窗口 chrome 经 CyberDesktopHost 异步边界加载）。
    expect(source).toContain("import('@/features/desktop/CyberDesktopHost.vue')")
    expect(source).toContain("import('@/features/desktop/WorkspaceCyberWindow.vue')")
    expect(source).not.toContain("import('@/features/desktop/CyberWindow.vue')")
    expect(source).toMatch(
      /<WorkspaceCyberWindow[\s\S]*?v-if="browserSessionWindow"[\s\S]*?<AgentDialog v-if="workspace\.activeDialogChatId" embedded \/>[\s\S]*?<\/WorkspaceCyberWindow>/,
    )
    expect(source).toMatch(
      /<WorkspaceCyberWindow[\s\S]*?v-if="browserHistoryWindow && workspace\.historyDrawerMode === 'overlay'"[\s\S]*?<HistoryDrawer embedded \/>[\s\S]*?<\/WorkspaceCyberWindow>/,
    )
    expect(source).toMatch(
      /<WorkspaceCyberWindow[\s\S]*?v-if="browserSettingsWindow"[\s\S]*?<SettingsDialog\b[^>]*v-if="workspace\.settingsOpen && capabilityEnabled\('settings.manage'\)"[^>]*embedded\s*\/>[\s\S]*?<\/WorkspaceCyberWindow>/,
    )
    expect(source).toContain("workspace.historyDrawerMode === 'overlay'")
    expect(source).not.toContain("'workbench-docked'")
    expect(source).not.toContain("from '@/features/pets/nyxus/public'")
  })

  it('keeps Element Plus and syntax highlighting on explicit allowlists', async () => {
    const [main, markdown, theme, viteConfig] = await Promise.all([
      readFile(resolve('apps/web/src/main.ts'), 'utf8'),
      readFile(resolve('apps/web/src/utils/markdownEngine.ts'), 'utf8'),
      readFile(resolve('apps/web/src/styles/element/index.scss'), 'utf8'),
      readFile(resolve('apps/web/vite.config.ts'), 'utf8'),
    ])

    // 预加载入口保持精简：Element Plus 一律在特性内按需导入，主题按组件逐一 @use 白名单。
    expect(main).not.toMatch(/^\s*app\.use\(ElementPlus\)/m)
    expect(main).not.toContain('element-plus')
    expect(theme).not.toContain('theme-chalk/src/index.scss')
    expect(theme).toContain('theme-chalk/src/tooltip.scss')
    expect(markdown).toContain("from 'highlight.js/lib/core'")
    expect(markdown).not.toContain("from 'highlight.js'")
    expect(viteConfig).not.toContain("return 'vendor-markdown'")
    expect(viteConfig).toContain("return 'vendor-ui'")
  })
})
