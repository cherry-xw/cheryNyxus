import {
  FILE_CAPABILITY_OPERATIONS,
  FILE_SERVICE_ADAPTER_CATALOG,
  buildFileServiceToolName,
  type CapabilityState,
  type FileCapabilityOperation,
} from '@chery/protocol'
import type {
  BrainConfig,
  FileServiceConfig,
  PresetConfig,
  RoleConfig,
  RoleFileCapabilitiesMap,
  RoleFileCapabilityBinding,
  RolePermissionEffect,
} from '@chery/plugin-api'

export type FileCapabilityAvailability =
  | 'available'
  | 'requires_approval'
  | 'selection_required'
  | 'unavailable'
  | 'unknown'
export type FileCapabilitySource = 'explicit' | 'preset' | 'role' | 'auto'

/** Limits supplied by the actual adapter/model, not guessed from a vendor name. */
export interface FileCapabilityInputConstraints {
  mimeTypes?: readonly string[]
  maxAssets?: number
  maxBytes?: number
  maxPages?: number
}

export interface FileCapabilityResolution {
  operation: FileCapabilityOperation
  availability: FileCapabilityAvailability
  source: FileCapabilitySource
  mode: RoleFileCapabilityBinding['mode']
  targetId?: string
  inputConstraints: FileCapabilityInputConstraints
  outputKinds: readonly ('text' | 'image' | 'audio' | 'video' | 'document' | 'file')[]
  reasonCode: string
  reason: string
  configRevision: string
  candidates?: readonly { mode: 'native' | 'tool' | 'role'; targetId: string }[]
  delegationPath?: readonly string[]
}

/** A captured config or a validated draft. This module never reads live config. */
export interface FileCapabilityConfig {
  llm: { brain: Record<string, BrainConfig> }
  roles?: Record<string, RoleConfig>
  presets?: Record<string, PresetConfig>
  sense_groups?: Record<string, string[]>
  file_services?: Record<string, FileServiceConfig>
  global?: { supervision?: number }
}

export interface FileCapabilityOperationState {
  availability: 'available' | 'requires_approval' | 'unavailable' | 'unknown'
  reasonCode?: string
  reason?: string
  inputConstraints?: FileCapabilityInputConstraints
  outputKinds?: FileCapabilityResolution['outputKinds']
}

/**
 * Runtime facts captured by the caller, using the same config revision.
 * Missing facts mean unknown, never that a configured adapter is implemented/connected.
 * Native operations must reflect BOTH model capabilities and implemented protocol support.
 */
export interface FileCapabilityRuntime {
  brains?: Record<string, {
    toolCall: boolean
    input?: Partial<Record<'image' | 'audio' | 'video' | 'pdf', CapabilityState>>
    nativeOperations?: Partial<Record<FileCapabilityOperation, FileCapabilityOperationState>>
  }>
  services?: Record<string, Partial<Record<FileCapabilityOperation, FileCapabilityOperationState>>>
  /** Explicitly mapped custom/MCP tools; accepts/produces alone are not a mapping. */
  tools?: readonly {
    name: string
    operations: Partial<Record<FileCapabilityOperation, FileCapabilityOperationState>>
  }[]
  /** Captured execution roster, keyed by role ID or name. Omitted uses current preset members. */
  dispatchRoster?: Record<string, readonly string[]>
}

export interface ResolveFileCapabilityInput {
  config: FileCapabilityConfig
  configRevision: string
  roleId?: string
  roleName?: string
  preset?: string
  operation: FileCapabilityOperation
  explicit?: RoleFileCapabilityBinding
  runtimeSelection?: { brain?: string; senseGroup?: string; mcpServers?: readonly string[] }
  runtime?: FileCapabilityRuntime
  /** Task/operation/input-specific path captured by the execution layer. */
  delegationPath?: readonly string[]
  maxDelegationDepth?: number
}

