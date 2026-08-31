/**
 * 配置可加载性预检 单测：validateLoadable（重启前 dry-run，防坏配置 crash-loop 永不恢复）。
 * 契约见 docs/agent/config-manage.md「重启前预检（dry-run）」。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import yaml from 'js-yaml'
import { validateLoadable } from '@/utils/config.js'
import type { ConfigRaw } from '@/utils/config.js'

let tempDir: string
const ENV_NAME = 'CHERY_CLAW_TEST_ENV'

function validRaw(): ConfigRaw {
  return {
    global: { supervision: 'smart' },
    llm: { brain: { 'brain-a': { provider: 'mock', model: 'mock_test' } } },
  }
}

describe('validateLoadable 重启前预检', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cheryNyxus-validate-loadable-'))
    process.env.CHERY_DIR = tempDir
    delete process.env[ENV_NAME]
  })
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    delete process.env.CHERY_DIR
  })

  it('正常配置 → ok（无软告警）', () => {
    expect(validateLoadable(validRaw())).toEqual({ ok: true, warnings: [] })
  })

  it('发行模板只缺真实大脑参数时仍可启动', () => {
    cpSync('.chery.template', join(tempDir, '.chery'), { recursive: true })
    const raw = yaml.load(readFileSync(join(tempDir, '.chery', 'config.yaml'), 'utf8')) as ConfigRaw
    const previousKey = process.env.LLM_API_KEY
    delete process.env.LLM_API_KEY
    try {
      const result = validateLoadable(raw)
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.warnings).toContain('环境变量未配置: LLM_API_KEY')
    } finally {
      if (previousKey === undefined) delete process.env.LLM_API_KEY
      else process.env.LLM_API_KEY = previousKey
    }
  })

  it('llm.brain 为空 → errors（loadConfig 阶段会 throw）', () => {
    const raw = { global: { supervision: 'smart' }, llm: { brain: {} } } as unknown as ConfigRaw
    const result = validateLoadable(raw)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join('\n')).toMatch(/llm\.brain/)
  })

  it('$ENV 占位符指向缺失变量 → 软警告，不阻塞（ok）', () => {
    const raw = validRaw()
    if (raw.llm?.brain?.['brain-a']) raw.llm.brain['brain-a'].key = `$${ENV_NAME}`
    const result = validateLoadable(raw)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.warnings).toContain(`环境变量未配置: ${ENV_NAME}`)
    }
  })

  it('$ENV 占位符已配置 → ok（无软告警）', () => {
    process.env[ENV_NAME] = 'sk-test'
    const raw = validRaw()
    if (raw.llm?.brain?.['brain-a']) raw.llm.brain['brain-a'].key = `$${ENV_NAME}`
    expect(validateLoadable(raw)).toEqual({ ok: true, warnings: [] })
  })

  it('密钥占位符含小写字母 → 配置错误，并说明正确格式', () => {
    const raw = validRaw()
    if (raw.llm?.brain?.['brain-a']) raw.llm.brain['brain-a'].key = '$APq_KEY'
    const result = validateLoadable(raw)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.join('\n')).toContain('llm.brain.brain-a.key 环境变量占位符格式错误')
      expect(result.errors.join('\n')).toContain('$API_KEY')
    }
  })

  it('roles.*.systemPrompt 指向不存在文件 → errors（validateRawConfig 硬错误，loadConfig 会 throw）', () => {
    const raw = validRaw()
    raw.roles = { r1: { id: 'role-test1234', brain: 'brain-a', systemPrompt: 'prompt/missing.md' } }
    const result = validateLoadable(raw)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join('\n')).toMatch(/roles\.r1\.systemPrompt 文件不存在/)
  })

  it('roles.*.systemPrompt 文件存在 → ok', () => {
    const dir = join(tempDir, '.chery', 'prompt')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'exists.md'), '# p')
    const raw = validRaw()
    raw.roles = { r1: { id: 'role-test1234', brain: 'brain-a', systemPrompt: 'prompt/exists.md' } }
    expect(validateLoadable(raw)).toEqual({ ok: true, warnings: [] })
  })
})
