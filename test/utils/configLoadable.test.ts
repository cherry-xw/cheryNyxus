/**
 * 配置可加载性预检 单测：validateLoadable（重启前 dry-run，防坏配置 crash-loop 永不恢复）。
 * 契约见 docs/agent/config-manage.md「重启前预检（dry-run）」。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

  it('正常配置 → ok', () => {
    expect(validateLoadable(validRaw())).toEqual({ ok: true })
  })

  it('llm.brain 为空 → errors（loadConfig 阶段会 throw）', () => {
    const raw = { global: { supervision: 'smart' }, llm: { brain: {} } } as unknown as ConfigRaw
    const result = validateLoadable(raw)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join('\n')).toMatch(/llm\.brain/)
  })

  it('$ENV 占位符指向缺失变量 → errors（硬错误）', () => {
    const raw = validRaw()
    if (raw.llm?.brain?.['brain-a']) raw.llm.brain['brain-a'].key = `$${ENV_NAME}`
    const result = validateLoadable(raw)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join('\n')).toContain(`环境变量未配置: ${ENV_NAME}`)
  })

  it('$ENV 占位符已配置 → ok', () => {
    process.env[ENV_NAME] = 'sk-test'
    const raw = validRaw()
    if (raw.llm?.brain?.['brain-a']) raw.llm.brain['brain-a'].key = `$${ENV_NAME}`
    expect(validateLoadable(raw)).toEqual({ ok: true })
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
    expect(validateLoadable(raw)).toEqual({ ok: true })
  })
})
