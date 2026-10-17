import { wsClient } from './ws'
import { serviceAuth } from './authContext'
import type { RpcResponse } from './ws'
import { httpUrl } from './http'
import { getServerConfig, sessionHeaders } from './platform'
import type { ConfigDefault } from './agentApiTypes'
import type { ProtocolError } from '@chery/protocol'

export type RpcCallError = Error & ProtocolError

export function fail(method: string, res: RpcResponse): Error {
  const source = res.error
  const err = new Error(source?.message ?? `${method} failed`) as RpcCallError
  err.code = source?.code ?? 'INTERNAL'
  err.source = source?.source ?? 'transport'
  err.retryable = source?.retryable ?? false
  err.tracingId = source?.tracingId ?? `client:${method}`
  if (source?.retryAfterMs !== undefined) err.retryAfterMs = source.retryAfterMs
  if (source?.feedback !== undefined) err.feedback = source.feedback
  return err
}

/** 非流式 RPC：返回 success 时解包 data，否则 throw。 */
export async function call<T>(
  method: string,
  params: unknown,
  options?: { timeoutMs?: number },
): Promise<T> {
  const res = await wsClient.rpc(method, params, options)
  if (!res.success) throw fail(method, res)
  return res.data as T
}

/** 列表型 RPC：调用 call 后解包指定数组字段（缺字段 → 空数组，形状容错）。 */
export async function callList<T>(
  method: string,
  field: string,
  params: unknown = {},
  options?: { timeoutMs?: number },
): Promise<T[]> {
  const data = (await call<Record<string, unknown>>(method, params, options)) ?? {}
  const value = data[field]
  return Array.isArray(value) ? (value as T[]) : []
}

/** HTTP 上传（raw bytes）：fetchServerConfig/sessionHeaders 样板与 !ok 抛错的共享封装。 */
export async function uploadFile<T>(
  path: string,
  file: File,
  options?: { contentType?: string; errorMessage?: string },
): Promise<T> {
  const auth = serviceAuth()
  const context = auth.contextKey?.()
  const assertCurrent = () => {
    auth.assertCurrent?.()
    if (auth !== serviceAuth() || context !== auth.contextKey?.()) throw new Error('后端身份已改变，丢弃上传响应')
  }
  assertCurrent()
  const server = await fetchServerConfig()
  assertCurrent()
  const response = await fetch(httpUrl(path), {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': options?.contentType ?? file.type,
      'X-Filename': encodeURIComponent(file.name),
      ...sessionHeaders(server),
    },
    body: file,
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(
      `${options?.errorMessage ?? '上传失败'}: ${response.status}${detail ? ` ${detail}` : ''}`,
    )
  }
  const result = await response.json() as T
  assertCurrent()
  return result
}

/**
 * /api/config 全量配置缓存（default + senseGroups + presets）。
 * 幂等：首次 fetch 后缓存；失败时清缓存置 null（下次仍 fetch 重试），错误显式抛出由调用方处理（规则 12）。
 * AgentFab（presets）+ AgentDialog（senseGroups/default）共享同一缓存，避免重复 fetch。
 */
let serverConfigGeneration = 0
let serverConfigCache: ConfigDefault | null | undefined

export function clearServerConfigCache(): void {
  serverConfigGeneration++
  serverConfigCache = null
}

export async function fetchServerConfig(): Promise<ConfigDefault> {
  if (serverConfigCache) return serverConfigCache
  const generation = serverConfigGeneration
  try {
    // 浏览器与远端由 platform 门面选择同源请求或带认证的请求。
    // refresh=true 保证设置保存并重启 worker 后拿到最新预设与 sessionToken。
    const value = (await getServerConfig({ refresh: true })) as ConfigDefault
    if (generation !== serverConfigGeneration) throw new Error('目标已改变，丢弃旧配置响应')
    serverConfigCache = value
    return value
  } catch (e) {
    // 失败置 null；调用方可显式重试，不能把加载失败伪装成空配置。
    if (generation === serverConfigGeneration) serverConfigCache = null
    throw e
  }
}
