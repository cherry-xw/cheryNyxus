import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readComponentSource } from '../helpers/componentSource'

describe('frontend cold-start bundle boundaries', () => {
  it('loads heavy surfaces only when their application state opens them', async () => {
    const source = await readComponentSource(resolve('web/src/App.vue'), 'utf8')

    expect(source).toContain('defineAsyncComponent')
    expect(source).toContain("import('@/features/agent/chat/AgentDialog.vue')")
    expect(source).toContain("import('@/features/agent/workbench/WorkbenchDialog.vue')")
    expect(source).toContain("import('@/features/agent/drawer/HistoryDrawer.vue')")
    expect(source).toContain("import('@/features/agent/settings/SettingsDialog.vue')")
    expect(source).toContain('<AgentDialog v-if="workspace.activeDialogChatId" />')
    expect(source).toContain('<HistoryDrawer v-if="workspace.historyDrawerStack.length > 0" />')
    expect(source).toContain('<SettingsDialog v-if="workspace.settingsOpen" />')
    expect(source).not.toContain("from '@/features/pets/nyxus/public'")
  })

  it('keeps Element Plus and syntax highlighting on explicit allowlists', async () => {
    const [main, markdown, theme] = await Promise.all([
      readFile(resolve('web/src/main.ts'), 'utf8'),
      readFile(resolve('web/src/utils/markdown.ts'), 'utf8'),
      readFile(resolve('web/src/styles/element/index.scss'), 'utf8'),
    ])

    expect(main).not.toMatch(/^\s*app\.use\(ElementPlus\)/m)
    expect(main).toContain('const elementComponents = [')
    expect(markdown).toContain("from 'highlight.js/lib/core'")
    expect(markdown).not.toContain("from 'highlight.js'")
    expect(theme).not.toContain('theme-chalk/src/index.scss')
    expect(theme).toContain('theme-chalk/src/tooltip.scss')
  })
})
