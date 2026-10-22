import { cpSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServerToolScope, type ServerToolConnection } from '@/utils/serverToolScope.js'
import { readBrainServiceCapabilities } from '@/service/config/brainCapabilities.js'
import { saveServerToolObservations, listServerToolObservations } from '@/db/serverToolObservations.js'
import { getSoulDb, closeAllDbs } from '@/db/index.js'
import { resetModelCatalogCache } from '@/utils/modelCatalog.js'
import { handleUtilsModelRecommendation } from '@/service/utils/handler.js'
import configManage from '@/agent/sense/configManage.js'
import { readRawConfig, getAppliedRawConfig, replaceRuntimeConfig } from '@/utils/config.js'
import { RuntimeResolver } from '@/agent/runtimeResolver.js'
import { registerBuiltinProviders } from '@/agent/provider/index.js'
import { requestSchemas } from '@/service/message/schemas.js'
import { Method } from '@/service/message/types.js'
import { SettingsModelRecommendationResultSchema } from '@chery/protocol'
import type { HandlerContext } from '@/service/message/router.js'

const connection: ServerToolConnection = {
  provider: 'newapi', protocol: 'anthropic-messages', model: 'co-glm-5.3',
  url: 'https://example.com/v1', key: 'test-only-credential',
}

beforeEach(() => {
  cpSync(new URL('../../.chery.template/model-catalog.yaml', import.meta.url), join(process.env.CHERY_DIR!, '.chery/model-catalog.yaml'))
  resetModelCatalogCache()
  getSoulDb().prepare('DELETE FROM server_tool_observations').run()
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No remote calls allowed') }))
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe('当前连接的服务端工具观察与能力来源', () => {
  it('目录推荐与原生能力分开，目录支持不变成当前连接验证通过', () => {
    const result = readBrainServiceCapabilities(connection)
    expect(result.nativeInput.image).toEqual({ state: 'unsupported', source: 'catalog' })
    expect(result.serverTools.imageInspect).toEqual({ state: 'supported', source: 'catalog' })
    expect(result.verification.status).toBe('not-verified')
    expect(result.catalogComplete).toBe(false)
    expect(result.knownTools.map(tool => tool.name)).toEqual(['analyze_image', 'web_search_prime', 'webReader'])
    expect(result.knownTools.every(tool => tool.sources.join() === 'catalog')).toBe(true)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('目录中的服务端工具说明能通过设置插件的公共响应校验', async () => {
    const result = await handleUtilsModelRecommendation({} as HandlerContext, {
      model: connection.model, provider: connection.provider, protocol: 'anthropic-messages',
      connection: { url: connection.url, key: connection.key },
    })
    expect(SettingsModelRecommendationResultSchema.safeParse(result).success).toBe(true)
  })

  it.each([
    { provider: 'custom' }, { protocol: 'openai-responses' }, { model: 'other' },
    { url: 'https://another.example/v1' }, { fullUrl: true }, { key: 'another-credential' },
  ])('连接字段变更后不复用观察：%j', patch => {
    const scope = createServerToolScope(connection)!
    saveServerToolObservations(scope, [{ name: 'custom_tool', status: 'completed', observedAt: 100 }])
    const changed = readBrainServiceCapabilities({ ...connection, ...patch })
    expect(changed.knownTools.some(tool => tool.sources.includes('observed'))).toBe(false)
    expect(changed.verification.status).toBe('not-verified')
  })

  it('凭据引用与实际值分别隔离，同一引用轮换后也没有旧观察', () => {
    vi.stubEnv('SCOPE_TEST_KEY', 'first')
    vi.stubEnv('SCOPE_TEST_ALIAS', 'first')
    const raw = { ...connection, key: '$SCOPE_TEST_KEY' }
    const scope = createServerToolScope({ ...connection, key: 'first' }, '$SCOPE_TEST_KEY')!
    saveServerToolObservations(scope, [{ name: 'webReader', status: 'completed', observedAt: 100 }])
    expect(readBrainServiceCapabilities(raw).knownTools.find(tool => tool.name === 'webReader')?.observation?.status).toBe('completed')
    expect(readBrainServiceCapabilities({ ...raw, key: '$SCOPE_TEST_ALIAS' }).knownTools.every(tool => !tool.observation)).toBe(true)
    vi.stubEnv('SCOPE_TEST_KEY', 'rotated')
    expect(readBrainServiceCapabilities(raw).knownTools.every(tool => !tool.observation)).toBe(true)
  })

  it('保存后重开数据库仍保留真实名称及最近状态，不存正文或密钥', () => {
    const scope = createServerToolScope(connection)!
    saveServerToolObservations(scope, [{ name: 'webReader', status: 'completed', observedAt: 200 }])
    saveServerToolObservations(scope, [{ name: 'webReader', status: 'failed', observedAt: 100 }])
    closeAllDbs()
    const result = readBrainServiceCapabilities(connection)
    expect(result.knownTools.find(tool => tool.name === 'webReader')).toMatchObject({
      sources: ['catalog', 'observed'], observation: { status: 'completed', observedAt: 200 },
    })
    expect(result.verification.status).toBe('not-verified')
    const rows = JSON.stringify(getSoulDb().prepare('SELECT * FROM server_tool_observations').all())
    expect(rows).not.toContain(connection.key)
    expect(rows).not.toContain(connection.url)
    expect(rows).not.toContain('arguments')
    expect(result).not.toHaveProperty('scopeId')
  })

  it('切换协议不携带另一协议的工具说明或观察，不关联相似工具名称', () => {
    const scope = createServerToolScope(connection)!
    saveServerToolObservations(scope, [{ name: 'webSearchPrime', status: 'failed', observedAt: 200 }])
    const result = readBrainServiceCapabilities(connection)
    expect(result.knownTools.find(tool => tool.name === 'webSearchPrime')?.sources).toEqual(['observed'])
    expect(result.knownTools.find(tool => tool.name === 'web_search_prime')?.sources).toEqual(['catalog'])
    expect(readBrainServiceCapabilities({ ...connection, protocol: 'openai-responses' }).knownTools).toEqual([])
  })

  it('不完整连接及离线模型没有可匹配的观察身份', () => {
    for (const patch of [{ key: undefined }, { key: '$MISSING_SCOPE_KEY' }, { model: '<MODEL>' }, { protocol: 'mock' }]) {
      expect(readBrainServiceCapabilities({ ...connection, ...patch }).connectionIdentified).toBe(false)
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  it('过多工具显示截断状态，而不是声称完整目录', () => {
    const scope = createServerToolScope(connection)!
    saveServerToolObservations(scope, Array.from({ length: 205 }, (_, index) => ({ name: `tool_${index}`, status: 'unknown', observedAt: index })))
    const result = readBrainServiceCapabilities(connection)
    expect(result.observationsTruncated).toBe(true)
    expect(result.catalogComplete).toBe(false)
    expect(result.knownTools.filter(tool => tool.observation)).toHaveLength(200)
  })

  it('Web 与 AI 读取相同能力说明，均不发起请求或保存配置', async () => {
    const raw = readRawConfig()
    const [name, brain] = Object.entries(raw.llm.brain)[0]!
    const params = requestSchemas[Method.UTILS_MODEL_RECOMMENDATION].parse({
      model: brain.model, provider: brain.provider, protocol: brain.protocol,
      connection: { url: brain.url, key: brain.key, fullUrl: brain.fullUrl, capabilities: brain.capabilities },
    })
    expect(params).toHaveProperty('connection')
    const rpc = await handleUtilsModelRecommendation({} as HandlerContext, params)
    expect(rpc.serviceCapabilities).toEqual(readBrainServiceCapabilities(brain))
    const result = await configManage.executor.execute({ action: 'get' }, new Map())
    expect(result.content).toContain(`"${name}"`)
    expect(result.content).toContain('大脑能力来源与模型服务工具')
    expect(result.content).toContain(JSON.stringify({ [name]: rpc.serviceCapabilities }, null, 2).slice(1, -1).trim())
    expect(readRawConfig()).toEqual(raw)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('不需要连接详情的既有目录查询仍保持只读', async () => {
    const result = await handleUtilsModelRecommendation({} as HandlerContext, { model: connection.model, provider: connection.provider })
    expect(result).not.toHaveProperty('serviceCapabilities')
    expect(fetch).not.toHaveBeenCalled()
    expect(listServerToolObservations(createServerToolScope(connection)!).tools).toEqual([])
  })

  it('记录读取失败明确报错，而不是伪装没有工具或验证通过', () => {
    getSoulDb().exec('DROP TABLE server_tool_observations')
    try {
      const result = readBrainServiceCapabilities(connection)
      expect(result.observationError).toContain('无法读取')
      expect(result.knownTools).not.toHaveLength(0)
      expect(result.verification.status).toBe('not-verified')
    } finally { closeAllDbs(); getSoulDb() }
  })

  it('运行持有连接身份快照，配置和密钥后续改变不改变在途请求归属', () => {
    const original = getAppliedRawConfig()
    const name = Object.keys(original.llm.brain)[0]!
    vi.stubEnv('SCOPE_RUNTIME_KEY', 'before-rotation')
    const raw = structuredClone(original)
    raw.llm.brain[name] = { ...raw.llm.brain[name]!, ...connection, protocol: 'anthropic-messages', key: '$SCOPE_RUNTIME_KEY' }
    try {
      registerBuiltinProviders()
      replaceRuntimeConfig(raw)
      const resolver = new RuntimeResolver()
      const runtime = resolver.resolve({ brain: name, senseGroup: '', mcpServers: [] })
      expect(runtime.serverToolScopeId).toBe(createServerToolScope({ ...connection, key: 'before-rotation' }, '$SCOPE_RUNTIME_KEY'))
      vi.stubEnv('SCOPE_RUNTIME_KEY', 'after-rotation')
      replaceRuntimeConfig(raw)
      const next = resolver.resolve({ brain: name, senseGroup: '', mcpServers: [] })
      expect(next.serverToolScopeId).not.toBe(runtime.serverToolScopeId)
      expect(runtime.brain.key).toBe('before-rotation')
      expect(next.brain.key).toBe('after-rotation')
      expect(fetch).not.toHaveBeenCalled()
    } finally { replaceRuntimeConfig(original) }
  })
})