const UNDERSTANDING = new Set<FileCapabilityOperation>([
  'image.inspect', 'document.extract', 'audio.transcribe', 'video.inspect',
])

function findRole(config: FileCapabilityConfig, idOrName: string | undefined): [string, RoleConfig] | undefined {
  if (!idOrName) return undefined
  // IDs are authoritative; do not choose a similarly named replacement role.
  const byId = Object.entries(config.roles ?? {}).filter(([, role]) => role.id === idOrName)
  if (byId.length === 1) return byId[0]
  if (byId.length > 1) return undefined
  const role = config.roles?.[idOrName]
  return role ? [idOrName, role] : undefined
}

function matchingEffect(rules: Record<string, RolePermissionEffect> | undefined, name: string): RolePermissionEffect {
  if (rules?.[name] !== undefined) return rules[name]!
  // Match the security policy's exact-name, then longest-prefix wildcard order.
  const key = Object.keys(rules ?? {}).filter(key => key.endsWith('*') && name.startsWith(key.slice(0, -1)))
    .sort((a, b) => b.length - a.length || a.localeCompare(b))[0]
  return key ? rules![key]! : 'inherit'
}

function permission(role: RoleConfig, tool: string, targetName?: string): 'allow' | 'ask' | 'deny' {
  const policy = role.permissions
  const template = policy?.template ?? 'supervised'
  const effects: RolePermissionEffect[] = [matchingEffect(policy?.tools, tool)]
  if (tool === 'spawn_role') {
    effects.push(policy?.spawn?.effect ?? (template === 'read-only' ? 'deny' : template === 'supervised' ? 'ask' : 'inherit'))
    if (policy?.spawn?.allowedRoles && !policy.spawn.allowedRoles.includes(targetName ?? '')) effects.push('deny')
  } else if (tool.startsWith('mcp__')) {
    effects.push(matchingEffect(policy?.mcp?.tools, tool))
    effects.push(policy?.mcp?.default ?? (template === 'read-only' ? 'deny' : template === 'trusted' ? 'inherit' : 'ask'))
  } else if (template !== 'trusted') effects.push('ask')
  return effects.includes('deny') ? 'deny' : effects.includes('ask') ? 'ask' : 'allow'
}

function toolEntry(config: FileCapabilityConfig, group: string, name: string): { level?: string } | undefined {
  for (const entry of config.sense_groups?.[group] ?? []) {
    const [tool, level] = entry.split(':')
    if (tool?.trim() === name) return { level: level?.trim() }
  }
  return undefined
}

function result(
  input: ResolveFileCapabilityInput,
  source: FileCapabilitySource,
  binding: RoleFileCapabilityBinding,
  availability: FileCapabilityAvailability,
  reasonCode: string,
  reason: string,
  details: Partial<FileCapabilityResolution> = {},
): FileCapabilityResolution {
  return {
    operation: input.operation, availability, source, mode: binding.mode,
    ...(binding.targetId ? { targetId: binding.targetId } : {}),
    inputConstraints: {}, outputKinds: UNDERSTANDING.has(input.operation) ? ['text'] : ['image'],
    reasonCode, reason, configRevision: input.configRevision, ...details,
  }
}

