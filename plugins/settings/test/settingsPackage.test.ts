import { describe, expect, it, vi } from 'vitest'
import { createPlugin, SettingsService } from '../src/index.js'
import type { IngressContext } from '@chery/plugin-api'
import { SettingsResourceSaveRequestSchema, SettingsResourceViewSchema } from '../../../packages/protocol/src/settings.js'

const apply = {
  protocolVersion: 2, savedRevision: 'r1', appliedRevision: 'r1', status: 'applied',
  impacts: [], restart: { required: false, status: 'none' },
}
function fixture() {
  let config: any = { baseRevision: 'r1', global: {}, llm: { brain: {
    main: { provider: 'mock', model: 'offline', key: 'only-write-secret' },
  } }, sense_groups: { tools: ['execute_command:auto'] }, roles: {}, presets: {} }
  const call = vi.fn(async (method: string, params: any) => {
    if (method === 'config.get') return structuredClone(config)
    if (method === 'config.apply.status') return apply
    if (method === 'config.preview') return { protocolVersion: 2, baseRevision: 'r1', previewToken: 'preview', impacts: [], destructiveTargets: [], policy: 'wait' }
    if (method === 'config.save') {
      config = { ...structuredClone(params.candidate), baseRevision: 'r2' }
      return { ...apply, baseRevision: 'r2', candidateRevisionId: 'candidate', warnings: [] }
    }
    throw new Error('Unexpected method: ' + method)
  })
  return { call, service: new SettingsService({ call }), get: () => config }
}
describe('settings Backend package', () => {
  it('prepares management only, exposes every settings route and no business RPC', async () => {
    const register = vi.fn()
    const coreCall = vi.fn()
    const plugin = createPlugin({ resources: { resolve() { throw new Error('RESOURCE_NOT_DECLARED') } }, management: { register, coreCall } } as unknown as IngressContext)
    expect(plugin.validateConfig({})).toEqual({})
    expect(() => plugin.validateConfig({ secret: 'no' })).toThrow()
    await plugin.start()
    expect(register).not.toHaveBeenCalled()
    await plugin.prepareManagement!()
    await plugin.prepareManagement!()
    expect(register).toHaveBeenCalledTimes(1)
    const definition = register.mock.calls[0]![0]
    expect(definition.moduleId).toBe('capabilities')
    expect(definition.routes.map((r: any) => `${r.method} ${r.path}`)).toEqual([
      'GET catalog', 'GET apply', 'GET resources/:kind', 'POST resources/:kind',
      'PUT resources/:kind', 'DELETE resources/:kind', 'POST models', 'POST model-recommendation',
      'GET prompts', 'PUT prompts', 'GET search-settings', 'PUT search-settings',
    ])
    expect(definition.routes.every((r: any) => r.rpcMethod.startsWith('settings.'))).toBe(true)
    await plugin.stop()
    expect(coreCall).not.toHaveBeenCalled()
  })
  it('rejects mismatched values, extra request fields and keys on reads', () => {
    const request = { pathParams: { kind: 'sense-groups' }, query: {},
      body: { name: 'tools', value: ['missing:auto'], expectedBaseRevision: 'r1', requestId: 'one' } }
    expect(SettingsResourceSaveRequestSchema.safeParse(request).success).toBe(true)
    expect(SettingsResourceSaveRequestSchema.safeParse({ ...request, body: { ...request.body, value: { model: 'bad' } } }).success).toBe(false)
    expect(SettingsResourceSaveRequestSchema.safeParse({ ...request, query: { arbitrary: 'method' } }).success).toBe(false)
    expect(SettingsResourceViewSchema.safeParse({ kind: 'brains', name: 'main', baseRevision: 'r1', apply,
      value: { provider: 'mock', model: 'offline', key: 'secret' }, secrets: { keyConfigured: true } }).success).toBe(false)
  })
  it('preserves omitted keys, clears explicit keys, previews and confirms saves, and deduplicates requests', async () => {
    const f = fixture()
    const body = { name: 'main', value: { model: 'changed' }, expectedBaseRevision: 'r1', requestId: 'save' }
    const result = await f.service.save('brains', false, body)
    expect(f.get().llm.brain.main.key).toBe('only-write-secret')
    expect(JSON.stringify(result)).not.toContain('only-write-secret')
    expect(result.secrets).toEqual({ keyConfigured: true })
    expect(f.call.mock.calls.map(c => c[0])).toContain('config.preview')
    expect(await f.service.save('brains', false, body)).toEqual(result)
    expect(f.call.mock.calls.filter(c => c[0] === 'config.save')).toHaveLength(1)
    await expect(f.service.save('brains', false, { ...body, value: { key: '' } })).rejects.toMatchObject({ code: 'request_conflict' })
    const cleared = await f.service.save('brains', false, { ...body, value: { key: '' }, expectedBaseRevision: 'r2', requestId: 'clear' })
    expect(cleared.secrets).toEqual({ keyConfigured: false })
    expect(f.get().llm.brain.main.key).toBe('')
  })
  it('does not retry unknown writes and preserves explicit rejection', async () => {
    const f = fixture()
    f.call.mockImplementation(async method => {
      if (method === 'config.get') return structuredClone(f.get())
      if (method === 'config.preview') return { protocolVersion: 2, baseRevision: 'r1', previewToken: 'preview', impacts: [], destructiveTargets: [], policy: 'wait' }
      throw new Error('connection lost')
    })
    await expect(f.service.save('brains', false, { name: 'main', value: {}, expectedBaseRevision: 'r1', requestId: 'unknown' })).rejects.toMatchObject({ code: 'save_unconfirmed' })
    expect(f.call.mock.calls.filter(c => c[0] === 'config.save')).toHaveLength(1)
  })
  it('renames references through core preview without reading QQ config', async () => {
    const f = fixture()
    f.get().roles.worker = { brain: 'main', senseGroup: 'tools', scope: 'private' }
    await f.service.save('brains', false, { name: 'renamed', originalName: 'main', value: {}, expectedBaseRevision: 'r1', requestId: 'rename' })
    expect(f.get().roles.worker.brain).toBe('renamed')
    expect(f.call.mock.calls.some(c => c[0] === 'qq.config.get')).toBe(false)
    await expect(f.service.remove('brains', { name: 'renamed', expectedBaseRevision: 'r2', requestId: 'delete' })).rejects.toMatchObject({ code: 'reference_protected' })
  })
})
