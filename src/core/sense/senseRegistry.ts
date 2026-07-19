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

/**
 * 注册表版本号：每次变更（register/reset/unregister）递增。
 * AgentSession 在 configureRuntime 时快照此版本，send/resume 入口比对——
 * 不一致说明 registry 被 mcp.reload/重编译改动，需重建 senseTable（见 runtime.ts ensureChat）。
 */
let senseRegistryVersion = 0

/** 取当前注册表版本号（用于 stale 比对）。 */
export function getSenseRegistryVersion(): number {
  return senseRegistryVersion
}

/**
 * 批量注册感官到全局注册表
 */
export function registerSenses(senses: Sense<ZodType>[]): void {
  for (const s of senses) {
    if (s?.definition?.function?.name) {
      senseRegistry[s.definition.function.name] = s
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
  senseRegistryVersion++
}

/**
 * 按名称批量注销感官（仅删除指定名称，不影响内置/编译感官）。
 * 用于 MCP server disconnect：删除该 server 注册的 mcp__<server>__* senses，
 * 与 resetSenses（全清）互补——保留其他感官。
 */
export function unregisterSenses(names: string[]): void {
  for (const name of names) {
    delete senseRegistry[name]
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
