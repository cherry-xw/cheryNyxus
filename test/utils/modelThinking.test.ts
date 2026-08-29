/**
 * modelThinking.ts 单测：{display, params} 解析、非法条目丢弃、匹配顺序（精确 > 最长前缀 > 通配）、
 * 兜底显示词、resolveThinkingParams 命中/未命中/空片段语义。
 *
 * 加载依赖 `.chery/model-thinking.yaml`（路径 = CHERY_DIR/.chery/model-thinking.yaml）且模块内
 * in-memory 单例缓存——每个用例写 fixture 后 `vi.resetModules()` + 动态 import 重新加载。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as MT from '@/utils/modelThinking.js'

describe('modelThinking', () => {
  let tmpDirs: string[] = []

  beforeEach(() => {
    tmpDirs = []
  })

  afterEach(() => {
    delete process.env.CHERY_DIR
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
    vi.resetModules()
  })

  /** loadWith 包装：记录临时目录供清理。 */
  async function load(yamlContent: string): Promise<typeof MT> {
    const dir = mkdtempSync(path.join(tmpdir(), 'chery-mt-'))
    tmpDirs.push(dir)
    mkdirSync(path.join(dir, '.chery'), { recursive: true })
    writeFileSync(path.join(dir, '.chery', 'model-thinking.yaml'), yamlContent, 'utf8')
    process.env.CHERY_DIR = dir
    vi.resetModules()
    return await import('@/utils/modelThinking.js')
  }

  it('解析 {display, params} 格式并按文件顺序返回显示词', async () => {
    const mt = await load(`
models:
  - aliases: [minimax, MiniMax-M3]
    thinking:
      - {display: off, params: {thinking: {type: disabled}}}
      - {display: on, params: {thinking: {type: adaptive}, reasoning_split: true}}
`)
    expect(mt.resolveThinkingLevels('MiniMax-M3')).toEqual(['off', 'on'])
    expect(mt.resolveThinkingParams('MiniMax-M3', 'off')).toEqual({ thinking: { type: 'disabled' } })
    expect(mt.resolveThinkingParams('MiniMax-M3', 'on')).toEqual({
      thinking: { type: 'adaptive' },
      reasoning_split: true,
    })
  })

  it('非法条目整条/单档丢弃：旧版字符串数组、缺 display、params 非对象', async () => {
    const mt = await load(`
models:
  - aliases: [legacy-model]
    thinking: [off, on, high]
  - aliases: [bad-display]
    thinking:
      - {params: {reasoning_effort: high}}
      - {display: '  ', params: {}}
  - aliases: [bad-params]
    thinking:
      - {display: on, params: [1, 2]}
      - {display: ok, params: {a: 1}}
`)
    expect(mt.resolveThinkingLevels('legacy-model')).toEqual(['off', 'on'])
    expect(mt.resolveThinkingLevels('bad-display')).toEqual(['off', 'on'])
    expect(mt.resolveThinkingLevels('bad-params')).toEqual(['ok'])
    expect(mt.resolveThinkingParams('bad-params', 'ok')).toEqual({ a: 1 })
  })

  it('params 缺省 / null → 空片段（不发参）', async () => {
    const mt = await load(`
models:
  - aliases: [longcat]
    thinking:
      - {display: off}
      - {display: on, params: null}
`)
    expect(mt.resolveThinkingParams('longcat', 'off')).toBeUndefined()
    expect(mt.resolveThinkingParams('longcat', 'on')).toBeUndefined()
  })

  it('匹配顺序：精确 > 最长前缀 > 通配 > 兜底', async () => {
    const mt = await load(`
models:
  - aliases: ['*']
    thinking:
      - {display: off, params: {}}
      - {display: on, params: {}}
  - aliases: [glm]
    thinking:
      - {display: low, params: {reasoning_effort: low}}
  - aliases: [glm-5]
    thinking:
      - {display: high, params: {reasoning_effort: high}}
`)
    expect(mt.resolveThinkingLevels('glm-5.2')).toEqual(['high']) // 最长前缀 glm-5 胜出 glm
    expect(mt.resolveThinkingLevels('glm-4-plus')).toEqual(['low'])
    expect(mt.resolveThinkingLevels('unknown-model')).toEqual(['off', 'on']) // 通配兜底
  })

  it('resolveThinkingParams：空片段 / 未命中显示词 / 空模型 → undefined', async () => {
    const mt = await load(`
models:
  - aliases: [m1]
    thinking:
      - {display: off, params: {}}
      - {display: on, params: {thinking: {type: enabled}}}
`)
    expect(mt.resolveThinkingParams('m1', 'off')).toBeUndefined() // 空片段
    expect(mt.resolveThinkingParams('m1', 'high')).toBeUndefined() // 未命中显示词
    expect(mt.resolveThinkingParams('m1', undefined)).toBeUndefined() // 无显示词
    expect(mt.resolveThinkingParams('m1', 'on')).toEqual({ thinking: { type: 'enabled' } })
  })

  it('配置文件缺失 → 全量兜底 ["off","on"] 且不发参', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'chery-mt-'))
    tmpDirs.push(dir)
    process.env.CHERY_DIR = dir
    vi.resetModules()
    const mt = await import('@/utils/modelThinking.js')
    expect(mt.resolveThinkingLevels('any-model')).toEqual(['off', 'on'])
    expect(mt.resolveThinkingParams('any-model', 'on')).toBeUndefined()
  })

  it('YAML 解析失败 → 空配置兜底（不抛错）', async () => {
    const mt = await load('{{{{ not yaml')
    expect(mt.resolveThinkingLevels('any-model')).toEqual(['off', 'on'])
    expect(mt.loadModelThinking().entries).toEqual([])
  })

  it('resolveThinkingLevelsBatch：去空串、逐 model 查询', async () => {
    const mt = await load(`
models:
  - aliases: [glm]
    thinking:
      - {display: low, params: {reasoning_effort: low}}
`)
    expect(mt.resolveThinkingLevelsBatch(['glm-5', '', 'other'])).toEqual({
      'glm-5': ['low'],
      other: ['off', 'on'],
    })
  })
})
