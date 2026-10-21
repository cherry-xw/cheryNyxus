import { posix, isAbsolute } from 'node:path'
import { readFile } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import {
  IngressRequestSchemas,
  IngressResponseSchemas,
  IngressHttpRequestSchemas,
  type IngressMethodMap,
  type ManagerUiRegistration,
} from '../../../../packages/protocol/src/ingress.js'
import type { CoreRpc, ModuleRequest, ModuleResponse } from './contracts.js'
import { CapabilityError } from './capabilities/errors.js'

const fail = (code: string, status: number) =>
  new CapabilityError(code, status, '插件接口不可用，请刷新目录并核对版本')
/** Do not decode twice: encoded separators/dot segments must never change path meaning. */
export function safePluginPath(value: string): string {
  if (
    !value ||
    /[%\\?#\u0000-\u001f]/.test(value) ||
    value.startsWith('/') ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw fail('invalid_params', 400)
  return value
}
export const BACKEND_UNAVAILABLE_REASON = '依赖 Backend 运行，当前不可用'

export interface OfflinePluginList {
  contractVersion: 2
  hostApiVersion: 2
  registryRevision: number
  backendUnavailable: true
  reason: string
  plugins: Array<Record<string, unknown>>
}

const pluginIdPattern = /^[a-z][a-z0-9-]{0,63}$/
const capabilityValues = new Set([
  'tools',
  'hooks',
  'rpc.business',
  'rpc.management',
  'ingress',
  'manager.ui',
  'channel.identity',
])

/**
 * Backend 离线时的平级插件列表兜底：只读本地 `.chery/ingress/registry.json`，
 * 已安装插件保留在列表中并标记为依赖 Backend 运行，避免整个插件页报错。
 */
export async function offlinePluginList(registryFile: string): Promise<OfflinePluginList> {
  const empty: OfflinePluginList = {
    contractVersion: 2,
    hostApiVersion: 2,
    registryRevision: 0,
    backendUnavailable: true,
    reason: BACKEND_UNAVAILABLE_REASON,
    plugins: [],
  }
  let raw: string
  try {
    raw = await readFile(registryFile, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty
    throw error
  }
  const parsed = JSON.parse(raw) as unknown
  if (!isRecord(parsed) || parsed.schemaVersion !== 2) throw new Error('registry.json 结构无效')
  const revision = Number.isInteger(parsed.revision) && (parsed.revision as number) >= 0 ? (parsed.revision as number) : 0
  const entries = Array.isArray(parsed.plugins) ? parsed.plugins : []
  const plugins: Array<Record<string, unknown>> = []
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || !pluginIdPattern.test(entry.id)) continue
    if (entry.apiVersion !== 2) continue
    const dependencies = (Array.isArray(entry.dependencies) ? entry.dependencies : [])
      .filter(
        (item): item is { id: string; version: string } =>
          isRecord(item) && typeof item.id === 'string' && typeof item.version === 'string',
      )
      .map((item) => ({ id: item.id, version: item.version }))
    const grantedCapabilities = (Array.isArray(entry.grantedCapabilities) ? entry.grantedCapabilities : []).filter(
      (item): item is string => typeof item === 'string' && capabilityValues.has(item),
    )
    plugins.push({
      id: entry.id,
      apiVersion: 2,
      installed: true,
      enabled: entry.enabled === true,
      savedVersion: typeof entry.version === 'string' ? entry.version : null,
      activeVersion: null,
      state: 'unknown',
      requiresRestart: false,
      savedRevision: revision,
      appliedRevision: null,
      apply: 'pending',
      reason: BACKEND_UNAVAILABLE_REASON,
      grantedCapabilities,
      dependencies,
      backendUnavailable: true,
    })
  }
  return { ...empty, registryRevision: revision, plugins }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export class DynamicModules {
  private readonly loaded = new Map<string, string>()
  constructor(
    private readonly rpc: CoreRpc,
    private readonly sourceRoot?: string,
  ) {
    if (sourceRoot !== undefined && !isAbsolute(sourceRoot))
      throw new Error('manager.plugins.packageSourceRoot 必须为绝对路径')
  }
  private async call<M extends keyof IngressMethodMap>(
    method: M,
    input: IngressMethodMap[M]['params'],
  ): Promise<IngressMethodMap[M]['result']> {
    const request = IngressRequestSchemas[method].safeParse(input)
    if (!request.success) throw fail('invalid_params', 400)
    const raw = await this.rpc.call(method, request.data)
    const response = IngressResponseSchemas[method].safeParse(raw)
    if (!response.success) throw fail('api_version_mismatch', 409)
    return response.data as IngressMethodMap[M]['result']
  }
  async list() {
    return this.call('ingress.list', { contractVersion: 2 })
  }
  async modules() {
    const result = await this.call('ingress.ui.list', { contractVersion: 2, managerApiVersion: 2 })
    const seen = new Set<string>()
    const modules: ManagerUiRegistration[] = result.modules.map((item) => {
      const d = item.descriptor
      if (seen.has(d.id) || d.apiPrefix !== `/api/modules/${d.id}/`)
        throw fail('registration_conflict', 409)
      seen.add(d.id)
      safePluginPath(d.entry)
      safePluginPath(d.resourceVersion)
      if (d.resourceVersion.includes('/') || !d.entry.endsWith('.html'))
        throw fail('invalid_params', 400)
      for (const route of item.routes) {
        if (
          !route.path ||
          route.path
            .split('/')
            .some((segment) => segment !== ':kind' && !/^[a-zA-Z0-9_-]+$/.test(segment))
        )
          throw fail('invalid_params', 400)
      }
      const loaded = this.loaded.get(d.id)
      return {
        ...item,
        pagePath: `/modules/${d.id}`,
        assetPrefix: `/modules/${d.id}/assets/${d.resourceVersion}/`,
        manager: {
          apiVersion: 2,
          resourceVersion: loaded === d.resourceVersion ? loaded : null,
          state: loaded === d.resourceVersion ? 'ready' : 'unavailable',
          ...(loaded === d.resourceVersion ? {} : { reason: 'resource_not_loaded' }),
        },
      }
    })
    for (const id of this.loaded.keys()) if (!seen.has(id)) this.loaded.delete(id)
    return {
      contractVersion: 2 as const,
      managerApiVersion: 2 as const,
      registryRevision: result.registryRevision,
      modules,
    }
  }
  async resource(moduleId: string, version?: string, path?: string) {
    const item = (await this.modules()).modules.find((item) => item.descriptor.id === moduleId)
    if (!item) throw fail('not_found', 404)
    const d = item.descriptor
    if (version !== undefined && version !== d.resourceVersion)
      throw fail('api_version_mismatch', 409)
    const relative = safePluginPath(path ?? posix.basename(d.entry))
    const resource = await this.call('ingress.ui.read', {
      contractVersion: 2,
      pluginId: item.pluginId,
      moduleId,
      resourceVersion: d.resourceVersion,
      path: relative,
    })
    const allowed = new Set([
      'text/html',
      'text/javascript',
      'text/css',
      'application/json',
      'image/png',
      'image/jpeg',
      'image/gif',
      'image/svg+xml',
      'image/webp',
      'image/x-icon',
      'font/woff',
      'font/woff2',
      'font/ttf',
      'application/wasm',
    ])
    if (
      resource.resourceVersion !== d.resourceVersion ||
      !allowed.has(resource.contentType) ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        resource.contentBase64,
      )
    )
      throw fail('invalid_response', 502)
    let bytes = Buffer.from(resource.contentBase64, 'base64')
    if (bytes.length > 1024 * 1024) throw fail('invalid_response', 502)
    if (path === undefined) {
      const html = bytes.toString('utf8')
      if (
        resource.contentType !== 'text/html' ||
        /<base\b/i.test(html) ||
        !/<head(?:\s[^>]*)?>/i.test(html)
      )
        throw fail('invalid_response', 502)
      bytes = Buffer.from(
        html.replace(/<head(?:\s[^>]*)?>/i, (match) => `${match}<base href="${item.assetPrefix}">`),
      )
      this.loaded.set(moduleId, d.resourceVersion)
    }
    return { bytes, contentType: resource.contentType }
  }
  async business(request: ModuleRequest): Promise<ModuleResponse> {
    const match = /^\/api\/modules\/([a-z][a-z0-9-]{0,63})\/(.+)$/.exec(request.url.pathname)
    if (!match) throw fail('not_found', 404)
    const moduleId = match[1]!,
      path = safePluginPath(match[2]!)
    const item = (await this.modules()).modules.find((item) => item.descriptor.id === moduleId)
    if (!item) throw fail('not_found', 404)
    let pathParams: Record<string, string> | undefined
    let registeredPath = path
    for (const route of item.routes) {
      if (route.method !== request.method) continue
      const segments = route.path.split('/'),
        actual = path.split('/')
      if (segments.length !== actual.length) continue
      if (segments.every((segment, index) => segment === ':kind' || segment === actual[index])) {
        pathParams = {}
        registeredPath = route.path
        segments.forEach((segment, index) => {
          if (segment === ':kind') pathParams!.kind = actual[index]!
        })
        break
      }
    }
    if (!pathParams) throw fail('not_found', 404)
    const query: Record<string, string> = {}
    for (const [key, value] of request.url.searchParams) {
      if (Object.hasOwn(query, key)) throw fail('invalid_params', 400)
      query[key] = value
    }
    const response = await this.call('ingress.management.call', {
      contractVersion: 2,
      moduleId,
      method: request.method as 'GET',
      path: registeredPath,
      pathParams,
      query,
      ...(request.body === undefined ? {} : { body: request.body }),
    })
    return { status: response.status, body: response.body }
  }
  async plugins(request: ModuleRequest): Promise<ModuleResponse> {
    if (request.url.search) throw fail('invalid_params', 400)
    const pathname = request.url.pathname
    if (pathname === '/api/plugins' && request.method === 'GET')
      return { status: 200, body: { data: await this.list() } }
    const install = /^\/api\/plugins\/(install|upgrade)$/.exec(pathname)
    if (install && request.method === 'POST') {
      if (!this.sourceRoot) throw fail('install_source_unavailable', 503)
      const action = install[1] as 'install' | 'upgrade'
      const parsed = IngressHttpRequestSchemas[action].safeParse(request.body)
      if (!parsed.success) throw fail('invalid_params', 400)
      safePluginPath(parsed.data.packagePath)
      return this.mutate(action, parsed.data)
    }
    const match =
      /^\/api\/plugins\/([a-z][a-z0-9-]{0,63})\/(enable|disable|uninstall|config)$/.exec(pathname)
    if (!match) throw fail('not_found', 404)
    const id = match[1]!,
      action = match[2]!
    if (action === 'config') {
      if (request.method === 'GET')
        return {
          status: 200,
          body: { data: await this.call('ingress.config.get', { contractVersion: 2, id }) },
        }
      if (request.method !== 'PUT') throw fail('method_not_allowed', 405)
      const parsed = IngressHttpRequestSchemas.configSave.safeParse(request.body)
      if (!parsed.success) throw fail('invalid_params', 400)
      const saved = await this.write(() => this.call('ingress.config.save', { ...parsed.data, id }))
      try {
        const readback = await this.call('ingress.config.get', { contractVersion: 2, id })
        if (
          readback.baseRevision !== saved.baseRevision ||
          !isDeepStrictEqual(readback.config, saved.config)
        )
          throw fail('save_unconfirmed', 502)
        return { status: 200, body: { data: { ...readback, saved: true } } }
      } catch {
        throw fail('save_unconfirmed', 502)
      }
    }
    if (request.method !== 'POST') throw fail('method_not_allowed', 405)
    const operation = action as 'enable' | 'disable' | 'uninstall'
    const parsed = IngressHttpRequestSchemas[operation].safeParse(request.body)
    if (!parsed.success) throw fail('invalid_params', 400)
    return this.mutate(operation, { ...parsed.data, id })
  }
  private async write<T>(work: () => Promise<T>) {
    try {
      return await work()
    } catch (error) {
      if (error instanceof CapabilityError && error.code !== 'unavailable') throw error
      throw fail('save_unconfirmed', 502)
    }
  }
  private async mutate<A extends 'install' | 'upgrade' | 'enable' | 'disable' | 'uninstall'>(
    action: A,
    input: IngressMethodMap[`ingress.${A}`]['params'],
  ): Promise<ModuleResponse> {
    const saved = await this.write(() => this.call(`ingress.${action}`, input))
    try {
      const list = await this.list()
      const current = list.plugins.find((item) => item.id === saved.status.id)
      if (
        list.registryRevision !== saved.registryRevision ||
        (action === 'uninstall' ? current !== undefined : !isDeepStrictEqual(current, saved.status))
      )
        throw fail('save_unconfirmed', 502)
      return { status: 200, body: { data: saved } }
    } catch {
      throw fail('save_unconfirmed', 502)
    }
  }
  async close() {
    await this.rpc.close?.()
    this.loaded.clear()
  }
}
