import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Nyxus workbench preferences and entry regressions', () => {
  it('defaults to timeline with the third fold level and persists both selections', async () => {
    const source = await readFile(
      resolve('web/src/features/agent/dialog/WorkbenchDialog.vue'),
      'utf8',
    )

    expect(source).toContain("layout: 'timeline'")
    expect(source).toContain("foldMode: 'participant'")
    expect(source).toContain("const WORKBENCH_VIEW_STORAGE_PREFIX = 'nx-workbench-view:'")
    expect(source).toContain('watch([topologyLayout, foldMode], saveWorkbenchViewPreference)')
  })

  it('refreshes only the lightweight catalog before opening from Cherry Nyxus', async () => {
    const lifecycle = await readFile(resolve('web/src/stores/agents/data/petLifecycle.ts'), 'utf8')
    const getActive = lifecycle.slice(
      lifecycle.indexOf('async function getActiveNyxus'),
      lifecycle.indexOf('/** 始终新建一条 Nyxus 会话'),
    )
    const core = await readFile(
      resolve('web/src/features/pets/nyxus/components/NyxusCore.vue'),
      'utf8',
    )
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
    const source = await readFile(
      resolve('web/src/features/agent/dialog/WorkbenchDialog.vue'),
      'utf8',
    )

    expect(source).toContain(":global([data-theme='dark']) .role-usage-chip.usage-low")
    expect(source).toContain('color: #86efac;')
    expect(source).toContain('color: #fde047;')
    expect(source).toContain('color: #fca5a5;')
  })
})
