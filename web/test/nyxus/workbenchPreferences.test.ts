import { readComponentSource } from '../helpers/componentSource'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Nyxus workbench preferences and entry regressions', () => {
  it('keeps one topology canvas and persists only folding plus the external reader', async () => {
    const source = await readComponentSource(
      resolve('src/features/agent/workbench/WorkbenchDialog.vue'),
      'utf8',
    )

    expect(source).toContain("foldMode: 'participant'")
    expect(source).toContain('readerOpen: false')
    expect(source).toContain("const WORKBENCH_VIEW_STORAGE_PREFIX = 'nx-workbench-view:'")
    expect(source).toContain('value?.paperMode === true')
    expect(source).toContain('watch([foldMode, readerOpen], saveWorkbenchViewPreference)')
    expect(source).toContain('<RuntimeDiagram')
    expect(source).toContain('<NyxusContentReader')
    expect(source).not.toContain('<MessageBranchTree')
    expect(source).toContain(':aria-pressed="readerOpen"')
    expect(source).toContain('data-view-action="reader"')
    expect(source).not.toContain('data-view-action="layout"')
    expect(source).not.toContain('data-view-action="paper"')
    const sideTools = source.indexOf('class="nyxus-side-tools"')
    const scrollColumn = source.indexOf('<div class="nyxus-tool-column">', sideTools)
    const readerAction = source.indexOf('data-view-action="reader"', scrollColumn)
    expect(sideTools).toBeGreaterThan(-1)
    expect(scrollColumn).toBeGreaterThan(sideTools)
    expect(readerAction).toBeGreaterThan(scrollColumn)
    expect(source).toContain('max-height: calc(100% - 37px)')
    expect(source).toContain(`:class="{ 'has-open-popout': roleListOpen || sessionListOpen }"`)
    expect(source).toContain('z-index: var(--nx-z-side-popover)')
    const offlineMask = await readComponentSource(
      resolve('src/features/agent/workbench/WorkbenchOfflineMask.vue'),
      'utf8',
    )
    expect(offlineMask).toContain('z-index: var(--nx-z-connection-mask)')
    expect(source).toContain('grid-template-columns: minmax(0, 1fr) clamp(340px, 34vw, 440px)')
    expect(source).toContain('v-show="workspaceBrowserOpen"')
    expect(source).toContain('这里的操作始终针对当前待处理请求')
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

  it('allows archiving the final session and explains where it remains accessible', async () => {
    const source = await readComponentSource(
      resolve('src/features/agent/workbench/WorkbenchDialog.vue'),
      'utf8',
    )
    const deletePreset = source.slice(
      source.indexOf('async function deletePresetSession'),
      source.indexOf('async function createSession'),
    )
    const deleteNyxus = source.slice(
      source.indexOf('async function deleteNyxusSession'),
      source.indexOf('onScopeDispose(releaseCurrentRoot)'),
    )

    expect(deletePreset).not.toContain('请先新建一个会话')
    expect(deletePreset).toContain('await agents.deleteSession(chatId)')
    expect(deleteNyxus).toContain('await deletePresetSession(chatId)')
    expect(deleteNyxus).not.toContain("treeRootChatId.value = ''")
    expect(deleteNyxus).not.toContain('await switchSession(')
    expect(deletePreset).toContain("ElMessage.success('会话已归档，可在设置 → 归档中查看')")
    expect(deletePreset).toContain('options.setError(message)')
  })

  it('keeps enough active-session state to select the newest remaining session after deletion', async () => {
    const source = await readComponentSource(
      resolve('src/features/agent/workbench/WorkbenchDialog.vue'),
      'utf8',
    )
    const deletion = source.slice(
      source.indexOf('async function onSessionDelete'),
      source.indexOf('function activateNyxusInput'),
    )
    const captureActiveSession = deletion.indexOf(
      'const deletingActiveSession = targetChatId === chatId.value',
    )
    const deleteRequest = deletion.indexOf('await deleteNyxusSession(targetChatId)')

    expect(captureActiveSession).toBeGreaterThan(-1)
    expect(captureActiveSession).toBeLessThan(deleteRequest)
    expect(deletion).toContain('if (deletingActiveSession && !chatId.value)')
    expect(deletion).toContain(
      'rootSessions.value.find((session) => session.chatId !== targetChatId)?.chatId',
    )
    expect(deletion).not.toContain('if (targetChatId === chatId.value)')
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
