import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readComponentSource } from '../helpers/componentSource'

describe('cyber window embedded shell ownership', () => {
  it('gives browser CyberWindow the only window chrome', async () => {
    const app = await readComponentSource(resolve('web/src/App.vue'), 'utf8')
    const browser = app.slice(app.indexOf('<CyberDesktopHost>'), app.indexOf('</CyberDesktopHost>'))

    expect(browser).toContain('<AgentDialog v-if="workspace.activeDialogChatId" embedded />')
    expect(browser).toContain('<HistoryDrawer embedded />')
    expect(browser).toContain('<SettingsDialog v-if="workspace.settingsOpen" embedded />')
    expect(browser).toContain('v-for="entry in browserWorkbenchWindows"')
    expect(browser).toContain(':window-id="entry.workbench.id"')
    expect(browser).toContain('embedded')
    expect(browser).toContain('<WorkbenchViewToggle :window-id="entry.workbench.id" />')
    expect(browser).not.toContain('<AgentDialog v-if="workspace.activeDialogChatId" native />')
    expect(browser).not.toContain('<SettingsDialog v-if="workspace.settingsOpen" native />')
  })

  it('keeps title controls clickable and maximizes relative to the desktop stage', async () => {
    const [windowSource, hostSource] = await Promise.all([
      readComponentSource(resolve('web/src/features/desktop/CyberWindow.vue'), 'utf8'),
      readComponentSource(resolve('web/src/features/desktop/CyberDesktopHost.vue'), 'utf8'),
    ])

    expect(windowSource).toContain('[data-window-interactive],button,input,select,textarea,a')
    expect(windowSource).toContain('<slot name="title-actions" />')
    expect(windowSource).toContain("emit('toggleMaximize', props.window.id)")
    expect(hostSource).toContain('workspace.setWorkspaceStageSize')
    expect(hostSource).toContain('ref="stage"')
  })

  it('stretches embedded content and removes the legacy Agent and Settings shells', async () => {
    const [windowSource, agentSource, settingsSource] = await Promise.all([
      readComponentSource(resolve('web/src/features/desktop/CyberWindow.vue'), 'utf8'),
      readComponentSource(resolve('web/src/features/agent/chat/AgentDialog.vue'), 'utf8'),
      readComponentSource(resolve('web/src/features/agent/settings/SettingsDialog.vue'), 'utf8'),
    ])

    expect(windowSource).toContain('.cyber-window-body > :deep(*)')
    expect(windowSource).toContain('min-width: 0;')
    expect(windowSource).toContain('min-height: 0;')
    expect(agentSource).toContain(
      'const shellless = computed(() => props.native || props.embedded)',
    )
    expect(agentSource).toContain('<header v-if="!shellless" class="dialog-head"')
    expect(agentSource).toContain('.dialog-overlay.is-embedded')
    expect(agentSource).toContain('.dialog-panel::before,')
    expect(agentSource).toContain('display: none;')
    expect(settingsSource).toContain('const isShellless = computed(')
    expect(settingsSource).toContain('<header v-if="!isShellless" class="head"')
    expect(settingsSource).toContain('.settings-panel.is-embedded')
    expect(settingsSource).toContain('transform: none !important;')
  })

  it('turns the embedded history drawer into full-size content with stack navigation', async () => {
    const [drawerSource, panelSource] = await Promise.all([
      readComponentSource(resolve('web/src/features/agent/drawer/HistoryDrawer.vue'), 'utf8'),
      readComponentSource(resolve('web/src/features/agent/drawer/HistoryDrawerPanel.vue'), 'utf8'),
    ])

    expect(drawerSource).toContain(':embedded="embedded"')
    expect(drawerSource).toContain(':can-go-back="embedded && i > 0"')
    expect(panelSource).toContain('v-if="!embedded"')
    expect(panelSource).toContain('v-if="!embedded || canGoBack"')
    expect(panelSource).toContain("embedded ? '返回上一层历史' : '关闭历史'")
    expect(panelSource).toContain('.drawer-panel.is-embedded')
    expect(panelSource).toContain('width: 100%;')
    expect(panelSource).toContain('box-shadow: none;')
  })
})
