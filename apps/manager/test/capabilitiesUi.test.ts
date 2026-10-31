import { describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick } from 'vue'
import { readFile } from 'node:fs/promises'
import { useCapabilities } from '../../../plugins/settings/ui/useCapabilities'
import { createSettingsPackage as createCapabilitiesModule } from './settingsPackage.js'

const catalog = { brains: ['base'], senseGroups: ['tools'], presets: ['default'], tools: [{ name: 'read_file', description: 'Read files' }], baseRevision: 'r1' }
const apply = { status: 'applied', restart: { required: false } }
function setup(handler: (path: string, init?: RequestInit) => any) {
  const request = vi.fn(async (path: string, init?: RequestInit) => handler(path, init))
  const scope = effectScope()
  const ui = scope.run(() => useCapabilities(request as any))!
  return { ui, request, scope }
}

describe('Manager capabilities workflow', () => {
  it('saves a real array of auto tool entries and accepts same-name readback', async () => {
    const { ui, request, scope } = setup((path, init) => path.endsWith('/catalog') ? { data: catalog } : { data: { name: 'new-tools', value: JSON.parse(String(init?.body)).value, baseRevision: 'r2', apply } })
    await ui.loadCatalog(); ui.editors['sense-groups'].name = 'new-tools'; ui.addTool('read_file'); ui.addTool('read_file')
    expect(ui.editors['sense-groups'].value).toEqual(['read_file:auto'])
    await ui.saveResource('sense-groups')
    expect(JSON.parse(String(request.mock.calls[1]?.[1]?.body))).toMatchObject({ name: 'new-tools', value: ['read_file:auto'], expectedBaseRevision: 'r1' })
    expect(ui.editors['sense-groups'].selected).toBe('new-tools')
    expect(ui.editors['sense-groups'].message).toContain('已回读确认')
    scope.stop()
  })
  it('keeps stale draft revisions on catalog refresh and stops writes after conflicts', async () => {
    let revision = 'r1'
    const { ui, request, scope } = setup(path => { if (path.endsWith('/catalog')) return { data: { ...catalog, baseRevision: revision } }; throw new Error('配置版本已变化，请重新读取同名资源后再保存。') })
    await ui.loadCatalog(); ui.editors.brains.name = 'new'; ui.editors.brains.value.provider = 'openai'; ui.editors.brains.value.model = 'synthetic'; ui.editors.brains.value.contextLimit = 128000; ui.editors.brains.key = 'synthetic-secret'
    revision = 'r2'; await ui.loadCatalog()
    expect(ui.editors.brains.revision).toBe('r1')
    await ui.saveResource('brains')
    expect(ui.editors.brains.error).toContain('版本'); expect(ui.editors.brains.key).toBe(''); expect(ui.editors.brains.uncertain).toBe(true)
    const calls = request.mock.calls.length; await ui.saveResource('brains'); expect(request.mock.calls.length).toBe(calls)
    scope.stop()
  })
  it('renders normalized model IDs and never shows upstream key-bearing model errors', async () => {
    let fail = false
    const { ui, scope } = setup(path => path.endsWith('/catalog') ? { data: catalog } : fail ? { data: { error: 'synthetic-secret', models: [] } } : { data: { models: [{ id: 'model-x', name: 'Model X' }] } })
    await ui.loadCatalog(); ui.editors.brains.value.url = 'https://example.test/v1'; ui.editors.brains.key = 'synthetic-secret'; await nextTick()
    await ui.fetchModels(); expect(ui.model.options).toEqual([{ id: 'model-x', name: 'Model X' }])
    fail = true; await ui.fetchModels(); expect(ui.model.error).toContain('URL 和 Key'); expect(ui.model.error).not.toContain('synthetic-secret'); expect(ui.model.options).toEqual([])
    scope.stop()
  })
  it('preserves preset fields and references on same-name edit', async () => {
    const value = { brain: 'base', senseGroup: 'tools', leader: 'role-x', id: 'stable-preset', roles: ['role-x'], custom: 'preserve' }
    const { ui, request, scope } = setup((path, init) => path.endsWith('/catalog') ? { data: catalog } : { data: { name: 'default', value: init?.body ? JSON.parse(String(init.body)).value : value, baseRevision: 'r1', apply } })
    await ui.loadCatalog(); ui.editors.presets.selected = 'default'; await ui.openResource('presets'); await ui.saveResource('presets')
    expect(JSON.parse(String(request.mock.calls[2]?.[1]?.body)).value).toEqual(value)
    expect(request.mock.calls[2]?.[1]?.method).toBe('PUT')
    scope.stop()
  })
  it('offers three peer regions and supported-only thinking, without fake manual permission', async () => {
    const source = await readFile(new URL('../../../plugins/settings/ui/CapabilitiesPanel.vue', import.meta.url), 'utf8')
    expect(source).toContain('grid-template-columns: minmax(0, 1fr)')
    expect(source).toContain('data-capability="kind"')
    expect(source).toContain('允许自动')
    expect(source).toContain('value="manual"')
    expect(source).toContain('v-for="level in thinkingLevels"')
    expect(source).toContain('不支持用户反馈/用户交互相关操作')
    expect(source).not.toContain('<select')
    expect(source).toContain('import Dropdown')
    expect(source).not.toMatch(/localStorage|sessionStorage/)
  })
  it('reports offline catalog and missing resource without leaving stale editable data', async () => {
    const { ui, scope } = setup(() => { throw new Error('依赖服务不可用') })
    await ui.loadCatalog(); expect(ui.state.ready).toBe(false); expect(ui.state.error).toContain('不可用')
    ui.editors.brains.selected = 'gone'; await ui.openResource('brains'); expect(ui.editors.brains.uncertain).toBe(true)
    scope.stop()
  })
})

describe('protected capability adapters', () => {
  it('masks model fetch errors and forwards recommendation only to fixed RPC', async () => {
    const call = vi.fn(async (method: string) => method === 'utils.models' ? { models: [], error: 'secret upstream' } : { matched: true, confidence: 'exact', unknown: {}, thinkingLevels: ['off', 'high'] })
    const module = createCapabilitiesModule({ call } as any)
    const models = await module.handle({ method: 'POST', url: new URL('http://localhost/api/modules/capabilities/models'), body: { provider: 'custom', url: 'https://example.test/v1', key: 'synthetic' } })
    expect(models.status).toBe(502); expect(JSON.stringify(models.body)).not.toContain('secret upstream')
    const rejected = await module.handle({ method: 'POST', url: new URL('http://localhost/api/modules/capabilities/model-recommendation'), body: { model: 'synthetic', key: 'do-not-forward' } })
    expect(rejected.status).not.toBe(200)
    const result = await module.handle({ method: 'POST', url: new URL('http://localhost/api/modules/capabilities/model-recommendation'), body: { model: 'synthetic', provider: 'custom', protocol: 'openai-responses' } })
    expect(result.status).toBe(200)
    expect(call.mock.calls[1]).toEqual(['utils.modelRecommendation', { model: 'synthetic', provider: 'custom', protocol: 'openai-responses' }])
  })
})
