import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const SETTINGS_DIALOG = resolve(
  import.meta.dirname,
  '../../src/features/agent/settings/SettingsDialog.vue',
)
const SETTINGS_CONTROLLER = resolve(
  import.meta.dirname,
  '../../src/features/agent/settings/useSettingsDialogController.ts',
)
const HOOKS_TAB = resolve(
  import.meta.dirname,
  '../../src/features/agent/settings/tabs/hooks/HooksTab.vue',
)

describe('settings tab visibility', () => {
  it('mounts exactly one tab through a v-if chain', async () => {
    const source = await readFile(SETTINGS_DIALOG, 'utf8')
    const paneTabs = [
      ...source.matchAll(
        /<div v-(?:if|else-if)="renderedTab === '([^']+)'" class="tab-pane">/g,
      ),
    ].map((match) => match[1])

    expect(paneTabs).toEqual([
      'brains',
      'media',
      'senses',
      'roles',
      'presets',
      'mcp',
      'global',
      'commands',
      'hooks',
      'skills',
      'plugins',
    ])
    expect(source).not.toContain('v-show=')
  })

  it('keeps the independent Hooks draft in the settings controller', async () => {
    const [dialog, controller, hooksTab] = await Promise.all([
      readFile(SETTINGS_DIALOG, 'utf8'),
      readFile(SETTINGS_CONTROLLER, 'utf8'),
      readFile(HOOKS_TAB, 'utf8'),
    ])

    expect(controller).toContain('const hooksState = reactive<')
    expect(controller).toContain("if (tab === 'hooks') await loadHooksData()")
    expect(dialog).toContain(':handlers="hooksState.handlers"')
    expect(dialog).toContain('@update:handlers="updateHooksHandlers"')
    expect(hooksTab).toContain("emit('update:handlers', next)")
    expect(hooksTab).not.toContain('onMounted(loadHooks)')
  })

  it('paints a loading skeleton before mounting the selected tab', async () => {
    const [dialog, controller] = await Promise.all([
      readFile(SETTINGS_DIALOG, 'utf8'),
      readFile(SETTINGS_CONTROLLER, 'utf8'),
    ])

    expect(dialog).toContain('v-if="loading || tabSwitching"')
    expect(dialog).toContain(':aria-busy="loading || tabSwitching"')
    expect(controller).toContain('const renderedTab = ref<TabKey | null>')
    expect(controller).toContain('await waitForLoadingPaint()')
    expect(controller).toContain('if (seq !== tabRenderSeq) return')
  })
})
