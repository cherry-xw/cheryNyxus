import { inject, type InjectionKey } from 'vue'
import { SettingsBrainSchema, SettingsGlobalSchema, SettingsMemorySchema, SettingsMcpServerSchema, SettingsFilesPolicySchema, SettingsFileServiceSchema, effectiveLlmBaseUrl, effectiveLlmProtocol, llmRequiresKey, httpAddressError, imageParameterErrors } from '@chery/protocol'
import type { ConfigDto } from '@/application/backend/public'

export const SETTINGS_INPUT_ERRORS: InjectionKey<Record<string, string>> = Symbol('settings-input-errors')
export function useSettingsInputError() {
  const errors = inject(SETTINGS_INPUT_ERRORS, null)
  return (path: string, message: string) => { if (!errors) return; if (message) errors[path] = message; else delete errors[path] }
}

/** Validate before serialization; environment references are checked only by the backend. */
export function settingsDraftErrors(draft: ConfigDto): string[] {
  const errors: string[] = []
  const check = (schema: { safeParse(input: unknown): { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } } }, value: unknown, path: string) => {
    const result = schema.safeParse(value)
    if (!result.success) for (const issue of result.error?.issues ?? []) errors.push(`${path}${issue.path.length ? '.' + issue.path.join('.') : ''}: ${issue.message}`)
  }
  check(SettingsGlobalSchema, draft.global, 'global')
  if (draft.memory !== undefined) check(SettingsMemorySchema, draft.memory, 'memory')
  if (draft.files !== undefined) {
    check(SettingsFilesPolicySchema, draft.files, 'files')
    const image = draft.files.imageContext
    if (image?.missingDescription === 'inspect') {
      const target = image.serviceId ? draft.file_services?.[image.serviceId] : undefined
      if (!image.serviceId) errors.push('files.imageContext.serviceId: 请选择已启用图片理解操作的文件服务')
      else if (!target || target.enabled === false || !target.operations.includes('image.inspect'))
        errors.push(`files.imageContext.serviceId: 所选服务 "${image.serviceId}" 未启用或不支持 image.inspect`)
    }
  }
  for (const [name, brain] of Object.entries(draft.llm.brain)) {
    const prefix = `llm.brain.${name}`
    check(SettingsBrainSchema.passthrough(), brain, prefix)
    const protocol = effectiveLlmProtocol(brain)
    if (!protocol) errors.push(`${prefix}.protocol: 请选择协议`)
    if (protocol !== 'mock') {
      const url = effectiveLlmBaseUrl(brain)
      if (!url?.startsWith('$')) { const error = httpAddressError(url); if (error) errors.push(`${prefix}.url: ${error}`) }
      if (llmRequiresKey(brain) && !brain.key?.trim()) errors.push(`${prefix}.key: 请填写密钥或环境引用`)
    }
  }
  for (const [name, server] of Object.entries(draft.mcp_servers ?? {})) check(SettingsMcpServerSchema, server, `mcp_servers.${name}`)
  for (const [name, service] of Object.entries(draft.file_services ?? {})) {
    check(SettingsFileServiceSchema, service, `file_services.${name}`)
    const model = service.connection?.model ?? draft.llm.brain[service.connection?.brainRef ?? '']?.model ?? ''
    errors.push(...imageParameterErrors(service.adapter, { ...service.defaults, prompt: '参数检查' }, model).map(error => `file_services.${name}.defaults.${error}`))
  }
  return errors
}
