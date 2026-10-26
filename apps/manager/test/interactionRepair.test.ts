import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { effectScope, nextTick } from 'vue'
import { requestId } from '../../../packages/manager-ui/src/requestId'
import { useCapabilities } from '../../../plugins/settings/ui/useCapabilities'
import { SettingsService as CapabilityService } from '../../../plugins/settings/src/service.js'

const apply = { status: 'applied', restart: { required: false } }
describe('Manager interaction repairs', () => {
  it('generates IDs without secure-context randomUUID across all Manager UI and plugin UI sources', () => {
    const crypto = globalThis.crypto
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) })
    try { expect(requestId()).toMatch(/^[0-9a-f-]{36}$/); expect(requestId()).not.toBe(requestId()) }
    finally { vi.unstubAllGlobals() }
    for (const file of [
      'plugins/settings/ui/FilesSettings.vue',
      'plugins/settings/ui/useCapabilities.ts',
      'plugins/qq/ui/useQq.ts',
      'apps/manager/ui/usePlugins.ts',
    ]) {
      expect(readFileSync(file, 'utf8')).not.toContain('crypto.randomUUID')
    }
  })
  it('allows consecutive saves, keeps thinking and permissions, filters added tools', async () => {
    let revision = 1
    const catalog = { brains: [], senseGroups: [], presets: [], tools: [{ name: 'read_file' }], baseRevision: '1' }
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith('catalog')) return { data: { ...catalog, baseRevision: String(revision) } }
      if (path.endsWith('model-recommendation')) return { data: { thinkingLevels: [] } }
      const body = JSON.parse(String(init?.body)); revision++
      return { data: { name: body.name, value: body.value, baseRevision: String(revision), apply, secrets: { keyConfigured: true } } }
    })
    const scope = effectScope(); const ui = scope.run(() => useCapabilities(request as any))!
    await ui.loadCatalog()
    ui.addTool('read_file'); expect(ui.availableTools.value).toHaveLength(0)
    ui.editors['sense-groups'].value = ['read_file:manual']; ui.editors['sense-groups'].name = 'tools'
    await ui.saveResource('sense-groups'); expect(ui.editors['sense-groups'].value).toEqual(['read_file:manual'])
    ui.editors.brains.name = 'model'; ui.editors.brains.value.provider = 'openai'; ui.editors.brains.value.model = 'synthetic'; ui.editors.brains.value.contextLimit = 128000; ui.editors.brains.value.thinking = 'high'
    await ui.saveResource('brains'); ui.editors.brains.value.thinking = 'low'; await ui.saveResource('brains')
    expect(ui.editors.brains.value.thinking).toBe('low'); expect(ui.busy('brains')).toBe(false); expect(ui.editors.brains.uncertain).toBe(false)
    expect(ui.thinkingLevels.value).toEqual([]); scope.stop()
  })
  it('fetches repeatedly using saved identity without returning a key', async () => {
    const request = vi.fn(async () => ({ data: { models: [{ id: 'synthetic' }] } }))
    const scope = effectScope(); const ui = scope.run(() => useCapabilities(request as any))!
    ui.editors.brains.selected = 'saved'; ui.editors.brains.revision = 'r1'; ui.editors.brains.keyConfigured = true; ui.editors.brains.value.url = 'https://example.test/v1'
    await nextTick(); await ui.fetchModels(); await ui.fetchModels()
    for (const args of request.mock.calls as any[]) expect(JSON.parse(args[1].body)).toMatchObject({ savedBrain: 'saved', expectedBaseRevision: 'r1' })
    expect(ui.editors.brains.key).toBe(''); scope.stop()
  })
})
