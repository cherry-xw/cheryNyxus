import { z } from 'zod'
import type { IngressContext, IngressPlugin } from '@chery/plugin-api'
import {
  SettingsRequestSchemas as request, SettingsResponseSchemas as response,
  SettingsResourceSaveRequestSchema, SettingsModelsBodySchema,
  SettingsModelRecommendationBodySchema, SettingsResourceKindSchema,
  SettingsPromptsSaveBodySchema, SettingsSearchSaveBodySchema,
} from '../../../packages/protocol/src/settings.js'
import { CapabilityError, invalidHttpUrl, record } from './errors.js'
import { SettingsService } from './service.js'
export { SettingsService } from './service.js'
export { CapabilityError } from './errors.js'

const configSchema = z.object({}).strict()
type Route = Parameters<IngressContext['management']['register']>[0]['routes'][number]
/** No files, timers, business execution or Manager dependencies in this package. */
export function createPlugin(context: IngressContext): IngressPlugin {
  const call = async (method: string, params: unknown) => {
    try { return await context.management.coreCall(method, params) }
    catch (error) {
      // Recognize public core rejections without returning arbitrary upstream text.
      const code = (error as { code?: string })?.code
      const known: Record<string, [string, number, string]> = {
        INVALID_PARAMS: ['invalid_params', 400, '请求内容无效'],
        REVISION_CONFLICT: ['revision_conflict', 409, '配置已变化，请重新读取'],
        REQUEST_ID_CONFLICT: ['request_conflict', 409, '请求 ID 已用于不同内容'],
        CONFLICT: ['reference_protected', 409, '资源仍被使用，请检查引用'],
        NOT_FOUND: ['not_found', 404, '资源不存在'],
        CAPABILITY_DENIED: ['backend_auth_failed', 502, '核心管理权限不足'],
      }
      if (code && known[code]) throw new CapabilityError(...known[code])
      throw error
    }
  }
  const service = new SettingsService({ call })
  const make = (
    method: Route['method'], path: string, name: string,
    requestSchema: z.ZodType, responseSchema: z.ZodType, handler: Route['handler'],
  ): Route => ({ method, path, rpcMethod: `settings.${name}`, requestSchema, responseSchema, handler })
  let prepared = false
  return {
    defaultConfig: {},
    validateConfig: value => configSchema.parse(value),
    applyConfig: () => {}, start: () => {}, stop: () => {},
    prepareManagement() {
      if (prepared) return
      context.management.register({ moduleId: 'capabilities', routes: [
        make('GET', 'catalog', 'catalog.get', request.catalog, response.catalog, async () => service.catalog()),
        make('GET', 'apply', 'apply.get', request.apply, response.apply, async () => service.apply()),
        make('GET', 'resources/:kind', 'resources.get', request.resourceGet, response.resourceGet,
          async input => service.read(SettingsResourceKindSchema.parse(input.pathParams.kind), input.query.name!)),
        ...(['POST', 'PUT'] as const).map(method => make(method, 'resources/:kind', method === 'POST' ? 'resources.create' : 'resources.save',
          SettingsResourceSaveRequestSchema, response.resourceSave, async input =>
            service.save(SettingsResourceKindSchema.parse(input.pathParams.kind), method === 'POST', input.body))),
        make('DELETE', 'resources/:kind', 'resources.delete', request.resourceDelete, response.resourceDelete,
          async input => service.remove(SettingsResourceKindSchema.parse(input.pathParams.kind), input.body)),
        make('POST', 'models', 'models.list', request.models, response.models, async input => {
          const body = SettingsModelsBodySchema.parse(input.body)
          const url = invalidHttpUrl(body.url)
          const stored = body.savedBrain && body.key === undefined ? await service.modelKey(body.savedBrain, url.href) : undefined
          const { savedBrain: _savedBrain, ...params } = body
          const result = await call('utils.models', { ...params, url: url.href,
            ...(body.key === undefined && stored !== undefined ? { key: stored } : {}) })
          if (!record(result) || result.error || !response.models.safeParse({ models: result.models }).success)
            throw new CapabilityError('models_failed', 502, '获取模型列表失败，请检查 URL 和 Key')
          return { models: result.models }
        }),
        make('POST', 'model-recommendation', 'models.recommendation', request.modelRecommendation, response.modelRecommendation,
          async input => call('utils.modelRecommendation', SettingsModelRecommendationBodySchema.parse(input.body))),
        make('GET', 'prompts', 'prompts.get', request.promptsGet, response.promptsGet,
          async input => call('prompts.preset.get', { preset: input.query.preset })),
        make('PUT', 'prompts', 'prompts.save', request.promptsSave, response.promptsSave,
          async input => call('prompts.preset.save', SettingsPromptsSaveBodySchema.parse(input.body))),
        make('GET', 'search-settings', 'search.get', request.searchGet, response.searchGet,
          async () => call('search.settings.get', {})),
        make('PUT', 'search-settings', 'search.save', request.searchSave, response.searchSave,
          async input => call('search.settings.save', SettingsSearchSaveBodySchema.parse(input.body))),
      ] })
      prepared = true
    },
  }
}
