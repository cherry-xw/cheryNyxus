import { createHash, randomUUID } from 'node:crypto'
import { SettingsFilesPolicySchema, SettingsFilesSaveBodySchema } from '../../../packages/protocol/src/settings.js'
import { settingsUnsetErrors } from '../../../packages/protocol/src/settingsValues.js'
import {
  ConfigApplyStateSchema,
  ConfigSaveResultSchema,
  ConfigPreviewSchema,
} from '../../../packages/protocol/src/configApply.js'
import type {
  CapabilityCatalog,
  CoreConfig,
  CoreRpc,
  PresetValue,
  ResourceKind,
  ResourceView,
  SaveResourceResult,
} from './contracts.js'
import type { PresetConfig, RoleConfig } from '@chery/plugin-api'
import { CapabilityError, invalid, record, unavailable } from './errors.js'

function nameCheck(name: unknown): asserts name is string {
  if (
    typeof name !== 'string' ||
    !name.trim() ||
    name.length > 128 ||
    /[\u0000-\u001f]/.test(name) ||
    ['__proto__', 'prototype', 'constructor'].includes(name)
  )
    invalid('资源名称无效')
}
function safeTree(value: unknown, depth = 0): void {
  if (depth > 32) invalid()
  if (Array.isArray(value)) {
    for (const entry of value) safeTree(entry, depth + 1)
    return
  }
  if (record(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) invalid()
      safeTree(entry, depth + 1)
    }
  }
}
function has(map: object | undefined, name: string): boolean {
  return !!map && Object.hasOwn(map, name)
}
function mapFor(config: CoreConfig, kind: ResourceKind): Record<string, unknown> {
  if (kind === 'brains') return config.llm.brain
  if (kind === 'sense-groups') return config.sense_groups ?? {}
  return config.presets ?? {}
}
/** Defensive output filtering also covers custom brain fields and error state strings. */
function scrub(value: unknown, secrets: string[]): unknown {
  if (Array.isArray(value)) return value.map((entry) => scrub(entry, secrets))
  if (record(value))
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) => !/^(key|password|token|secret|apiKey|accessToken|refreshToken)$/i.test(key),
        )
        .map(([key, entry]) => [key, scrub(entry, secrets)]),
    )
  if (typeof value === 'string') {
    let text = value
    for (const secret of [...secrets].sort((a, b) => b.length - a.length))
      if (secret) text = text.split(secret).join('[REDACTED]')
    return text.replace(/(https?:\/\/)[^/@\s]+@/g, '$1[REDACTED]@')
  }
  return value
}
function secretValues(config: CoreConfig): string[] {
  const brainKeys = Object.values(config.llm.brain).flatMap((brain) =>
    typeof brain.key === 'string' && brain.key ? [brain.key] : [],
  )
  const fileServiceKeys = Object.values(config.file_services ?? {}).flatMap((svc) =>
    typeof svc.connection?.keyRef === 'string' &&
    svc.connection.keyRef &&
    !/^\$[A-Z_][A-Z0-9_]*$/.test(svc.connection.keyRef)
      ? [svc.connection.keyRef]
      : [],
  )
  return [...brainKeys, ...fileServiceKeys]
}
function safeApply(state: ResourceView['apply']): ResourceView['apply'] {
  const copy = structuredClone(state)
  for (const impact of copy.impacts)
    if (impact.reason) impact.reason = '请在后端检查此资源的生效状态'
  if (copy.restart.reason) copy.restart.reason = '需要在后端检查并手动处理重启条件'
  for (const blocker of copy.restart.blockers ?? [])
    blocker.description = '后端仍有任务或资源正在使用'
  return copy
}
export class SettingsService {
  async files() {
    const config = await this.config()
    return { policy: SettingsFilesPolicySchema.parse(config.files ?? {}), baseRevision: config.baseRevision }
  }
  async saveFiles(input: unknown) {
    const body = SettingsFilesSaveBodySchema.parse(input)
    const config = await this.config()
    if (config.baseRevision !== body.expectedBaseRevision)
      throw new CapabilityError('revision_conflict', 409, '配置已变化，请重新读取')
    const { baseRevision: _base, ...candidate } = config
    candidate.files = body.policy
    const preview = ConfigPreviewSchema.parse(await this.rpc.call('config.preview', {
      protocolVersion: 2, expectedBaseRevision: body.expectedBaseRevision, candidate,
    }))
    const saved = ConfigSaveResultSchema.parse(await this.rpc.call('config.save', {
      protocolVersion: 2, expectedBaseRevision: body.expectedBaseRevision,
      requestId: body.requestId, previewToken: preview.previewToken, policy: 'wait', candidate,
    }))
    const after = await this.files()
    if (after.baseRevision !== saved.baseRevision || JSON.stringify(after.policy) !== JSON.stringify(body.policy))
      throw new CapabilityError('saved_revision_changed', 409, '保存回读未确认，请重新读取')
    return { ...after, saved: true as const }
  }
  private tail: Promise<unknown> = Promise.resolve()
  private readonly saved = new Map<string, { fingerprint: string; result: SaveResourceResult }>()
  constructor(private readonly rpc: CoreRpc) {}
  private async config(): Promise<CoreConfig> {
    const config = await this.rpc.call('config.get', {})
    if (
      !record(config) ||
      typeof config.baseRevision !== 'string' ||
      !config.baseRevision ||
      !record(config.global) ||
      !record(config.llm) ||
      !record(config.llm.brain)
    )
      throw unavailable()
    for (const field of ['sense_groups', 'roles', 'presets'])
      if (config[field] !== undefined && !record(config[field])) throw unavailable()
    return structuredClone(config) as unknown as CoreConfig
  }
  async apply() {
    const result = ConfigApplyStateSchema.safeParse(await this.rpc.call('config.apply.status', {}))
    if (!result.success) throw unavailable()
    // Backend state errors must not expose arbitrary upstream exception details.
    return safeApply(result.data)
  }
  async catalog(): Promise<CapabilityCatalog> {
    const [config, brains, senses, tools] = await Promise.all([
      this.config(),
      this.rpc.call('brain.list', {}),
      this.rpc.call('sense.list', {}),
      this.rpc.call('sense.tools', {}),
    ])
    if (
      !record(brains) ||
      !Array.isArray(brains.brains) ||
      !record(senses) ||
      !Array.isArray(senses.senseGroups) ||
      !record(tools) ||
      !Array.isArray(tools.tools) ||
      tools.tools.some(
        (tool) =>
          !record(tool) || typeof tool.name !== 'string' || typeof tool.description !== 'string',
      )
    )
      throw unavailable()
    return {
      brains: Object.keys(config.llm.brain),
      senseGroups: Object.keys(config.sense_groups ?? {}),
      presets: Object.keys(config.presets ?? {}),
      tools: scrub(tools.tools, secretValues(config)) as CapabilityCatalog['tools'],
      baseRevision: config.baseRevision,
    }
  }
  private view(
    config: CoreConfig,
    kind: ResourceKind,
    name: string,
    apply: ResourceView['apply'],
  ): ResourceView {
    const map = mapFor(config, kind)
    if (!has(map, name)) throw new CapabilityError('not_found', 404, '未找到该资源')
    let value = structuredClone(map[name])
    if (kind === 'presets') {
      const preset = value as PresetConfig
      const role = config.roles?.[preset.leader]
      if (!role) throw unavailable()
      value = { ...preset, brain: role.brain, senseGroup: role.senseGroup }
    }
    return {
      kind,
      name,
      value: scrub(value, secretValues(config)) as ResourceView['value'],
      baseRevision: config.baseRevision,
      apply,
      ...(kind === 'brains'
        ? {
            secrets: {
              keyConfigured:
                typeof config.llm.brain[name]?.key === 'string' && !!config.llm.brain[name]?.key,
            },
          }
        : {}),
    }
  }
  async read(kind: ResourceKind, name: string): Promise<ResourceView> {
    nameCheck(name)
    const config = await this.config()
    return this.view(config, kind, name, await this.apply())
  }
  save(kind: ResourceKind, create: boolean, body: unknown): Promise<SaveResourceResult> {
    const operation = this.tail.then(() => this.commit(kind, create, body))
    this.tail = operation.catch(() => {})
    return operation
  }
  remove(
    kind: ResourceKind,
    body: unknown,
  ): Promise<{ deleted: true; name: string; baseRevision: string }> {
    const operation = this.tail.then(async () => {
      if (
        !record(body) ||
        Object.keys(body).some((k) => !['name', 'expectedBaseRevision', 'requestId'].includes(k))
      )
        invalid()
      nameCheck(body.name)
      if (
        typeof body.expectedBaseRevision !== 'string' ||
        !body.expectedBaseRevision ||
        typeof body.requestId !== 'string' ||
        !body.requestId ||
        body.requestId.length > 128
      )
        invalid()
      const config = await this.config()
      if (config.baseRevision !== body.expectedBaseRevision)
        throw new CapabilityError('revision_conflict', 409, '配置已变化，请重新读取后删除')
      const map = mapFor(config, kind)
      if (!has(map, body.name))
        throw new CapabilityError('not_found', 404, '资源不存在，请刷新目录')
      if (kind === 'presets') {
        const preset = config.presets![body.name]!
        delete map[body.name]
        for (const roleName of new Set(
          [preset.leader, ...(preset.roles ?? []), preset.detailRole].filter(Boolean) as string[],
        )) {
          const role = config.roles?.[roleName]
          const referenced =
            Object.values(config.presets ?? {}).some(
              (p) =>
                p.leader === roleName || p.detailRole === roleName || p.roles?.includes(roleName),
            ) ||
            Object.entries(config.roles ?? {}).some(
              ([name, r]) =>
                name !== roleName && r.permissions?.spawn?.allowedRoles?.includes(roleName),
            )
          if (role && role.scope !== 'public' && !role.lock && !referenced)
            delete config.roles![roleName]
        }
      } else {
        const references = Object.entries(config.roles ?? {}).filter(([, role]) =>
          kind === 'brains' ? role.brain === body.name : role.senseGroup === body.name,
        )
        const serviceRefs =
          kind === 'brains'
            ? Object.entries(config.file_services ?? {}).filter(
                ([, svc]) => svc.connection?.brainRef === body.name,
              )
            : []
        if (references.length || serviceRefs.length) {
          const refNames = [
            ...references.map(([name]) => name),
            ...serviceRefs.map(([name]) => `文件服务:${name}`),
          ]
          throw new CapabilityError(
            'reference_protected',
            409,
            `此资源仍被以下对象引用：${refNames.join('、')}；请先更换引用或删除对应资源`,
          )
        }
        delete map[body.name]
      }
      const { baseRevision: _base, ...candidate } = config
      const previewResult = ConfigPreviewSchema.safeParse(await this.rpc.call('config.preview', {
        protocolVersion: 2, expectedBaseRevision: body.expectedBaseRevision,
        candidate,
      }))
      if (!previewResult.success) throw new CapabilityError('validation_failed', 400, '删除影响预览失败，请重新读取')
      const preview = previewResult.data
      const response = ConfigSaveResultSchema.safeParse(
        await this.rpc.call('config.save', {
          previewToken: preview.previewToken,
          policy: 'wait',
          protocolVersion: 2,
          expectedBaseRevision: body.expectedBaseRevision,
          requestId: body.requestId,
          candidate,
        }),
      )
      if (!response.success)
        throw new CapabilityError('delete_unconfirmed', 503, '删除结果无法确认，请刷新目录核对')
      const after = await this.config()
      if (after.baseRevision !== response.data.baseRevision || has(mapFor(after, kind), body.name))
        throw new CapabilityError('delete_unconfirmed', 503, '删除回读未确认，请刷新目录核对')
      return { deleted: true as const, name: body.name, baseRevision: after.baseRevision }
    })
    this.tail = operation.catch(() => {})
    return operation
  }
  private async commit(
    kind: ResourceKind,
    create: boolean,
    body: unknown,
  ): Promise<SaveResourceResult> {
    if (
      !record(body) ||
      Object.keys(body).some(
        (key) =>
          !['name', 'originalName', 'value', 'unset', 'expectedBaseRevision', 'requestId'].includes(key),
      )
    )
      invalid()
    nameCheck(body.name)
    if (
      typeof body.expectedBaseRevision !== 'string' ||
      !body.expectedBaseRevision ||
      typeof body.requestId !== 'string' ||
      !body.requestId ||
      body.requestId.length > 128 ||
      !Object.hasOwn(body, 'value')
    )
      invalid()
    safeTree(body.value)
    if (body.unset !== undefined && (!Array.isArray(body.unset) || body.unset.some(field => typeof field !== 'string'))) invalid('unset 必须是字段名数组')
    const unset = (body.unset ?? []) as string[]
    const unsetErrors = settingsUnsetErrors(kind, body.value, unset)
    if (unsetErrors.length) invalid(unsetErrors.join('\n'))
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ kind, create, body }))
      .digest('hex')
    const previous = this.saved.get(body.requestId)
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new CapabilityError('request_conflict', 409, '此请求 ID 已用于不同内容')
      return structuredClone(previous.result)
    }
    const config = await this.config()
    if (config.baseRevision !== body.expectedBaseRevision)
      throw new CapabilityError('revision_conflict', 409, '配置已被修改，请重新读取后保存')
    const originalName = body.originalName ?? body.name
    nameCheck(originalName)
    const renamed = !create && originalName !== body.name
    if (renamed) {
      const map = mapFor(config, kind)
      if (!has(map, originalName)) throw new CapabilityError('not_found', 404, '原资源不存在')
      if (has(map, body.name)) throw new CapabilityError('already_exists', 409, '新名称已存在')
      map[body.name] = map[originalName]
      delete map[originalName]
      for (const role of Object.values(config.roles ?? {})) {
        if (kind === 'brains' && role.brain === originalName) role.brain = body.name
        if (kind === 'sense-groups' && role.senseGroup === originalName) role.senseGroup = body.name
      }
      if (kind === 'brains') {
        for (const svc of Object.values(config.file_services ?? {})) {
          if (svc.connection?.brainRef === originalName) svc.connection.brainRef = body.name
        }
      }
    }
    const exists = has(mapFor(config, kind), body.name)
    if (create && exists)
      throw new CapabilityError('already_exists', 409, '同名资源已存在，请选择编辑')
    if (!create && !exists) throw new CapabilityError('not_found', 404, '未找到该资源，请重新读取')
    if (kind === 'brains') {
      if (!record(body.value)) invalid()
      if (Object.hasOwn(body.value, 'key') && typeof body.value.key !== 'string')
        invalid('密钥必须为字符串')
      const merged: Record<string, unknown> = { ...(config.llm.brain[body.name] ?? {}), ...body.value }
      for (const field of unset) delete merged[field]
      if (
        typeof merged.model !== 'string' ||
        !merged.model.trim() ||
        typeof merged.provider !== 'string' ||
        !merged.provider.trim()
      )
        invalid('大脑必须填写服务和模型')
      config.llm.brain[body.name] = merged as unknown as CoreConfig['llm']['brain'][string]
    } else if (kind === 'sense-groups') {
      if (
        !Array.isArray(body.value) ||
        body.value.some((entry) => typeof entry !== 'string' || !entry.trim())
      )
        invalid('感官组必须是工具名称数组')
      config.sense_groups ??= {}
      config.sense_groups[body.name] = body.value as string[]
    } else {
      if (!record(body.value)) invalid()
      this.preset(config, body.name, body.value as PresetValue, unset)
    }
    const { baseRevision: _base, ...candidate } = config
    // Reference checks belong to the public core preview, not another package's config.
    const previewResult = ConfigPreviewSchema.safeParse(await this.rpc.call('config.preview', {
      protocolVersion: 2, expectedBaseRevision: body.expectedBaseRevision, candidate,
    }))
    if (!previewResult.success)
      throw new CapabilityError('validation_failed', 400, '资源影响预览失败，请重新读取')
    const preview = previewResult.data
    let response: unknown
    try {
      response = await this.rpc.call('config.save', {
        previewToken: preview.previewToken, policy: 'wait',
        protocolVersion: 2,
        expectedBaseRevision: body.expectedBaseRevision,
        requestId: body.requestId,
        candidate,
      })
    } catch (error) {
      if (
        error instanceof CapabilityError &&
        (error.status < 500 || error.code === 'backend_auth_failed')
      )
        throw error
      throw new CapabilityError(
        'save_unconfirmed',
        503,
        '保存结果无法确认，请读取同名资源核对，不要直接重复提交',
      )
    }
    const saved = ConfigSaveResultSchema.safeParse(response)
    if (!saved.success)
      throw new CapabilityError(
        'save_unconfirmed',
        503,
        '保存响应无法确认，请读取同名资源核对，不要直接重复提交',
      )
    let after: CoreConfig
    try {
      after = await this.config()
    } catch {
      throw new CapabilityError(
        'saved_readback_failed',
        503,
        '配置已保存，但回读失败；请恢复连接后读取同名资源',
      )
    }
    if (after.baseRevision !== saved.data.baseRevision)
      throw new CapabilityError(
        'saved_revision_changed',
        409,
        '本次已保存，但回读前配置再次变化，请读取最新版本',
      )
    const apply = await this.apply().catch(() =>
      safeApply(ConfigApplyStateSchema.parse(saved.data)),
    )
    const safeSave = scrub(
      {
        ...saved.data,
        ...apply,
        warnings: saved.data.warnings.length ? ['核心保存存在警告，请在后端检查'] : [],
      },
      secretValues(after),
    ) as SaveResourceResult['save']
    const result: SaveResourceResult = {
      ...this.view(after, kind, body.name, apply),
      saved: true,
      save: safeSave,
    }
    if (this.saved.size >= 128) this.saved.delete(this.saved.keys().next().value!)
    this.saved.set(body.requestId, { fingerprint, result: structuredClone(result) })
    return result
  }
  private preset(config: CoreConfig, name: string, value: PresetValue, unset: string[] = []): void {
    const old = config.presets?.[name]
    if (old?.id && value.id !== undefined && value.id !== old.id) invalid('不能修改预设的稳定身份')
    const { brain, senseGroup, ...fields } = value
    const preset = { ...old, ...fields } as PresetConfig
    for (const field of unset) delete (preset as unknown as Record<string, unknown>)[field]
    config.roles ??= {}
    if (brain !== undefined || senseGroup !== undefined) {
      const source = config.roles[preset.leader]
      const chosenBrain = brain ?? source?.brain
      const chosenGroup = senseGroup ?? source?.senseGroup ?? ''
      if (
        !chosenBrain ||
        !has(config.llm.brain, chosenBrain) ||
        typeof chosenGroup !== 'string' ||
        (chosenGroup && !has(config.sense_groups, chosenGroup))
      )
        invalid('请选择已有大脑和感官组')
      const model = config.llm.brain[chosenBrain]!
      if (model.capabilities?.toolCall === false && (chosenGroup || source?.mcpServers?.length))
        invalid('无工具能力的大脑不能配置感官组或扩展工具')
      if (model.capabilities?.toolCall !== false && !chosenGroup)
        invalid('具有工具能力的大脑必须选择感官组')
      const changed = !source || source.brain !== chosenBrain || source.senseGroup !== chosenGroup
      if (changed) {
        if (source?.lock) invalid('锁定角色不能通过简化预设编辑，请使用核心管理入口')
        const shared =
          source?.scope === 'public' ||
          Object.entries(config.presets ?? {}).some(
            ([otherName, other]) =>
              otherName !== name &&
              (other.leader === preset.leader ||
                other.detailRole === preset.leader ||
                other.roles?.includes(preset.leader)),
          ) ||
          Object.values(config.roles).some(
            (role) =>
              role !== source && role.permissions?.spawn?.allowedRoles?.includes(preset.leader),
          )
        const role: RoleConfig = {
          ...source,
          brain: chosenBrain,
          senseGroup: chosenGroup,
          scope: 'private',
        }
        if (!source || shared || !old || preset.leader !== old.leader) {
          const roleName = `capability-${randomUUID()}`
          role.id = `role-${randomUUID()}`
          delete role.lock
          config.roles[roleName] = role
          // Leave shared references in place; only the leader selection moves.
          preset.roles = [...new Set([...(preset.roles ?? []), roleName])]
          preset.leader = roleName
        } else config.roles[preset.leader] = role
      }
    }
    if (!preset.leader || !has(config.roles, preset.leader))
      invalid('预设必须选择有效组长或填写大脑与感官组')
    if (config.roles[preset.leader]?.scope === 'public') invalid('公共角色不能作为预设组长')
    preset.roles = preset.roles ?? [preset.leader]
    if (!preset.roles.includes(preset.leader)) invalid('组长必须在预设角色列表内')
    config.presets ??= {}
    config.presets[name] = preset
  }
}
