import { describe, expect, it } from 'vitest'
import {
  applyConfigOperations,
  configOperationsSchema,
  getConfigBaseRevision,
} from '@/service/config/operations.js'
import { validateRawConfig, type ConfigRaw } from '@/utils/config.js'

function rawConfig(): ConfigRaw {
  return {
    global: { supervision: 'smart', thinking: true, stream: true },
    llm: {
      brain: {
        main: { provider: 'mock', model: 'mock_test', rpm: 30 },
      },
    },
    sense_groups: { leader: ['read_file'] },
    roles: {
      leader: {
        id: 'role-leader0001',
        brain: 'main',
        senseGroup: 'leader',
      },
    },
    presets: {
      default: {
        id: 'preset-default01',
        leader: 'leader',
        roles: ['leader'],
      },
    },
  }
}

describe('strongly typed config operations', () => {
  it('rejects stringified numeric and boolean fields before candidate application', () => {
    const parsed = configOperationsSchema.safeParse([
      {
        op: 'putBrain',
        name: 'main',
        brain: {
          provider: 'mock',
          model: 'mock_test',
          rpm: '30000',
          fullUrl: 'true',
        },
      },
    ])
    expect(parsed.success).toBe(false)
  })

  it('applies resource-level operations to a clone without mutating the base', () => {
    const base = rawConfig()
    const result = applyConfigOperations(base, [
      { op: 'putSenseGroup', name: 'leader', senses: ['read_file', 'config_manage:smart'] },
      {
        op: 'putBrain',
        name: 'main',
        brain: { provider: 'mock', model: 'mock_test', rpm: 60, fullUrl: true },
      },
      {
        op: 'putRole',
        name: 'leader',
        role: { brain: 'main', senseGroup: 'leader', description: 'updated' },
      },
    ])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.candidate.sense_groups?.leader).toEqual(['read_file', 'config_manage:smart'])
    expect(result.candidate.llm.brain.main?.rpm).toBe(60)
    expect(result.candidate.roles?.leader?.id).toBe('role-leader0001')
    expect(base.llm.brain.main?.rpm).toBe(30)
  })

  it('guards destructive identity operations with expectedId', () => {
    const result = applyConfigOperations(rawConfig(), [
      { op: 'removeRole', name: 'leader', expectedId: 'role-different0001' },
    ])
    expect(result).toEqual({
      ok: false,
      errors: [expect.stringContaining('id 已变化')],
    })
  })

  it('baseRevision covers connection-only fields and credential changes', () => {
    const first = rawConfig()
    const second = structuredClone(first)
    second.llm.brain.main!.rpm = 31
    expect(getConfigBaseRevision(second)).not.toBe(getConfigBaseRevision(first))

    const third = structuredClone(first)
    third.llm.brain.main!.key = 'different-secret'
    expect(getConfigBaseRevision(third)).not.toBe(getConfigBaseRevision(first))
  })

  it('full candidate validation rejects duplicate stable identities', () => {
    const candidate = rawConfig()
    candidate.roles!.other = {
      id: 'role-leader0001',
      brain: 'main',
      senseGroup: 'leader',
    }
    expect(validateRawConfig(candidate)).toContain(
      'roles.other.id 与 roles.leader.id 重复：role-leader0001',
    )
  })
})
