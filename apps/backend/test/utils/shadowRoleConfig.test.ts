import { describe, expect, it } from 'vitest'
import { validateRawConfig } from '@/utils/config.js'

function rawConfig() {
  return {
    global: { supervision: 'auto' },
    llm: { brain: { main: { model: 'model', provider: 'mock' } } },
    sense_groups: {
      tools: ['read_file'],
      routing: ['select_conversation:auto'],
    },
    roles: {
      leader: { brain: 'main', senseGroup: 'tools' },
      router: {
        kind: 'shadow',
        brain: 'main',
        senseGroup: 'routing',
        mcpServers: [],
      },
    },
    presets: {
      default: {
        leader: 'leader',
        roles: ['leader'],
        shadows: { conversationRouting: 'router' },
      },
    },
  }
}

describe('shadow role config isolation', () => {
  it('accepts a dedicated conversation routing Shadow', () => {
    expect(validateRawConfig(rawConfig() as never)).toEqual([])
  })

  it('rejects Shadow roles as preset team members', () => {
    const raw = rawConfig()
    raw.presets.default.roles.push('router')
    expect(validateRawConfig(raw as never)).toContain(
      'presets.default.roles 只能引用普通角色，收到 "router"（可用：leader）',
    )
  })

  it('rejects mentionable Shadow roles', () => {
    const raw = rawConfig()
    Object.assign(raw.roles.router, { mentionable: true })
    expect(validateRawConfig(raw as never)).toContain(
      'roles.router 是 Shadow，不能配置 mentionable:true',
    )
  })

  it('requires the routing Shadow group to contain only the terminal tool', () => {
    const raw = rawConfig()
    raw.sense_groups.routing.push('read_file')
    expect(validateRawConfig(raw as never)).toContain(
      '会话路由 Shadow "router" 的 senseGroup 必须且只能包含 select_conversation:auto',
    )
  })

  it('rejects MCP on the conversation routing Shadow', () => {
    const raw = rawConfig()
    raw.roles.router.mcpServers = ['external']
    expect(validateRawConfig(raw as never)).toContain(
      '会话路由 Shadow "router" 不能配置 MCP server',
    )
  })
})
