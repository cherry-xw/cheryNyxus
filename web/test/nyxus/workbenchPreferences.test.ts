import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Nyxus workbench preferences and entry regressions', () => {
  it('defaults to timeline with the third fold level and persists both selections', async () => {
    const source = await readFile(resolve('src/features/agent/dialog/WorkbenchDialog.vue'), 'utf8')

    expect(source).toContain("layout: 'timeline'")
    expect(source).toContain("foldMode: 'participant'")
    expect(source).toContain("const WORKBENCH_VIEW_STORAGE_PREFIX = 'nx-workbench-view:'")
    expect(source).toContain('paperMode: false')
    expect(source).toContain('paperMode: value?.paperMode === true')
    expect(source).toContain(
      'watch([topologyLayout, foldMode, paperMode], saveWorkbenchViewPreference)',
    )
    expect(source).toContain(':aria-pressed="paperMode"')
    expect(source).toContain('data-view-action="layout"')
    const sideTools = source.indexOf('<nav class="nyxus-side-tools"')
    const pinnedLayout = source.indexOf('nyxus-pinned-layout-action', sideTools)
    const layoutAction = source.indexOf('data-view-action="layout"', pinnedLayout)
    const scrollColumn = source.indexOf('<div class="nyxus-tool-column">', layoutAction)
    expect(sideTools).toBeGreaterThan(-1)
    expect(pinnedLayout).toBeGreaterThan(sideTools)
    expect(layoutAction).toBeGreaterThan(pinnedLayout)
    expect(scrollColumn).toBeGreaterThan(layoutAction)
    expect(source).toContain('max-height: calc(100% - 37px)')
    expect(source).toContain("topologyLayout ? '按节点顺序逐行排列' : '允许并行节点同行'")
  })

  it('refreshes only the lightweight catalog before opening from Cherry Nyxus', async () => {
    const lifecycle = await readFile(resolve('src/stores/agents/data/petLifecycle.ts'), 'utf8')
    const getActive = lifecycle.slice(
      lifecycle.indexOf('async function getActiveNyxus'),
      lifecycle.indexOf('/** 始终新建一条 Nyxus 会话'),
    )
    const core = await readFile(resolve('src/features/pets/nyxus/components/NyxusCore.vue'), 'utf8')
    const openWorkbench = core.slice(
      core.indexOf('async function openWorkbench'),
      core.indexOf('onBeforeUnmount(()'),
    )

    expect(getActive).toContain('agentApi.listChats(false)')
    expect(getActive.indexOf('agentApi.listChats(false)')).toBeLessThan(
      getActive.indexOf('activeNyxusChatId.value &&'),
    )
    expect(openWorkbench).toContain('await agents.getActiveNyxus()')
    expect(openWorkbench).not.toContain('fetchHistoryList')
  })

  it('provides explicit high-contrast context colors in dark mode', async () => {
    const source = await readFile(resolve('src/features/agent/dialog/WorkbenchDialog.vue'), 'utf8')

    expect(source).toContain(":global([data-theme='dark']) .role-usage-chip.usage-low")
    expect(source).toContain('color: #86efac;')
    expect(source).toContain('color: #fde047;')
    expect(source).toContain('color: #fca5a5;')
  })
})
