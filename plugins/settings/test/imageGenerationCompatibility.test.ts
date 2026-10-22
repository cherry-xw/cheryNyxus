import { describe, expect, it } from 'vitest'
import { SettingsFilesPolicySchema, SettingsResponseSchemas } from '../../../packages/protocol/src/settings.js'
import { createPlugin } from '../src/index.js'
import type { IngressContext } from '@chery/plugin-api'

const policy = {
  imageGeneration: { defaultCount: 1 },
  imageContext: { mode: 'recent', recentUserTurns: 1 },
  context: { recentUserTurns: 3 },
  imageAdaptation: { maxBytes: 5000000, quality: 85 },
}

describe('deployed image generation policy compatibility', () => {
  it('preserves existing policy and rejects unknown keys and invalid counts', () => {
    expect(SettingsFilesPolicySchema.parse(policy)).toEqual(policy)
    for (const value of [0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1])
      expect(SettingsFilesPolicySchema.safeParse({ imageGeneration: { defaultCount: value } }).success).toBe(false)
    expect(SettingsFilesPolicySchema.safeParse({ ...policy, unknown: true }).success).toBe(false)
    expect(SettingsFilesPolicySchema.safeParse({ imageGeneration: { defaultCount: 1, unknown: true } }).success).toBe(false)
  })

  it('roundtrips actual registered GET/PUT validators without losing image input or other config', async () => {
    let config: any = { baseRevision: 'r1', global: {}, sense_groups: {}, roles: {}, presets: {}, files: structuredClone(policy), llm: { brain: { main: { provider: 'mock', model: 'offline', capabilities: { imageInput: { formats: ['image/png'], animation: 'unknown' } } } } } }
    const originalBrain = structuredClone(config.llm)
    const apply = { protocolVersion: 2, savedRevision: 'r2', appliedRevision: 'r2', status: 'applied', impacts: [], restart: { required: false, status: 'none' } }
    let routes: any[] = []
    const plugin = createPlugin({ management: {
      register: (definition: any) => { routes = definition.routes },
      coreCall: async (method: string, params: any) => {
        if (method === 'config.get') return structuredClone(config)
        if (method === 'config.preview') return { protocolVersion: 2, baseRevision: 'r1', previewToken: 'preview', impacts: [], destructiveTargets: [], policy: 'wait' }
        if (method === 'config.save') {
          config = { ...structuredClone(params.candidate), baseRevision: 'r2' }
          return { ...apply, baseRevision: 'r2', candidateRevisionId: 'candidate', warnings: [] }
        }
        throw new Error('Unexpected method')
      },
    } } as unknown as IngressContext)
    await plugin.prepareManagement!()
    const get = routes.find(route => route.method === 'GET' && route.path === 'files')
    const put = routes.find(route => route.method === 'PUT' && route.path === 'files')
    const before = get.responseSchema.parse(await get.handler(get.requestSchema.parse({ pathParams: {}, query: {} })))
    const body = { policy: before.policy, expectedBaseRevision: before.baseRevision, requestId: 'roundtrip' }
    const after = put.responseSchema.parse(await put.handler(put.requestSchema.parse({ pathParams: {}, query: {}, body })))
    expect(after).toEqual({ policy: SettingsFilesPolicySchema.parse(policy), baseRevision: 'r2', saved: true })
    expect(SettingsResponseSchemas.filesGet.parse(await get.handler({ pathParams: {}, query: {} })).policy).toEqual(policy)
    expect(config.llm).toEqual(originalBrain)
    await expect(put.handler({ body: { ...body, expectedBaseRevision: 'r1' } })).rejects.toMatchObject({ code: 'revision_conflict' })
  })
})
