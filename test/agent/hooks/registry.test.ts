/**
 * hooks registry 单测：loadHookRegistry 加载 + schema 校验 + brain 级合并 + 缓存。
 *
 * 用临时 CHERY_DIR 隔离，避免污染真实 .chery/。clearHookRegistry 在每个测试前清缓存。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import {
  loadHookRegistry,
  clearHookRegistry,
} from '@/agent/hooks/registry.js'

let tempCheryDir: string

function setupHooksJson(content: string): void {
  const hooksDir = join(tempCheryDir, '.chery', 'hooks')
  mkdirSync(hooksDir, { recursive: true })
  writeFileSync(join(hooksDir, 'hooks.json'), content)
}

describe('hooks registry', () => {
  beforeEach(() => {
    tempCheryDir = mkdtempSync(join(tmpdir(), 'cheryclaw-hooks-test-'))
    process.env.CHERY_DIR = tempCheryDir
    clearHookRegistry()
  })

  afterEach(() => {
    rmSync(tempCheryDir, { recursive: true, force: true })
  })

  it('全局 hooks.json 不存在 -> 空表（graceful degradation）', () => {
    const registry = loadHookRegistry()
    expect(registry.PreLLMRequest).toBeUndefined()
    expect(Object.keys(registry).length).toBe(0)
  })

  it('加载合法 hooks.json', () => {
    setupHooksJson(
      JSON.stringify({
        PreLLMRequest: [
          { matcher: 'anthropic', command: 'echo {}', timeout: 5 },
        ],
        PreToolUse: [{ matcher: 'write_file', command: 'guard.sh' }],
      }),
    )
    const registry = loadHookRegistry()
    expect(registry.PreLLMRequest).toHaveLength(1)
    expect(registry.PreLLMRequest?.[0]?.command).toBe('echo {}')
    expect(registry.PreLLMRequest?.[0]?.timeout).toBe(5)
    expect(registry.PreToolUse).toHaveLength(1)
  })

  it('缓存：第二次调用返回同一引用', () => {
    setupHooksJson(JSON.stringify({ Stop: [{ command: 'x.sh' }] }))
    const a = loadHookRegistry()
    const b = loadHookRegistry()
    expect(a).toBe(b) // 同一引用（缓存命中）
  })

  it('clearHookRegistry 后重读', () => {
    setupHooksJson(JSON.stringify({ Stop: [{ command: 'x.sh' }] }))
    const a = loadHookRegistry()
    clearHookRegistry()
    setupHooksJson(JSON.stringify({ Stop: [{ command: 'y.sh' }] }))
    const b = loadHookRegistry()
    expect(b).not.toBe(a)
    expect(b.Stop?.[0]?.command).toBe('y.sh')
  })

  it('schema 校验：未知事件名跳过', () => {
    setupHooksJson(
      JSON.stringify({
        PreLLMRequest: [{ command: 'ok.sh' }],
        UnknownEvent: [{ command: 'bad.sh' }],
      }),
    )
    const registry = loadHookRegistry()
    expect(registry.PreLLMRequest).toHaveLength(1)
    expect((registry as Record<string, unknown>).UnknownEvent).toBeUndefined()
  })

  it('schema 校验：handler 非数组跳过', () => {
    setupHooksJson(
      JSON.stringify({
        PreLLMRequest: 'not-an-array',
        Stop: [{ command: 'ok.sh' }],
      }),
    )
    const registry = loadHookRegistry()
    expect(registry.PreLLMRequest).toBeUndefined()
    expect(registry.Stop).toHaveLength(1)
  })

  it('schema 校验：handler 项缺 command 跳过', () => {
    setupHooksJson(
      JSON.stringify({
        PreLLMRequest: [{ matcher: 'x' }, { command: 'ok.sh' }],
      }),
    )
    const registry = loadHookRegistry()
    expect(registry.PreLLMRequest).toHaveLength(1)
    expect(registry.PreLLMRequest?.[0]?.command).toBe('ok.sh')
  })

  it('JSON 解析失败 -> 空表（不抛）', () => {
    setupHooksJson('{ not valid json')
    const registry = loadHookRegistry()
    expect(Object.keys(registry).length).toBe(0)
  })

  it('非对象 JSON（数组）-> 空表', () => {
    setupHooksJson('[1, 2, 3]')
    const registry = loadHookRegistry()
    expect(Object.keys(registry).length).toBe(0)
  })

  it('空 handlers 列表不写入 registry', () => {
    setupHooksJson(
      JSON.stringify({
        PreLLMRequest: [], // 空
        Stop: [{ command: 'ok.sh' }],
      }),
    )
    const registry = loadHookRegistry()
    expect(registry.PreLLMRequest).toBeUndefined()
    expect(registry.Stop).toHaveLength(1)
  })

  it('timeout 缺省 undefined', () => {
    setupHooksJson(
      JSON.stringify({
        PreLLMRequest: [{ command: 'ok.sh' }], // 无 timeout
      }),
    )
    const registry = loadHookRegistry()
    expect(registry.PreLLMRequest?.[0]?.timeout).toBeUndefined()
  })

  it('matcher/if 字段类型校验', () => {
    setupHooksJson(
      JSON.stringify({
        PreLLMRequest: [
          { matcher: 123, if: 456, command: 'ok.sh' }, // 非字符串 -> undefined
        ],
      }),
    )
    const registry = loadHookRegistry()
    expect(registry.PreLLMRequest?.[0]?.matcher).toBeUndefined()
    expect(registry.PreLLMRequest?.[0]?.if).toBeUndefined()
    expect(existsSync(tempCheryDir)).toBe(true)
  })
})