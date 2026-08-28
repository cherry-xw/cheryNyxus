import { describe, expect, it } from 'vitest'
import { createConfigRevision } from '@/service/config/revision.js'
import type { ConfigRaw } from '@/utils/config.js'
import {
  assertAgentExecutionAllowed,
  enterMaintenanceMode,
  getMaintenanceState,
  leaveMaintenanceMode,
} from '@/service/maintenanceMode.js'

describe('semantic config revisions', () => {
  it('never persists credential values in the audit snapshot', () => {
    const revision = createConfigRevision({
      source: 'structured',
      raw: {
        global: { supervision: 'smart' },
        llm: {
          brain: {
            private: {
              provider: 'openai',
              model: 'model',
              key: 'sk-do-not-store',
            },
          },
        },
        roles: {},
        presets: {},
        sense_groups: {},
        mcp_servers: {
          private: {
            transport: 'streamable-http',
            url: 'https://user:password@example.invalid/mcp',
          },
        },
      } as unknown as ConfigRaw,
    })

    const serialized = JSON.stringify(revision.snapshot)
    expect(serialized).not.toContain('sk-do-not-store')
    expect(serialized).not.toContain('user:password')
    expect(serialized).toContain('[REDACTED]')
    expect(JSON.stringify(revision.resources)).not.toContain('sk-do-not-store')
  })
})

describe('fail-closed maintenance mode', () => {
  it('blocks Agent execution until a valid repair leaves maintenance', () => {
    enterMaintenanceMode('invalid config', ['roles.coder.brain missing'])
    expect(getMaintenanceState().active).toBe(true)
    expect(() => assertAgentExecutionAllowed()).toThrow(/维护模式/)
    leaveMaintenanceMode()
    expect(() => assertAgentExecutionAllowed()).not.toThrow()
  })
})
