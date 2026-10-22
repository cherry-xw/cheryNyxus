/**
 * 配置可加载性预检 单测：validateLoadable（重启前 dry-run，防坏配置 crash-loop 永不恢复）。
 * 契约见 docs/backend/agent/config-manage.md「重启前预检（dry-run）」。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import yaml from 'js-yaml'
import { validateLoadable, validateRawConfig } from '@/utils/config.js'
import type { ConfigRaw } from '@/utils/config.js'

let tempDir: string
const ENV_NAME = 'CHERY_NYXUS_TEST_ENV'

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
    cpSync('apps/backend/.chery.template', join(tempDir, '.chery'), { recursive: true })
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

  it('破坏性移除：拒绝旧 capabilities.generate 字段', () => {
    const raw = validRaw()
    ;(raw.llm.brain['brain-a'] as unknown as Record<string, unknown>).capabilities = {
      toolCall: true,
      generate: { image: true },
    }
    const result = validateLoadable(raw)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.join('\n')).toContain('capabilities.generate 已移除')
    }
  })

  it('支持三态 capabilities.input/output、file_services、fileCapabilities、roleOverrides 与 files 全局策略', () => {
    const raw = validRaw()
    raw.llm.brain['brain-a']!.capabilities = {
      toolCall: true,
      input: { image: 'supported', pdf: 'supported', video: 'unsupported', audio: 'unknown' },
      output: { image: 'supported' },
    }
    raw.file_services = {
      'gemini-img': {
        name: 'Gemini 生图',
        enabled: true,
        adapter: 'google-gemini-image',
        connection: { brainRef: 'brain-a', model: 'gemini-3-pro-image' },
        operations: ['image.generate', 'image.edit'],
        timeoutMs: 60000,
        maxConcurrent: 2,
      },
    }
    raw.sense_groups = { default: ['read_file', 'file_gemini_img_image_generate'] }
    raw.roles = {
      leader: {
        id: 'role-leader123',
        brain: 'brain-a',
        senseGroup: 'default',
        fileCapabilities: {
          'image.generate': { mode: 'tool', targetId: 'file_gemini_img_image_generate' },
          'image.inspect': { mode: 'native' },
        },
      },
      designer: {
        id: 'role-design123',
        brain: 'brain-a',
        senseGroup: 'default',
        scope: 'public',
      },
    }
    raw.presets = {
      p1: {
        id: 'preset-p1234567',
        leader: 'leader',
        roles: ['leader', 'designer'],
        roleOverrides: {
          designer: {
            fileCapabilities: {
              'image.generate': { mode: 'disabled', fallback: 'none' },
            },
          },
        },
      },
    }
    raw.files = {
      maxUploadBytes: 104857600,
      context: {
        recentUserTurns: 3,
        maxAssets: 10,
        maxBinaryBytes: 16777216,
        maxExtractedCharsPerAsset: 20000,
        maxExtractedChars: 80000,
        defaultImageVariant: 'adapted',
      },
      imageAdaptation: { maxEdge: 2048, quality: 85 },
      unreferencedUploadRetentionHours: 24,
      unreferencedAssetRetentionHours: 24,
    }
    expect(validateLoadable(raw)).toEqual({ ok: true, warnings: [] })
  })

  it('file_services 互斥与适配器操作范围校验', () => {
    const raw = validRaw()
    raw.file_services = {
      bad: {
        name: '冲突连接',
        adapter: 'google-imagen',
        connection: {
          brainRef: 'brain-a',
          baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
          keyRef: '$GEMINI_API_KEY',
        },
        operations: ['image.edit'],
      },
    }
    const result = validateLoadable(raw)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      const joined = result.errors.join('\n')
      expect(joined).toContain('brainRef 与独立 baseUrl/keyRef 互斥')
      expect(joined).toContain('不被适配器 "google-imagen" 支持')
    }
  })

  it('无 toolCall 角色仅允许通过前置理解工具绑定 senseGroup，拒绝生成工具或 role 委派', () => {
    const raw = validRaw()
    raw.llm.brain['brain-no-tool'] = {
      provider: 'mock',
      model: 'mock_test',
      capabilities: { toolCall: false },
    }
    raw.sense_groups = {
      preprocess_only: ['file_vision_svc_image_inspect'],
    }
    raw.roles = {
      r_ok: {
        id: 'role-ok123456',
        brain: 'brain-no-tool',
        senseGroup: 'preprocess_only',
        fileCapabilities: {
          'image.inspect': { mode: 'tool', targetId: 'file_vision_svc_image_inspect' },
        },
      },
    }
    expect(validateLoadable(raw)).toEqual({ ok: true, warnings: [] })

    raw.roles.r_ok!.fileCapabilities = {
      'image.generate': { mode: 'role', targetId: 'other' },
    }
    const bad = validateLoadable(raw)
    expect(bad.ok).toBe(false)
    if (!bad.ok) {
      expect(bad.errors.join('\n')).toContain('无 Tool Call 的角色不能使用 role 委派模式')
    }
  })

  it('完整候选校验要求 contextLimit 与所选分支环境引用可解析，且校验 schedule.cron 语法', () => {
    const raw: ConfigRaw = {
      global: { thinking: true, supervision: 'smart', stream: true },
      llm: {
        brain: {
          'brain-a': {
            provider: 'openai',
            protocol: 'openai-chat-completions',
            model: 'gpt-5',
            key: `$${ENV_NAME}`,
          },
        },
      },
      roles: {
        leader: { id: 'role-leader123', brain: 'brain-a', senseGroup: 'default' },
      },
      sense_groups: { default: ['read_file'] },
      presets: {
        p1: {
          id: 'preset-p1234567',
          leader: 'leader',
          roles: ['leader'],
          schedule: { cron: 'not a cron', task: 'run' },
        },
      },
    }
    const errors = validateRawConfig(raw, {}, true)
    expect(errors.join('\n')).toContain('llm.brain.brain-a.contextLimit')
    expect(errors.join('\n')).toContain('llm.brain.brain-a.key 请填写密钥或配置引用的环境变量')
    expect(errors.join('\n')).toContain('presets.p1.schedule.cron 表达式非法')

    raw.llm.brain['brain-a']!.contextLimit = 128000
    raw.presets!.p1!.schedule!.cron = '0 3 * * *'
    expect(validateRawConfig(raw, { [ENV_NAME]: 'sk-live' }, true)).toEqual([])
  })
})
