import { describe, expect, it } from 'vitest'
import { validateRawConfig } from '@/utils/config.js'

function rawConfig() {
  return {
    global: { supervision: 'auto' },
    llm: { brain: { main: { model: 'model', provider: 'mock' } } },
    sense_groups: { tools: ['read_file'] },
    roles: {
      leader: { brain: 'main', senseGroup: 'tools' },
      explanation: { brain: 'main', senseGroup: 'tools', scope: 'public' },
    },
    presets: {
      default: {
        leader: 'leader',
        roles: ['leader', 'explanation'],
      },
    },
  }
}

describe('public role scope validation', () => {
  it('accepts a public role as an ordinary preset member', () => {
    expect(validateRawConfig(rawConfig() as never)).toEqual([])
  })

  it('rejects a public role as the preset leader', () => {
    const raw = rawConfig()
    raw.presets.default.leader = 'explanation'
    expect(validateRawConfig(raw as never)).toContain(
      'presets.default.leader "explanation" 不能是公共角色（组长必须是本预设的私有角色）',
    )
  })

  it('rejects a public role as the preset leader even when it is a member', () => {
    const raw = rawConfig()
    raw.presets.default.leader = 'explanation'
    raw.presets.default.roles = ['leader', 'explanation']
    expect(validateRawConfig(raw as never)).toContain(
      'presets.default.leader "explanation" 不能是公共角色（组长必须是本预设的私有角色）',
    )
  })

  it('allows a private-scope role to lead the preset', () => {
    const raw = rawConfig()
    raw.roles.leader.scope = 'private'
    expect(validateRawConfig(raw as never)).toEqual([])
  })
})
