import { readComponentSource } from '../helpers/componentSource'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('Pet composer and workbench exclusivity', () => {
  it('keeps the browser composer state while hiding its duplicate surface', async () => {
    const source = await readComponentSource(
      fileURLToPath(new URL('../../src/features/agent/chat/AgentDialog.vue', import.meta.url)),
      'utf8',
    )

    expect(source).toContain("if (agents.activeDialogSource !== 'pet') return false")
    expect(source).toContain('!!agents.workbenchWindows[presetId]')
    expect(source).toContain('!!chatId.value && !petWorkbenchOpen.value')
  })

  it('restores the native composer when its workbench closes', async () => {
    const [dialog, main] = await Promise.all([
      readComponentSource(
        fileURLToPath(new URL('../../src/features/agent/chat/AgentDialog.vue', import.meta.url)),
        'utf8',
      ),
      readComponentSource(fileURLToPath(new URL('../../electron/main.ts', import.meta.url)), 'utf8'),
    ])

    expect(dialog).toContain("returnToComposer: agents.activeDialogSource === 'pet'")
    expect(main).toContain("entry.restoreWindowKeyOnHide = 'composer'")
    expect(main).toContain('restoreSourceWindow(entry)')
  })
})
