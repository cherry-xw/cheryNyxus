import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { RuntimeResolver } from '@/agent/runtimeResolver.js'
import { getAppliedRawConfig, replaceRuntimeConfig } from '@/utils/config.js'
import { bootstrapForTests } from './helpers/agentHarness.js'

describe('runtime resolver config snapshots', () => {
  const baseline = getAppliedRawConfig()

  beforeAll(async () => {
    await bootstrapForTests()
  })

  afterEach(() => {
    replaceRuntimeConfig(baseline)
  })

  it('keeps a resolved run stable and gives the next resolution the new brain', () => {
    const selection = { brain: 'mock_content', senseGroup: 'auto_senses', mcpServers: [] }
    const resolver = new RuntimeResolver()
    const oldRun = resolver.resolve(selection)
    const candidate = getAppliedRawConfig()
    candidate.llm.brain.mock_content!.url = 'http://next-run.example/v1'

    replaceRuntimeConfig(candidate)
    const nextRun = resolver.resolve(selection)

    expect(nextRun.brain.url).toBe('http://next-run.example/v1')
    expect(oldRun.brain.url).not.toBe(nextRun.brain.url)
    expect(oldRun.adapters.llmAdapter).toBeDefined()
    expect(nextRun.adapters.llmAdapter).toBeDefined()
    expect(oldRun.senseTable.has('read_file')).toBe(true)
    expect(nextRun.senseTable.has('read_file')).toBe(true)
  })
})
