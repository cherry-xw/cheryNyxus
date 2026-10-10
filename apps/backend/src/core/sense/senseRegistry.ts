import type { ZodType } from 'zod'
import type { Sense } from './senseCreator'

/**
 * 全局感官注册表：感官名 → Sense 实例
 *
 * 所有内置感官（bash/read/write/skill）和外部自定义感官在启动时注册到此表。
 * AgentBuilder.resolveSense 通过 sense_group 配置按名称从中取感官子集，摊平为 senseTable。
 *
 * 注意：此注册表是全局共享的，不同 chat 的感官隔离由 builder 按 senseGroups
 * 解析时实现（决定可见感官子集与监管等级），而非此注册表本身。
 */
const senseRegistry: Record<string, Sense<ZodType>> = {}
export interface SenseOrigin {
  source: 'builtin' | 'custom' | 'mcp' | 'plugin'
  pluginId?: string
  pluginVersion?: string
  channels?: readonly string[]
  metadata?: { label: string; description: string; icon: string; doc: string }
  available?: () => boolean
}
const origins = new Map<string, SenseOrigin>()
const unavailable = new Map<
  string,
  SenseOrigin & { reason: 'plugin_disabled' | 'plugin_uninstalled' | 'plugin_failed' }
>()
export function getSenseOrigin(name: string): SenseOrigin | undefined {
  return origins.get(name) ?? unavailable.get(name)
}
export function getUnavailableSense(name: string) {
  return unavailable.get(name)
}
export function listRegisteredSenses() {
  return Object.entries(senseRegistry).map(([name, sense]) => ({
    name,
    sense,
    origin: origins.get(name),
  }))
}
export function registerPluginSense(sense: Sense<ZodType>, origin: SenseOrigin): () => void {
  const name = sense.definition.function.name
  if (!name || senseRegistry[name])
    throw Object.assign(new Error('REGISTRATION_CONFLICT'), { code: 'REGISTRATION_CONFLICT' })
  senseRegistry[name] = sense
  origins.set(name, origin)
  unavailable.delete(name)
  senseRegistryVersion++
  return () => {
    if (senseRegistry[name] !== sense) return
    delete senseRegistry[name]
    origins.delete(name)
    unavailable.set(name, { ...origin, reason: 'plugin_disabled' })
    senseRegistryVersion++
  }
}
export function markPluginSensesUnavailable(
  pluginId: string,
  reason: 'plugin_disabled' | 'plugin_uninstalled' | 'plugin_failed',
): void {
  for (const [name, origin] of unavailable)
    if (origin.pluginId === pluginId) unavailable.set(name, { ...origin, reason })
}
let localSenseNames = new Set<string>()

/**
 * 注册表版本号：每次变更（register/reset/unregister）递增。
 * AgentSession 在 configureRuntime 时快照此版本，send/resume 入口比对——
 * 不一致说明 registry 被 mcp.reload/重编译改动，需重建 senseTable（见 runtime.ts ensureChat）。
 */
let senseRegistryVersion = 0

/** Transaction rollback keeps executor objects and their version unchanged. */
export function captureSenseRegistryRestore(): () => void {
  const senses = { ...senseRegistry }
  const local = new Set(localSenseNames)
  const savedOrigins = new Map(origins)
  const savedUnavailable = new Map(unavailable)
  const version = senseRegistryVersion
  return () => {
    for (const name of Object.keys(senseRegistry)) delete senseRegistry[name]
    Object.assign(senseRegistry, senses)
    localSenseNames = local
    origins.clear()
    unavailable.clear()
    for (const [name, origin] of savedOrigins) origins.set(name, origin)
    for (const [name, origin] of savedUnavailable) unavailable.set(name, origin)
    senseRegistryVersion = version
  }
}

/** 取当前注册表版本号（用于 stale 比对）。 */
export function getSenseRegistryVersion(): number {
  return senseRegistryVersion
}

/**
 * 批量注册感官到全局注册表
 */
export function registerSenses(senses: Sense<ZodType>[]): void {
  const names = senses.map((s) => s?.definition?.function?.name)
  if (names.some((name) => !name || senseRegistry[name]) || new Set(names).size !== names.length)
    throw Object.assign(new Error('REGISTRATION_CONFLICT'), { code: 'REGISTRATION_CONFLICT' })
  for (const s of senses) {
    if (s?.definition?.function?.name) {
      senseRegistry[s.definition.function.name] = s
      origins.set(s.definition.function.name, {
        source: s.definition.function.name.startsWith('mcp__') ? 'mcp' : 'custom',
      })
    }
  }
  senseRegistryVersion++
}

/**
 * 清空全局感官注册表。
 * 用于重新编译/重新加载 sense 后重建 registry，避免已删除的外部 sense 残留。
 */
export function resetSenses(): void {
  for (const name of Object.keys(senseRegistry)) {
    delete senseRegistry[name]
  }
  origins.clear()
  unavailable.clear()
  senseRegistryVersion++
  localSenseNames = new Set()
}

/** Atomically replace built-in/compiled senses without touching MCP registrations. */
export function prepareLocalSenseReplacement(senses: Sense<ZodType>[]): () => void {
  const next = new Map<string, Sense<ZodType>>()
  for (const item of senses) {
    const name = item?.definition?.function?.name
    if (!name) throw new Error('本地感官缺少名称')
    if (name.startsWith('mcp__')) throw new Error(`本地感官不得使用 MCP 命名空间: ${name}`)
    if (next.has(name)) throw new Error(`本地感官名称重复: ${name}`)
    next.set(name, item)
  }
  return () => {
    for (const name of next.keys())
      if (senseRegistry[name] && !localSenseNames.has(name))
        throw Object.assign(new Error('REGISTRATION_CONFLICT'), { code: 'REGISTRATION_CONFLICT' })
    for (const name of localSenseNames) delete senseRegistry[name]
    for (const name of localSenseNames) origins.delete(name)
    for (const [name, item] of next) {
      senseRegistry[name] = item
      origins.set(name, { source: 'builtin' })
    }
    localSenseNames = new Set(next.keys())
    senseRegistryVersion++
  }
}

export function replaceLocalSenses(senses: Sense<ZodType>[]): void {
  prepareLocalSenseReplacement(senses)()
}

/**
 * 按名称批量注销感官（仅删除指定名称，不影响内置/编译感官）。
 * 用于 MCP server disconnect：删除该 server 注册的 mcp__<server>__* senses，
 * 与 resetSenses（全清）互补——保留其他感官。
 */
export function unregisterSenses(names: string[]): void {
  for (const name of names) {
    delete senseRegistry[name]
    origins.delete(name)
  }
  senseRegistryVersion++
}

/**
 * 旧 sense 名 → 新名别名（向后兼容旧 config 的 sense_groups 引用）。
 * 子 agent→角色 重命名后，sense 名 spawn_subagent→spawn_role、destroy_subagent→destroy_role；
 * registerSenses 注册新名，此处仅在按旧名查找未命中时回退到新名（fail loud 之外的最小兼容）。
 */
const SENSE_NAME_ALIASES: Record<string, string> = {
  spawn_subagent: 'spawn_role',
  destroy_subagent: 'destroy_role',
}

/**
 * 按名称获取单个感官实例（命中旧名别名时回退到新名，兼容历史/外部 sense_groups 配置）。
 */
export function getSense(name: string): Sense<ZodType> | undefined {
  const direct = senseRegistry[name]
  if (direct) return direct
  const alias = SENSE_NAME_ALIASES[name]
  return alias ? senseRegistry[alias] : undefined
}
