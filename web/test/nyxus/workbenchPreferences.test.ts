import { readComponentSource } from '../helpers/componentSource'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  layoutModeForFoldMode,
  type FoldMode,
} from '../../src/features/agent/workbench/useWorkbenchViewPreferences'

describe('Nyxus workbench preferences and entry regressions', () => {
  it('uses compact columns only for the fourth fold level', () => {
    const modes: FoldMode[] = ['none', 'partial', 'participant', 'full']

    expect(modes.map(layoutModeForFoldMode)).toEqual([
      'timeline',
      'timeline',
      'timeline',
      'topology',
    ])
  })

  it('keeps the Pixi tree primary and makes auxiliary views mutually exclusive', async () => {
    const source = await readComponentSource(
      resolve('src/features/agent/workbench/WorkbenchDialog.vue'),
      'utf8',
    )

    expect(source).toContain("foldMode: 'participant'")
    expect(source).toContain("const WORKBENCH_VIEW_STORAGE_PREFIX = 'nx-workbench-view:'")
    expect(source).toContain('watch(foldMode, saveWorkbenchViewPreference)')
    expect(source).toContain("type WorkbenchSidePanel = 'none' | 'cards' | 'workflow' | 'reader'")
    expect(source).toContain("const sidePanel = ref<WorkbenchSidePanel>('none')")
    expect(source).toContain('<RuntimeDiagram')
    expect(source).toContain('<NyxusContentReader')
    expect(source).toContain('<MessageBranchTree')
    expect(source).toContain('v-if="!treeRootChatId" class="workbench-empty-state"')
    expect(source).toContain('v-if="sidePanel === \'workflow\'"')
    expect(source).toContain('v-else-if="sidePanel === \'reader\'"')
    expect(source).toContain("paperMode: sidePanel.value === 'cards'")
    expect(source).toContain("presentationMode: 'horizontal-signal'")
    expect(source).toContain(':aria-pressed="sidePanel === \'reader\'"')
    expect(source).toContain('data-view-action="reader"')
    expect(source).not.toContain('data-view-action="layout"')
    expect(source).toContain('data-view-action="cards"')
    expect(source).toContain('data-view-action="workflow"')
    const sideTools = source.indexOf('class="nyxus-side-tools"')
    const scrollColumn = source.indexOf('<div class="nyxus-tool-column">', sideTools)
    const readerAction = source.indexOf('data-view-action="reader"', scrollColumn)
    expect(sideTools).toBeGreaterThan(-1)
    expect(scrollColumn).toBeGreaterThan(sideTools)
    expect(readerAction).toBeGreaterThan(scrollColumn)
    expect(source).toContain('max-height: calc(100% - 37px)')
    // 2026-09-16：rail ≡ 会话列表 popout 移除（切换入口上移标题栏会话状态条），互斥态只剩角色列表。
    expect(source).toContain(`:class="{ 'has-open-popout': roleListOpen }"`)
    expect(source).toContain('z-index: var(--nx-z-side-popover)')
    const offlineMask = await readComponentSource(
      resolve('src/features/agent/workbench/WorkbenchOfflineMask.vue'),
      'utf8',
    )
    expect(offlineMask).toContain('z-index: var(--nx-z-connection-mask)')
    expect(source).not.toContain('<WorkbenchReaderSplit')
    expect(source).toContain('v-if="currentAttentionCount && !attentionCollapsed"')
    expect(source).toContain('@click="toggleAttentionWindow"')
    expect(source).not.toContain('其他流程的审批与提问')
    expect(source).not.toContain('workspaceBrowserOpen')
  })

  it('refreshes only the lightweight catalog before opening from Cherry Nyxus', async () => {
    const lifecycle = await readComponentSource(
      resolve('src/stores/agents/data/petLifecycle.ts'),
      'utf8',
    )
    const getActive = lifecycle.slice(
      lifecycle.indexOf('async function getActiveNyxus'),
      lifecycle.indexOf('/** 始终新建一条 Nyxus 会话'),
    )
    const core = await readComponentSource(
      resolve('src/features/pets/nyxus/components/NyxusCore.vue'),
      'utf8',
    )
    const openWorkbench = core.slice(
      core.indexOf('async function openWorkbench'),
      core.indexOf('onBeforeUnmount(()'),
    )

    expect(getActive).toContain("scope: 'preset'")
    expect(getActive.indexOf("scope: 'preset'")).toBeLessThan(
      getActive.indexOf('activeNyxusChatId.value &&'),
    )
    expect(openWorkbench).toContain('await agents.getActiveNyxus()')
    expect(openWorkbench).not.toContain('fetchHistoryList')
  })

  it('provides explicit high-contrast context colors in dark mode', async () => {
    const source = await readComponentSource(
      resolve('src/features/agent/workbench/WorkbenchDialog.vue'),
      'utf8',
    )

    expect(source).toContain(":global([data-theme='dark']) .role-usage-chip.usage-low")
    expect(source).toContain('color: #86efac;')
    expect(source).toContain('color: #fde047;')
    expect(source).toContain('color: #fca5a5;')
  })
})
