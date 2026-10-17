import { isFileCapabilityOperation, type FileCapabilityOperation } from '@chery/protocol'
import type { FileCapabilityResolution } from '@/service/fileServices/capabilityResolver.js'

export interface SkillCapabilityDependencies {
  requires?: { capabilities: FileCapabilityOperation[] }
  optional?: { capabilities: FileCapabilityOperation[] }
  /** Invalid declarations block activation, but do not prevent equipping/saving a skill. */
  capabilityDependencyErrors?: string[]
}

/** Parse only capability dependencies; unrelated frontmatter remains owned by the loader. */
export function parseSkillCapabilityDependencies(frontmatter: Record<string, unknown>): SkillCapabilityDependencies {
  const result: SkillCapabilityDependencies = {}
  const errors: string[] = []
  for (const field of ['requires', 'optional'] as const) {
    const value = frontmatter[field]
    if (value === undefined) continue
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${field} 必须为对象`)
      continue
    }
    const capabilities = (value as Record<string, unknown>).capabilities
    if (capabilities === undefined) continue
    if (!Array.isArray(capabilities)) {
      errors.push(`${field}.capabilities 必须为操作 ID 列表`)
      continue
    }
    const operations: FileCapabilityOperation[] = []
    for (const operation of capabilities) {
      if (!isFileCapabilityOperation(operation)) errors.push(`${field}.capabilities 包含未知操作：${String(operation)}`)
      else if (!operations.includes(operation)) operations.push(operation)
    }
    result[field] = { capabilities: operations }
  }
  if (errors.length) result.capabilityDependencyErrors = errors
  return result
}

export interface SkillCapabilityCheck {
  declaration: 'undeclared' | 'declared' | 'invalid'
  canActivate: boolean
  required: FileCapabilityResolution[]
  optional: FileCapabilityResolution[]
  missingRequired: FileCapabilityOperation[]
  skippedOptional: FileCapabilityOperation[]
  requiresApproval: FileCapabilityOperation[]
  errors: string[]
}

export type SkillCapabilityResolver = (operation: FileCapabilityOperation) => FileCapabilityResolution

/** Shared by equipment preview and explicit activation; never changes ordinary chat. */
export function checkSkillCapabilities(
  skill: SkillCapabilityDependencies,
  resolve?: SkillCapabilityResolver,
): SkillCapabilityCheck {
  const requiredIds = skill.requires?.capabilities ?? []
  const optionalIds = skill.optional?.capabilities ?? []
  const errors = [...(skill.capabilityDependencyErrors ?? [])]
  const resolved = new Map<FileCapabilityOperation, FileCapabilityResolution>()
  for (const operation of new Set([...requiredIds, ...optionalIds])) {
    if (!resolve) continue
    const capability = resolve(operation)
    if (capability.operation !== operation) errors.push(`能力检查返回了错误操作：${operation}`)
    else resolved.set(operation, capability)
  }
  if (new Set([...resolved.values()].map(value => value.configRevision)).size > 1) {
    errors.push('技能能力检查使用了不同配置版本，请重新检查')
  }
  const usable = (operation: FileCapabilityOperation) => {
    const availability = resolved.get(operation)?.availability
    return availability === 'available' || availability === 'requires_approval'
  }
  return {
    declaration: errors.length ? 'invalid' : skill.requires || skill.optional ? 'declared' : 'undeclared',
    canActivate: errors.length === 0 && requiredIds.every(usable),
    required: requiredIds.flatMap(operation => resolved.get(operation) ? [resolved.get(operation)!] : []),
    optional: optionalIds.flatMap(operation => resolved.get(operation) ? [resolved.get(operation)!] : []),
    missingRequired: requiredIds.filter(operation => !usable(operation)),
    skippedOptional: optionalIds.filter(operation => !usable(operation)),
    requiresApproval: [...resolved.values()].filter(value => value.availability === 'requires_approval').map(value => value.operation),
    errors,
  }
}
