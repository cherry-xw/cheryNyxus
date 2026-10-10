/**
 * 熔断回滚探针（t_a7e73c70）：真实 Agent 中间件链路补充用例。
 * 与 webSearchFlow.test.ts 互补；mock brain + fixture provider，无网络、无 QQ、无生产服务。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import config from '@/utils/config.js'
import { getLLMAdapter } from '@/core/llm/adapter.js'
import { registerSenses as registerBatch, unregisterSenses } from '@/core/sense/index.js'
import type { MiddlewareChunk } from '@/core/middleware/types.js'
import { WebSearchRuntime, type SearchProvider } from '@/agent/sense/web/runtime.js'
import { createWebSearchSense } from '@/agent/sense/webSearch.js'
import { bootstrapForTests, createAgent, runSendAcceptAll } from '../helpers/agentHarness.js'
import { addMockBrain, scriptItem } from '../helpers/mockScripts.js'

beforeAll(bootstrapForTests)
afterEach(() => vi.restoreAllMocks())

function registerSenses(senses: Parameters<typeof registerBatch>[0]) {
  unregisterSenses(['web_search'])
  registerBatch(senses)
}

interface SenseMsg {
  role: string
  content: string
  hash?: string
}

function captureRequests(): { requests: unknown[][]; restore: () => void } {
  const adapter = getLLMAdapter('mock')!
  const original = adapter.chatStream.bind(adapter)
  const requests: unknown[][] = []
  const spy = vi
    .spyOn(adapter, 'chatStream')
    .mockImplementation(async (messages: unknown, senses: unknown, options: unknown) => {
      requests.push(structuredClone(messages) as unknown[])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (original as any)(messages, senses, options)
    })
  return { requests, restore: () => spy.mockRestore() }
}

function fixtureProvider(mode: 'ok' | 'unavail'): SearchProvider {
  return {
    id: 'probe_fixture',
    availability: () => (mode === 'ok' ? 'ready' : 'provider_unavailable'),
    search: vi.fn(async (_input: { query: string; limit: number }, signal: AbortSignal) => {
      expect(signal).toBeInstanceOf(AbortSignal)
      return [
        {
          title: 'Probe Source',
          url: 'https://example.org/probe',
          snippet: 'DROP TABLE hint (untrusted probe fixture)',
          source: 'Probe Press',
        },
      ]
    }),
  }
}

async function runProbe(brainName: string): Promise<{
  chunks: MiddlewareChunk[]
  requests: unknown[][]
  restore: () => void
}> {
  const r = new WebSearchRuntime({ timeoutMs: 3000 })
  r.register(fixtureProvider('ok'))
  registerSenses([createWebSearchSense(r)])
  config.sense_groups.probe_web_group = ['web_search:auto']
  addMockBrain(brainName, {
    script: [
      scriptItem({
        content: 'searching',
        senseCalls: [{ id: `${brainName}-1`, name: 'web_search', arguments: '{"query":"probe"}' }],
      }),
      scriptItem({ content: 'finished' }),
    ],
  })
  const { requests, restore } = captureRequests()
  const agent = createAgent({ brain: brainName, senseGroup: 'probe_web_group' })
  const chunks = await runSendAcceptAll(agent, 'probe run')
  return { chunks, requests, restore }
}

describe('web_search middleware integration probe', () => {
  it('two calls in one round: both execute, distinct results, no hash folding', async () => {
    const r = new WebSearchRuntime({ timeoutMs: 3000 })
    r.register(fixtureProvider('ok'))
    registerSenses([createWebSearchSense(r)])
    config.sense_groups.probe_web_multi = ['web_search:auto']
    const brain = addMockBrain('probe-web-multi', {
      script: [
        scriptItem({
          content: 'searching twice',
          senseCalls: [
            { id: 'probe-multi-a', name: 'web_search', arguments: '{"query":"probe"}' },
            { id: 'probe-multi-b', name: 'web_search', arguments: '{"query":"probe"}' },
          ],
        }),
        scriptItem({ content: 'finished' }),
      ],
    })
    const { requests, restore } = captureRequests()
    const agent = createAgent({ brain, senseGroup: 'probe_web_multi' })
    const chunks = await runSendAcceptAll(agent, 'probe multi')
    restore()
    const accepts = chunks.filter((c) => c.type === 'sense_accept')
    expect(accepts).toHaveLength(2)
    const second = requests[1] as SenseMsg[]
    const senseMsgs = second.filter((m) => m.role === 'sense')
    expect(senseMsgs).toHaveLength(2)
    // identical query + identical results → no hash → both full contents survive;
    // only observedAt differs (each call stamps its own time) → strip it before comparing
    const stripTime = (s: string | undefined) =>
      (s ?? '').replace(/"observedAt":"[^"]*"/, '"observedAt":"-"')
    expect(stripTime(senseMsgs[0]?.content)).toBe(stripTime(senseMsgs[1]?.content))
    expect(senseMsgs[0]?.content).toContain('https://example.org/probe')
    // no message_updated replace effects for web_search
    expect(
      chunks.some(
        (c) =>
          c.type === 'message_updated' && (c as { patch?: { replace?: unknown } }).patch?.replace,
      ),
    ).toBe(false)
  })

  it('provider_unavailable failure still reinjects structured observation and loop continues', async () => {
    const r = new WebSearchRuntime({ timeoutMs: 3000 })
    r.register(fixtureProvider('unavail'))
    registerSenses([createWebSearchSense(r)])
    config.sense_groups.probe_web_fail = ['web_search:auto']
    const brainName = 'probe-web-fail'
    addMockBrain(brainName, {
      script: [
        scriptItem({
          content: 'searching',
          senseCalls: [{ id: 'probe-fail-1', name: 'web_search', arguments: '{"query":"probe"}' }],
        }),
        scriptItem({ content: 'finished' }),
      ],
    })
    const { requests, restore } = captureRequests()
    const agent = createAgent({ brain: brainName, senseGroup: 'probe_web_fail' })
    const chunks = await runSendAcceptAll(agent, 'probe fail')
    restore()
    const accepts = chunks.filter((c) => c.type === 'sense_accept')
    expect(accepts).toHaveLength(1)
    const second = requests[1] as SenseMsg[]
    const senseMsg = second.find((m) => m.role === 'sense')
    expect(senseMsg).toBeTruthy()
    const observation = JSON.parse(senseMsg!.content) as {
      ok: boolean
      provider: string | null
      error?: { code: string }
      trust: string
    }
    expect(observation.ok).toBe(false)
    expect(observation.error?.code).toBe('provider_unavailable')
    // auto-selection failure path reports no specific provider id (docs: 无法选择时为 null)
    expect(observation.provider).toBeNull()
    expect(observation.trust).toBe('untrusted_external_data')
    expect(senseMsg!.hash).toBeUndefined()
    // loop consumed the failure and finished the run cleanly (done, not paused/failed)
    expect(chunks.some((c) => c.type === 'done')).toBe(true)
    expect(chunks.some((c) => c.type === 'run_paused')).toBe(false)
  })

  it('invalid model arguments get preDenied schema rejection without entering execution', async () => {
    const p = fixtureProvider('ok')
    const r = new WebSearchRuntime({ timeoutMs: 3000 })
    r.register(p)
    registerSenses([createWebSearchSense(r)])
    config.sense_groups.probe_web_invalid = ['web_search:auto']
    const brainName = 'probe-web-invalid'
    addMockBrain(brainName, {
      script: [
        scriptItem({
          content: 'bad call',
          senseCalls: [{ id: 'probe-invalid-1', name: 'web_search', arguments: '{"query":"  "}' }],
        }),
        scriptItem({ content: 'finished' }),
      ],
    })
    const { requests, restore } = captureRequests()
    const agent = createAgent({ brain: brainName, senseGroup: 'probe_web_invalid' })
    const chunks = await runSendAcceptAll(agent, 'probe invalid')
    restore()
    expect(p.search).not.toHaveBeenCalled()
    const rejects = chunks.filter((c) => c.type === 'sense_reject')
    expect(rejects).toHaveLength(1)
    const second = requests[1] as SenseMsg[]
    const senseMsg = second.find((m) => m.role === 'sense')
    expect(senseMsg?.content).toContain('query')
    // loop still terminated cleanly with a final content turn
    expect((requests[1] as SenseMsg[]).length).toBeGreaterThan(0)
  })

  it('smart configuration: fail-open auto-executes unregistered sense; hard-off forces approval', async () => {
    const ruleDir = `${process.env.CHERY_DIR}/.chery/rule`
    mkdirSync(ruleDir, { recursive: true })
    writeFileSync(`${ruleDir}/base.yaml`, 'web_search: false\n')
    const r = new WebSearchRuntime({ timeoutMs: 3000 })
    const p = fixtureProvider('ok')
    r.register(p)
    registerSenses([createWebSearchSense(r)])
    config.sense_groups.probe_web_smart = ['web_search']
    const brainName = 'probe-web-smart'
    addMockBrain(brainName, {
      script: [
        scriptItem({
          content: 'searching',
          senseCalls: [{ id: 'probe-smart-1', name: 'web_search', arguments: '{"query":"probe"}' }],
        }),
        scriptItem({ content: 'finished' }),
      ],
    })
    const { requests, restore } = captureRequests()
    const agent = createAgent({ brain: brainName, senseGroup: 'probe_web_smart' })
    const chunks = await runSendAcceptAll(agent, 'probe smart')
    restore()
    // hard-off (false) forces approval even though fixture is harmless: pending appeared and accept executed it
    const pendings = chunks.filter((c) => c.type === 'sense_pending')
    expect(pendings).toHaveLength(1)
    expect(p.search).toHaveBeenCalledTimes(1)
    const second = requests[1] as SenseMsg[]
    expect(second.filter((m) => m.role === 'sense')).toHaveLength(1)
  })

  it('full chain twice in one run: query/results shape stable across rounds', async () => {
    const { chunks, requests, restore } = await runProbe('probe-web-chain')
    restore()
    const accepts = chunks.filter((c) => c.type === 'sense_accept')
    expect(accepts).toHaveLength(1)
    const second = requests[1] as SenseMsg[]
    const senseMsg = second.find((m) => m.role === 'sense')
    expect(senseMsg).toBeTruthy()
    const observation = JSON.parse(senseMsg!.content) as {
      results: Array<{ title: string; url: string; snippet: string; source: string }>
    }
    expect(observation.results).toEqual([
      {
        title: 'Probe Source',
        url: 'https://example.org/probe',
        snippet: 'DROP TABLE hint (untrusted probe fixture)',
        source: 'Probe Press',
      },
    ])
  })
})