/** Pure resolution: no IO, registry reads, environment lookup, prompt changes or remote calls. */
export function resolveFileCapability(input: ResolveFileCapabilityInput): FileCapabilityResolution {
  const { config, operation } = input
  const found = findRole(config, input.roleId ?? input.roleName)
  const fail = (code: string, reason: string) => result(input, 'auto', { mode: 'auto' }, 'unavailable', code, reason)
  if (!found || found[1].kind === 'shadow') return fail('capability.role_not_found', '角色不存在或不是可执行的普通角色')
  const [roleName, role] = found
  const presetEntry = input.preset
    ? Object.entries(config.presets ?? {}).find(([name, preset]) => name === input.preset || preset.id === input.preset)
    : undefined
  if (input.preset && !presetEntry) return fail('capability.preset_not_found', '当前预设不存在')
  const preset = presetEntry?.[1]
  if (preset && !preset.roles?.includes(roleName)) return fail('capability.role_outside_preset', '角色不在当前预设中')
  const override = preset?.roleOverrides?.[roleName]?.fileCapabilities?.[operation]
  const own = role.fileCapabilities?.[operation]
  // A disabled policy is a prohibition, not a preference an explicit call can override.
  if (own?.mode === 'disabled' || override?.mode === 'disabled') {
    return result(input, override?.mode === 'disabled' ? 'preset' : 'role', { mode: 'disabled' }, 'unavailable', 'capability.disabled', '该角色已关闭此操作')
  }
  const binding: RoleFileCapabilityBinding = input.explicit ?? override ?? own ?? { mode: 'auto' }
  const source: FileCapabilitySource = input.explicit ? 'explicit' : override ? 'preset' : own ? 'role' : 'auto'
  const emit = (availability: FileCapabilityAvailability, code: string, reason: string, details: Partial<FileCapabilityResolution> = {}) =>
    result(input, source, binding, availability, code, reason, details)
  if (binding.mode === 'disabled') return emit('unavailable', 'capability.disabled', '本次操作已关闭')
  if ((binding.mode === 'tool' || binding.mode === 'role') !== Boolean(binding.targetId) || (binding.fallback && binding.fallback !== 'none')) {
    return emit('unavailable', 'capability.invalid_binding', '处理方式或目标配置无效')
  }
  const identity = role.id ?? roleName
  const path = input.delegationPath ?? []
  if (path.some(id => findRole(config, id)?.[0] === roleName)) return emit('unavailable', 'capability.delegation_cycle', '同一操作的委派链重复经过该角色')
  if (input.maxDelegationDepth !== undefined && path.length > input.maxDelegationDepth) return emit('unavailable', 'capability.delegation_depth', '委派已达到本次任务的层级上限')
  const brainName = input.runtimeSelection?.brain ?? role.brain
  const brain = config.llm.brain[brainName]
  if (!brain) return emit('unavailable', 'capability.brain_not_found', '本次使用的大脑不存在')
  const facts = input.runtime?.brains?.[brainName]
  const toolCall = facts?.toolCall ?? brain.capabilities?.toolCall
  const group = input.runtimeSelection?.senseGroup ?? role.senseGroup
  const native = (): FileCapabilityResolution => {
    if (!UNDERSTANDING.has(operation) && toolCall !== true) return emit(toolCall === undefined ? 'unknown' : 'unavailable', 'capability.tool_call_required', '生成或编辑操作要求当前模型支持工具调用')
    const state = facts?.nativeOperations?.[operation]
    if (!state) return emit('unknown', 'capability.native_unknown', '模型与当前协议是否支持此原生操作尚未确认', { mode: 'native', targetId: brainName })
    return emit(state.availability, state.reasonCode ?? 'capability.native', state.reason ?? '使用当前模型与协议支持的原生操作', {
      mode: 'native', targetId: brainName, inputConstraints: state.inputConstraints ?? {}, outputKinds: state.outputKinds ?? (UNDERSTANDING.has(operation) ? ['text'] : ['image']),
    })
  }
  if (binding.mode === 'native') return native()

  const resolveTool = (name: string, explicitlyBound: boolean): FileCapabilityResolution => {
    const entry = toolEntry(config, group, name)
    if (!entry) return emit('unavailable', 'capability.tool_not_assigned', '目标工具不在本次角色的工具组中', { mode: 'tool', targetId: name })
    if (toolCall !== true && !(toolCall === false && explicitlyBound && UNDERSTANDING.has(operation))) {
      return emit(toolCall === undefined ? 'unknown' : 'unavailable', 'capability.tool_call_required', '无工具调用能力时仅允许显式绑定的系统前置理解工具', { mode: 'tool', targetId: name })
    }
    const services = Object.entries(config.file_services ?? {}).filter(([id, svc]) => svc.operations.includes(operation) && buildFileServiceToolName(id, operation) === name)
    const custom = input.runtime?.tools?.filter(tool => tool.name === name && tool.operations[operation]) ?? []
    if (services.length + custom.length > 1) return emit('unavailable', 'capability.target_collision', '多个文件服务或映射使用了同一工具标识', { mode: 'tool', targetId: name })
    let state: FileCapabilityOperationState | undefined
    if (services.length === 1) {
      const [id, service] = services[0]!
      if (service.enabled === false) return emit('unavailable', 'capability.service_disabled', '目标文件服务已关闭', { mode: 'tool', targetId: name })
      const adapter = FILE_SERVICE_ADAPTER_CATALOG.find(adapter => adapter.id === service.adapter)
      if (!adapter?.supportedOperations.includes(operation)) return emit('unavailable', 'capability.adapter_unsupported', '该适配器不支持此操作', { mode: 'tool', targetId: name })
      if (service.connection.brainRef && !config.llm.brain[service.connection.brainRef]) return emit('unavailable', 'capability.connection_missing', '文件服务引用的大脑连接不存在', { mode: 'tool', targetId: name })
      state = input.runtime?.services?.[id]?.[operation]
    } else if (custom.length === 1) state = custom[0]!.operations[operation]
    else return emit('unavailable', 'capability.tool_operation_missing', '目标工具没有此操作的明确映射', { mode: 'tool', targetId: name })
    const decision = permission(role, name)
    if (decision === 'deny') return emit('unavailable', 'capability.permission_denied', '角色权限禁止使用该工具', { mode: 'tool', targetId: name })
    if (!state) return emit('unknown', 'capability.runtime_unknown', '适配器实现、连接或凭据状态尚未确认', { mode: 'tool', targetId: name })
    const approval = decision === 'ask' || (entry.level ?? String(config.global?.supervision ?? 0)) !== 'auto' && (entry.level ?? String(config.global?.supervision ?? 0)) !== '0'
    const availability = state.availability === 'available' && approval ? 'requires_approval' : state.availability
    return emit(availability, state.reasonCode ?? (availability === 'requires_approval' ? 'capability.approval_required' : 'capability.tool'), state.reason ?? (availability === 'requires_approval' ? '调用此工具需要审批' : '使用已授权的文件工具'), {
      mode: 'tool', targetId: name, inputConstraints: state.inputConstraints ?? {}, outputKinds: state.outputKinds ?? (UNDERSTANDING.has(operation) ? ['text'] : ['image']),
    })
  }

  const resolveDelegate = (target: string): FileCapabilityResolution => {
    if (toolCall !== true) return emit(toolCall === undefined ? 'unknown' : 'unavailable', 'capability.tool_call_required', '当前模型不能自主委派角色', { mode: 'role', targetId: target })
    if (!toolEntry(config, group, 'spawn_role')) return emit('unavailable', 'capability.spawn_not_assigned', '角色工具组中没有角色派发工具', { mode: 'role', targetId: target })
    const foundTarget = findRole(config, target)
    if (!foundTarget || foundTarget[1].kind === 'shadow') return emit('unavailable', 'capability.target_role_missing', '目标角色不存在或不是普通角色', { mode: 'role', targetId: target })
    const [targetName, targetRole] = foundTarget
    const roster = input.runtime?.dispatchRoster?.[identity] ?? input.runtime?.dispatchRoster?.[roleName] ?? preset?.roles ?? []
    if (!preset || !preset.roles?.includes(targetName) || !roster.some(id => findRole(config, id)?.[0] === targetName) || Object.values(config.presets ?? {}).some(p => p.detailRole === targetName)) {
      return emit('unavailable', 'capability.dispatch_not_allowed', '当前预设或执行名单不允许派发该角色', { mode: 'role', targetId: targetRole.id ?? targetName })
    }
    const decision = permission(role, 'spawn_role', targetName)
    if (decision === 'deny') return emit('unavailable', 'capability.permission_denied', '角色权限禁止派发该角色', { mode: 'role', targetId: targetRole.id ?? targetName })
    const child = resolveFileCapability({ ...input, roleId: targetRole.id, roleName: targetName, explicit: undefined, runtimeSelection: undefined, delegationPath: [...path, identity] })
    const spawnLevel = toolEntry(config, group, 'spawn_role')?.level ?? String(config.global?.supervision ?? 0)
    const approval = decision === 'ask' || !['auto', '0'].includes(spawnLevel)
    return emit(child.availability === 'available' && approval ? 'requires_approval' : child.availability, child.reasonCode, child.reason, {
      mode: 'role', targetId: targetRole.id ?? targetName, inputConstraints: child.inputConstraints, outputKinds: child.outputKinds,
      delegationPath: [identity, ...(child.delegationPath ?? [targetRole.id ?? targetName])],
    })
  }
  if (binding.mode === 'tool') return resolveTool(binding.targetId!, true)
  if (binding.mode === 'role') return resolveDelegate(binding.targetId!)
  if (binding.mode !== 'auto') return emit('unavailable', 'capability.invalid_binding', '未知的处理方式')

  // Understanding prefers an explicitly supported native operation. Generation never
  // derives from input.image, nor from output.image without an implemented operation.
  const nativeResult = native()
  if (UNDERSTANDING.has(operation) && ['available', 'requires_approval'].includes(nativeResult.availability)) return nativeResult
  if (toolCall === false) return nativeResult.availability === 'unknown' ? nativeResult : emit('unavailable', 'capability.tool_call_required', '无工具调用模型不会自动选择前置付费工具')
  const names = new Set<string>()
  for (const [id, service] of Object.entries(config.file_services ?? {})) {
    if (service.operations.includes(operation)) names.add(buildFileServiceToolName(id, operation))
  }
  for (const tool of input.runtime?.tools ?? []) if (tool.operations[operation]) names.add(tool.name)
  const candidates = [
    ...(!UNDERSTANDING.has(operation) && ['available', 'requires_approval'].includes(nativeResult.availability) ? [nativeResult] : []),
    ...[...names].sort().map(name => resolveTool(name, false)),
    ...(preset?.roles ?? []).filter(name => name !== roleName).sort().map(name => resolveDelegate(name)),
  ]
  const usable = candidates.filter(candidate => ['available', 'requires_approval'].includes(candidate.availability))
  // Unknown candidates cannot be silently ignored in favor of a potentially paid one.
  const unknown = candidates.filter(candidate => candidate.availability === 'unknown' || candidate.availability === 'selection_required')
  const choices = [...usable, ...unknown]
  if (choices.length > 1) return emit('selection_required', 'capability.selection_required', '存在多个可能的处理对象，请明确选择已授权工具或角色', {
    candidates: choices.map(candidate => ({ mode: candidate.mode as 'native' | 'tool' | 'role', targetId: candidate.targetId! })),
  })
  if (choices.length === 1) return choices[0]!
  const cycle = candidates.find(candidate => candidate.reasonCode === 'capability.delegation_cycle')
  if (cycle) return cycle
  return nativeResult.availability === 'unknown' ? nativeResult : emit('unavailable', 'capability.unavailable', '没有可执行此操作的原生方式、授权工具或可委派角色')
}

export function resolveFileCapabilities(input: Omit<ResolveFileCapabilityInput, 'operation' | 'explicit'> & { explicit?: RoleFileCapabilitiesMap }): FileCapabilityResolution[] {
  return FILE_CAPABILITY_OPERATIONS.map(operation => resolveFileCapability({ ...input, operation, explicit: input.explicit?.[operation] }))
}
