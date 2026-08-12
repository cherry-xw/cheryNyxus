import { describe, expect, it } from 'vitest'
import { validateRawConfig } from '@/utils/config.js'

function rawConfig() {
  return {
    global: { supervision: 'auto' },
    llm: { brain: { main: { model: 'model', provider: 'mock' } } },
    sense_groups: { tools: ['read_file'] },
    roles: {
      leader: { brain: 'main', senseGroup: 'tools' },
      explanation: { brain: 'main', senseGroup: 'tools', mentionable: false },
    },
    presets: {
      default: {
        leader: 'leader',
        roles: ['leader', 'explanation'],
        detailRole: 'explanation',
      },
    },
  }
}

describe('detail role config isolation', () => {
  it('accepts a detail role configured through the ordinary role model', () => {
    expect(validateRawConfig(rawConfig() as never)).toEqual([])
  })

  it('rejects a detail role outside config.roles', () => {
    const raw = rawConfig()
    raw.presets.default.detailRole = 'missing'
    expect(validateRawConfig(raw as never)).toContain(
      'presets.default.detailRole "missing" 不在 config.roles 列表',
    )
  })

  it('requires the detail role to be a selected preset member', () => {
    const raw = rawConfig()
    raw.presets.default.roles = ['leader']
    expect(validateRawConfig(raw as never)).toContain(
      'presets.default.detailRole "explanation" 不在其 roles 成员列表中',
    )
  })

  it('uses ordinary role validation for the detail role runtime', () => {
    const raw = rawConfig()
    raw.roles.explanation.brain = 'missing'
    expect(validateRawConfig(raw as never)).toEqual(
      expect.arrayContaining([expect.stringContaining('roles.explanation.brain "missing" 不在 llm.brain 列表')]),
    )
  })

  it('keeps the dedicated detail role distinct from the leader', () => {
    const raw = rawConfig()
    raw.presets.default.detailRole = 'leader'
    expect(validateRawConfig(raw as never)).toContain(
      'presets.default.detailRole 不能与 leader 使用同一角色',
    )
  })
})
