/**
 * hooks dispatch 单测：PreLLMRequest 完整路径（body 替换 / block 阻断 / matcher 过滤 / if 谓词）。
 *
 * handler command 用简单 shell echo 输出 JSON（不依赖外部 jq 等）。
 * 用临时 CHERY_DIR + hooks.json 隔离。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { dispatch } from '@/agent/hooks/dispatch.js'
import { clearHookRegistry } from '@/agent/hooks/registry.js'
import { ClassifiedError } from '@/utils/error.js'
import type { PreLLMRequestPayload, PreToolUsePayload } from '@/agent/hooks/types.js'

let tempCheryDir: string

function setupHooksJson(content: string): void {
  const hooksDir = join(tempCheryDir, '.chery', 'hooks')
  mkdirSync(hooksDir, { recursive: true })
  writeFileSync(join(hooksDir, 'hooks.json'), content)
}

function makePreLLMRequestPayload(overrides: Partial<PreLLMRequestPayload> = {}): PreLLMRequestPayload {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-4',
    url: 'https://api.anthropic.com',
    thinking: 'high',
    stream: false,
    body: { model: 'claude-sonnet-4', max_tokens: 16384, messages: [] },
    ...overrides,
  }
}

describe('hooks dispatch PreLLMRequest', () => {
  beforeEach(() => {
    tempCheryDir = mkdtempSync(join(tmpdir(), 'cheryclaw-dispatch-test-'))
    process.env.CHERY_DIR = tempCheryDir
    clearHookRegistry()
  })

  afterEach(() => {
    rmSync(tempCheryDir, { recursive: true, force: true })
  })

  it('无 handler 注册 -> 返回 undefined，payload 不变', async () => {
    // hooks.json 不存在
    const payload = makePreLLMRequestPayload()
    const originalBody = payload.body
    const result = await dispatch('PreLLMRequest', payload, { brain: '' })
    expect(result).toBeUndefined()
    expect(payload.body).toBe(originalBody)
  })

  it('handler 返回 {body} -> payload.body 被替换', async () => {
    setupHooksJson(
      JSON.stringify({
        PreLLMRequest: [
          // echo 输出新 body JSON
          { command: `echo '{"body":{"model":"claude-new","max_tokens":65536}}'` },
        ],
      }),
    )
    const payload = makePreLLMRequestPayload()
    await dispatch('PreLLMRequest', payload, { brain: '' })
    expect(payload.body.model).toBe('claude-new')
    expect(payload.body.max_tokens).toBe(65536)
  })

  it('handler 返回空 JSON -> payload 不变', async () => {
    setupHooksJson(
      JSON.stringify({
        PreLLMRequest: [{ command: `echo '{}'` }],
      }),
    )
    const payload = makePreLLMRequestPayload()
    const originalModel = payload.body.model
    await dispatch('PreLLMRequest', payload, { brain: '' })
    expect(payload.body.model).toBe(originalModel)
  })

  it('handler 返回 {decision:block,reason} -> 抛 ClassifiedError', async () => {
    setupHooksJson(
      JSON.stringify({
        PreLLMRequest: [
          { command: `echo '{"decision":"block","reason":"被测试拦截"}'` },
        ],
      }),
    )
    const payload = makePreLLMRequestPayload()
    await expect(dispatch('PreLLMRequest', payload, { brain: '' })).rejects.toThrow(
      ClassifiedError,
    )
    try {
      await dispatch('PreLLMRequest', payload, { brain: '' })
    } catch (err) {
      expect((err as ClassifiedError).userMessage).toBe('被测试拦截')
      expect((err as ClassifiedError).category).toBe('validation')
      expect((err as ClassifiedError).source).toBe('hook')
    }
  })

  it('matcher 过滤：不匹配的 provider 跳过 handler', async () => {
    setupHooksJson(
      JSON.stringify({
        PreLLMRequest: [
          { matcher: 'openai', command: `echo '{"body":{"model":"should-not-apply"}}'` },
        ],
      }),
    )
    const payload = makePreLLMRequestPayload({ provider: 'anthropic' })
    const originalModel = payload.body.model
    await dispatch('PreLLMRequest', payload, { brain: '' })
    expect(payload.body.model).toBe(originalModel) // 未被替换
  })

  it('if 谓词过滤：条件不满足跳过 handler', async () => {
    setupHooksJson(
      JSON.stringify({
        PreLLMRequest: [
          {
            if: 'payload.thinking == "low"',
            command: `echo '{"body":{"model":"low-only"}}'`,
          },
        ],
      }),
    )
    const payload = makePreLLMRequestPayload({ thinking: 'high' })
    const originalModel = payload.body.model
    await dispatch('PreLLMRequest', payload, { brain: '' })
    expect(payload.body.model).toBe(originalModel) // 谓词不满足，未替换
  })

  it('if 谓词满足 -> handler 执行', async () => {
    setupHooksJson(
      JSON.stringify({
        PreLLMRequest: [
          {
            if: 'payload.thinking == "high"',
            command: `echo '{"body":{"model":"applied"}}'`,
          },
        ],
      }),
    )
    const payload = makePreLLMRequestPayload({ thinking: 'high' })
    await dispatch('PreLLMRequest', payload, { brain: '' })
    expect(payload.body.model).toBe('applied')
  })

  it('顺序执行：多 handler 串联，后置看到前置的修改', async () => {
    setupHooksJson(
      JSON.stringify({
        PreLLMRequest: [
          { command: `echo '{"body":{"step":1}}'` },
          // 第二个 handler 读 stdin payload（含 step:1）并附加 step2
          { command: `node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));d.payload.body.step=2;process.stdout.write(JSON.stringify({body:d.payload.body}))"` },
        ],
      }),
    )
    const payload = makePreLLMRequestPayload()
    await dispatch('PreLLMRequest', payload, { brain: '' })
    expect(payload.body.step).toBe(2) // 第二个 handler 覆盖
  })

  it('handler stdout 非法 JSON -> 跳过该 handler，不阻断', async () => {
    setupHooksJson(
      JSON.stringify({
        PreLLMRequest: [{ command: `echo 'not-json'` }],
      }),
    )
    const payload = makePreLLMRequestPayload()
    const originalModel = payload.body.model
    await expect(dispatch('PreLLMRequest', payload, { brain: '' })).resolves.toBeUndefined()
    expect(payload.body.model).toBe(originalModel)
  })

  it('handler exit 2 -> 抛 ClassifiedError（阻断）', async () => {
    setupHooksJson(
      JSON.stringify({
        PreLLMRequest: [{ command: `echo 'blocked reason' >&2; exit 2` }],
      }),
    )
    const payload = makePreLLMRequestPayload()
    await expect(dispatch('PreLLMRequest', payload, { brain: '' })).rejects.toThrow(
      ClassifiedError,
    )
  })
})

describe('hooks dispatch PreToolUse', () => {
  beforeEach(() => {
    tempCheryDir = mkdtempSync(join(tmpdir(), 'cheryclaw-dispatch-test-'))
    process.env.CHERY_DIR = tempCheryDir
    clearHookRegistry()
  })

  afterEach(() => {
    rmSync(tempCheryDir, { recursive: true, force: true })
  })

  it('handler 返回 {updatedInput} -> payload.args 合并', async () => {
    setupHooksJson(
      JSON.stringify({
        PreToolUse: [
          { command: `echo '{"updatedInput":{"path":"/safe"}}'` },
        ],
      }),
    )
    const payload: PreToolUsePayload = {
      name: 'write_file',
      args: { path: '/orig', content: 'x' },
      chatId: 'c1',
    }
    await dispatch('PreToolUse', payload, { brain: '' })
    expect(payload.args.path).toBe('/safe') // 被覆盖
    expect(payload.args.content).toBe('x') // 保留
  })

  it('handler 返回 {decision:block} -> 抛 ClassifiedError', async () => {
    setupHooksJson(
      JSON.stringify({
        PreToolUse: [
          { command: `echo '{"decision":"block","reason":"工具被禁"}'` },
        ],
      }),
    )
    const payload: PreToolUsePayload = {
      name: 'write_file',
      args: {},
      chatId: 'c1',
    }
    await expect(dispatch('PreToolUse', payload, { brain: '' })).rejects.toThrow(
      ClassifiedError,
    )
  })

  it('matcher 按 tool name 过滤', async () => {
    setupHooksJson(
      JSON.stringify({
        PreToolUse: [
          { matcher: 'read_file', command: `echo '{"updatedInput":{"blocked":true}}'` },
        ],
      }),
    )
    const payload: PreToolUsePayload = {
      name: 'write_file', // 不匹配 read_file
      args: {},
      chatId: 'c1',
    }
    await dispatch('PreToolUse', payload, { brain: '' })
    expect(payload.args.blocked).toBeUndefined() // 未应用
  })
})

describe('hooks dispatch stub 事件', () => {
  beforeEach(() => {
    tempCheryDir = mkdtempSync(join(tmpdir(), 'cheryclaw-dispatch-test-'))
    process.env.CHERY_DIR = tempCheryDir
    clearHookRegistry()
  })

  afterEach(() => {
    rmSync(tempCheryDir, { recursive: true, force: true })
  })

  it('未注册 handler 的事件 -> 返回 undefined（stub）', async () => {
    const result = await dispatch(
      'SessionStart',
      { chatId: 'c1', brain: 'main' },
      { brain: '' },
    )
    expect(result).toBeUndefined()
  })

  it('SessionEnd -> 返回 undefined', async () => {
    const result = await dispatch(
      'SessionEnd',
      { chatId: 'c1', reason: 'close' },
      { brain: '' },
    )
    expect(result).toBeUndefined()
  })
})