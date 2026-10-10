import { createPlugin } from '../../../plugins/settings/src/index.js'
import { CapabilityError } from '../../../plugins/settings/src/errors.js'
import { ZodError } from 'zod'
import type { IngressContext } from '../../backend/src/service/ingress/api.js'
import type { CoreRpc, ModuleRequest, ModuleResponse } from '../src/modules/contracts.js'
import { logger } from '../../backend/src/utils/logger/index.js'

/** Exercise the package's published routes, not a Manager business factory. */
export function createSettingsPackage(rpc: CoreRpc) {
  let routes: Parameters<IngressContext['management']['register']>[0]['routes'] = []
  const plugin = createPlugin({ resources: { resolve() { throw new Error('RESOURCE_NOT_DECLARED') } }, management: {
    coreCall: async (method: string, params: unknown) => {
      try {
        return await rpc.call(method as Parameters<CoreRpc['call']>[0], params)
      } catch (error) {
        // Mirror the real core boundary (service/index.ts coreCall): plugins see the
        // public wire ErrorCode. BackendRpcClient translates wire codes 1:1 for the
        // Manager process; map them back so the package's own mapping stays authoritative.
        const failure = error as { code?: string }
        const wire: Record<string, string> = {
          validation_failed: 'INVALID_PARAMS',
          revision_conflict: 'REVISION_CONFLICT',
          request_conflict: 'REQUEST_ID_CONFLICT',
          reference_protected: 'CONFLICT',
          not_found: 'NOT_FOUND',
          backend_auth_failed: 'CAPABILITY_DENIED',
        }
        if (failure.code && wire[failure.code])
          throw Object.assign(new Error(wire[failure.code]), { code: wire[failure.code] })
        throw error
      }
    },
    register: (definition: Parameters<IngressContext['management']['register']>[0]) => { routes = definition.routes },
  } } as unknown as IngressContext)
  plugin.prepareManagement!()
  return {
    async handle(input: ModuleRequest): Promise<ModuleResponse> {
      const path = input.url.pathname.replace('/api/modules/capabilities/', '')
      for (const route of routes) {
        const names: string[] = []
        const pattern = route.path.replace(/:([a-zA-Z]+)/g, (_, name: string) => { names.push(name); return '([^/]+)' })
        const match = new RegExp(`^${pattern}$`).exec(path)
        if (!match || route.method !== input.method) continue
        try {
          const value = { pathParams: Object.fromEntries(names.map((name, i) => [name, match[i + 1]])),
            query: Object.fromEntries(input.url.searchParams), ...(input.body === undefined ? {} : {body: input.body}) }
          const parsed = route.requestSchema.parse(value) as typeof value
          const result = await route.handler(parsed, {connectionId:'package-test', credentialKind:'control', log:logger})
          return { status: input.method === 'POST' && path.startsWith('resources/') ? 201 : 200,
            body: { data: route.responseSchema.parse(result) } }
        } catch (error) {
          if (error instanceof CapabilityError) return { status: error.status, body: { error: { code: error.code, message: error.message } } }
          // Mirror the real ingress boundary: request/response schema failures are
          // client errors (INVALID_PARAMS → 400), only unexpected faults are 503.
          if (error instanceof ZodError) return { status: 400, body: { error: { code: 'invalid_params', message: '请求内容无效' } } }
          return { status: 503, body: { error: { code: 'unavailable', message: '后端不可用' } } }
        }
      }
      return { status: 404, body: { error: { code: 'not_found', message: '未找到该管理接口' } } }
    },
  }
}
