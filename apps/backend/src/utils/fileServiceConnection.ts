import type { BrainConfig, FileServiceConfig } from '@chery/plugin-api'
import { effectiveLlmBaseUrl, httpAddressError } from '@chery/protocol'
import { requiredEnvironmentValue, resolveConfiguredLlmConnection } from './llmConnection.js'

/** Shared by candidate validation, read-only availability, and execution. */
export function resolveFileServiceConnection(service: FileServiceConfig, brains: Record<string, BrainConfig>, environment: Readonly<Record<string, string | undefined>>) {
  const connection = service.connection
  const brain = connection.brainRef ? brains[connection.brainRef] : undefined
  const local = ['vision-brain', 'custom-sense-mcp'].includes(service.adapter)
  const errors: string[] = []
  if (connection.brainRef && !brain) errors.push('connection.brainRef 引用的大脑不存在')
  if (service.adapter === 'vision-brain' && brain) errors.push(...resolveConfiguredLlmConnection(brain, environment, 'connection.brainRef').errors)
  const rawUrl = brain ? effectiveLlmBaseUrl(brain) : connection.baseUrl
  const baseUrl = requiredEnvironmentValue(rawUrl, environment)
  const model = requiredEnvironmentValue(connection.model ?? brain?.model, environment)
  const key = requiredEnvironmentValue(brain?.key ?? connection.keyRef, environment)
  const authType = connection.authType ?? (service.adapter.startsWith('google-') ? 'x-api-key' : 'bearer')
  const endpoints = Object.fromEntries(Object.entries(connection.endpointOverrides ?? {}).map(([op, url]) => [op, requiredEnvironmentValue(url, environment)]))
  if (!local) {
    if (!brain?.fullUrl) {
      const addressError = httpAddressError(baseUrl)
      if (addressError) errors.push(`connection.baseUrl ${addressError}`)
    }
    if (!model?.trim() || model.startsWith('$') || /^<[^>]*>$/.test(model.trim())) errors.push('connection.model 请填写型号或配置引用的环境变量')
    if (authType !== 'none' && (!key?.trim() || key.startsWith('$') || key === '[REDACTED]')) errors.push('connection.keyRef 请填写密钥或配置引用的环境变量')
    for (const op of service.operations) {
      if (brain?.fullUrl || endpoints[op] !== undefined) {
        const error = httpAddressError(endpoints[op])
        if (error) errors.push(`connection.endpointOverrides.${op} 复用完整聊天地址时必须填写此操作的完整端点；${error}`)
      }
    }
  }
  return { baseUrl: baseUrl ?? '', model: model ?? '', key, authType: connection.authType, endpoints: endpoints as typeof connection.endpointOverrides, errors }
}
