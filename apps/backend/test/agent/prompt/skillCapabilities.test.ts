import { describe, expect, it } from 'vitest'
import {
  checkSkillCapabilities,
  parseSkillCapabilityDependencies,
} from '@/agent/prompt/skillCapabilities.js'
import type { FileCapabilityResolution } from '@/service/fileServices/capabilityResolver.js'
import type { FileCapabilityOperation } from '@chery/protocol'

function resolved(operation: FileCapabilityOperation, availability: FileCapabilityResolution['availability']): FileCapabilityResolution {
  return { operation, availability, source: 'role', mode: 'tool', targetId: 'chosen_tool', inputConstraints: {}, outputKinds: ['text'], reasonCode: 'test', reason: '检查结果', configRevision: 'r1' }
}

describe('skill capability dependencies', () => {
  it('keeps undeclared skills distinct from explicitly empty dependency lists', () => {
    expect(checkSkillCapabilities(parseSkillCapabilityDependencies({}))).toMatchObject({ declaration: 'undeclared', canActivate: true })
    expect(checkSkillCapabilities(parseSkillCapabilityDependencies({ requires: { capabilities: [] } }))).toMatchObject({ declaration: 'declared', canActivate: true })
  })

  it('parses and deduplicates operation lists without inventing dependencies', () => {
    expect(parseSkillCapabilityDependencies({ requires: { capabilities: ['image.generate', 'image.generate'] }, optional: { capabilities: ['image.inspect'] }, unrelated: true })).toEqual({
      requires: { capabilities: ['image.generate'] }, optional: { capabilities: ['image.inspect'] },
    })
  })

  it.each([
    { requires: { capabilities: 'image.generate' } },
    { requires: { capabilities: ['imaginary.operation'] } },
    { requires: ['image.generate'] },
    { optional: { capabilities: [true] } },
  ])('rejects malformed/unknown dependencies at activation, not equipment parsing: %j', value => {
    const parsed = parseSkillCapabilityDependencies(value)
    expect(parsed.capabilityDependencyErrors?.length).toBeGreaterThan(0)
    expect(checkSkillCapabilities(parsed)).toMatchObject({ declaration: 'invalid', canActivate: false })
  })

  it.each(['unavailable', 'unknown', 'selection_required'] as const)('blocks required %s operations', availability => {
    expect(checkSkillCapabilities({ requires: { capabilities: ['image.generate'] } }, operation => resolved(operation, availability))).toMatchObject({ canActivate: false, missingRequired: ['image.generate'] })
  })

  it('does not treat a missing runtime check as available', () => {
    expect(checkSkillCapabilities({ requires: { capabilities: ['image.generate'] } })).toMatchObject({ canActivate: false, missingRequired: ['image.generate'] })
  })

  it('allows skill activation with approval while preserving execution approval requirements', () => {
    expect(checkSkillCapabilities({ requires: { capabilities: ['image.generate'] } }, operation => resolved(operation, 'requires_approval'))).toMatchObject({ canActivate: true, requiresApproval: ['image.generate'] })
  })

  it('reports optional omissions without blocking required steps', () => {
    expect(checkSkillCapabilities({ requires: { capabilities: ['image.generate'] }, optional: { capabilities: ['image.inspect'] } }, operation => resolved(operation, operation === 'image.generate' ? 'available' : 'unknown'))).toMatchObject({ canActivate: true, missingRequired: [], skippedOptional: ['image.inspect'] })
  })

  it('uses one resolution per operation and rejects mixed configuration revisions', () => {
    const seen: FileCapabilityOperation[] = []
    const check = checkSkillCapabilities({ requires: { capabilities: ['image.generate'] }, optional: { capabilities: ['image.generate', 'image.inspect'] } }, operation => {
      seen.push(operation)
      return { ...resolved(operation, 'available'), configRevision: operation === 'image.generate' ? 'r1' : 'r2' }
    })
    expect(seen).toEqual(['image.generate', 'image.inspect'])
    expect(check.canActivate).toBe(false)
    expect(check.errors).toHaveLength(1)
  })
})
