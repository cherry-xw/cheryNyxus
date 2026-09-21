/**
 * config.yaml 中 manager 段（本地管理器监听配置）的读写行为：
 * - validateRawConfig 校验 manager.host 类型；
 * - readRawConfig 剥离 manager（设置面板不可见）；
 * - saveRawConfig 从磁盘原样保留 manager（设置保存不丢）。
 *
 * 用临时 CHERY_DIR 隔离，避免污染真实 .chery/。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import yaml from 'js-yaml'
import { readRawConfig, saveRawConfig, validateRawConfig, type ConfigRaw } from '@/utils/config.js'

let tempCheryDir: string

beforeEach(() => {
  tempCheryDir = mkdtempSync(join(tmpdir(), 'cheryNyxus-config-manager-test-'))
  process.env.CHERY_DIR = tempCheryDir
})

afterEach(() => {
  rmSync(tempCheryDir, { recursive: true, force: true })
  delete process.env.CHERY_DIR
})

function setupConfigYaml(content: string): void {
  const cheryDir = join(tempCheryDir, '.chery')
  mkdirSync(cheryDir, { recursive: true })
  writeFileSync(join(cheryDir, 'config.yaml'), content)
}

function loadRaw(): ConfigRaw {
  return yaml.load(readFileSync(join(tempCheryDir, '.chery', 'config.yaml'), 'utf8')) as ConfigRaw
}

function candidateWithoutManager(): ConfigRaw {
  return {
    global: { supervision: 'smart' },
    llm: { brain: { 'brain-a': { provider: 'mock', model: 'mock_test' } } },
  }
}

const minimalWithManager = `global:
  supervision: smart
llm:
  brain:
    brain-a:
      provider: mock
      model: mock_test
manager:
  host: 0.0.0.0
`

describe('config manager 段', () => {
  it('validateRawConfig 接受合法 manager.host', () => {
    setupConfigYaml(minimalWithManager)
    expect(validateRawConfig(loadRaw())).toEqual([])
  })

  it('validateRawConfig 拒绝非字符串 manager.host', () => {
    setupConfigYaml(`global:
  supervision: smart
llm:
  brain:
    brain-a:
      provider: mock
      model: mock_test
manager:
  host: 123
`)
    const errors = validateRawConfig(loadRaw())
    expect(errors.join('\n')).toContain('manager.host 必须是字符串')
  })

  it('readRawConfig 剥离 manager 段（设置面板不可见）', () => {
    setupConfigYaml(minimalWithManager)
    expect('manager' in readRawConfig()).toBe(false)
  })

  it('saveRawConfig 从磁盘原样保留 manager 段', () => {
    setupConfigYaml(minimalWithManager)
    // 前端候选不含 manager（config.get 已剥离），保存后磁盘 manager 段必须仍在。
    const result = saveRawConfig(candidateWithoutManager())
    expect(result).toEqual({ ok: true })
    const written = readFileSync(join(tempCheryDir, '.chery', 'config.yaml'), 'utf8')
    expect(written).toContain('manager:')
    expect(written).toContain('host: 0.0.0.0')
  })
})
