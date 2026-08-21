/**
 * config_manage 敏感字段脱敏/还原 单测：redactConfigSecrets / restoreRedactedSecrets。
 *
 * 契约见 docs/agent/config-manage.md「敏感字段脱敏」：
 *  - $ENV 占位符原样保留；明文 key → [REDACTED]；mcp env 值同理；mcp url 内联凭证段脱敏。
 *  - save 侧把 [REDACTED] 还原为盘上原值；新明文 / $ENV 直通。
 * 纯函数测试（无 IO），不需要临时 CHERY_DIR。
 */
import { describe, it, expect } from 'vitest'
import { redactConfigSecrets, restoreRedactedSecrets } from '@/utils/config.js'
import type { ConfigRaw } from '@/utils/config.js'

/** 含各敏感字段的完整样例配置（$ENV 占位符 + 明文密钥混合）。 */
function makeRaw(): ConfigRaw {
  return {
    global: { supervision: 'smart' },
    llm: {
      brain: {
        'brain-a': { provider: 'openai', model: 'gpt-4o', key: '$OPENAI_KEY' },
        'brain-b': { provider: 'mock', model: 'mock_test', key: 'sk-literal-secret-123' },
      },
    },
    media: {
      image: { type: 'image', url: 'https://api.example.com/v1', key: 'media-literal-secret' },
    },
    mcp_servers: {
      fs: {
        transport: 'stdio',
        command: 'npx',
        env: { TOKEN: '$MCP_TOKEN', OTHER: 'plain-secret' },
      },
      http: { transport: 'streamable-http', url: 'https://user:pass@example.com/mcp' },
    },
  }
}

describe('redactConfigSecrets 脱敏', () => {
  it('$ENV 占位符 key 原样保留', () => {
    const redacted = redactConfigSecrets(makeRaw())
    expect(redacted.llm?.brain?.['brain-a']?.key).toBe('$OPENAI_KEY')
  })

  it('明文 llm.brain.*.key → [REDACTED]', () => {
    const redacted = redactConfigSecrets(makeRaw())
    expect(redacted.llm?.brain?.['brain-b']?.key).toBe('[REDACTED]')
  })

  it('明文 media.*.key → [REDACTED]；media.url 公开地址保留', () => {
    const redacted = redactConfigSecrets(makeRaw())
    expect(redacted.media?.image?.key).toBe('[REDACTED]')
    expect(redacted.media?.image?.url).toBe('https://api.example.com/v1')
  })

  it('mcp_servers.*.env 值：$ENV 保留、明文 → [REDACTED]', () => {
    const redacted = redactConfigSecrets(makeRaw())
    expect(redacted.mcp_servers?.fs?.env).toEqual({ TOKEN: '$MCP_TOKEN', OTHER: '[REDACTED]' })
  })

  it('mcp_servers.*.url 内联凭证段 → [REDACTED]（其余保留）', () => {
    const redacted = redactConfigSecrets(makeRaw())
    expect(redacted.mcp_servers?.http?.url).toBe('https://[REDACTED]@example.com/mcp')
  })

  it('无内联凭证的 mcp url 原样保留', () => {
    const raw = makeRaw()
    if (raw.mcp_servers && raw.mcp_servers.http)
      raw.mcp_servers.http.url = 'https://example.com/mcp'
    const redacted = redactConfigSecrets(raw)
    expect(redacted.mcp_servers?.http?.url).toBe('https://example.com/mcp')
  })

  it('深拷贝返回，不改入参', () => {
    const raw = makeRaw()
    const redacted = redactConfigSecrets(raw)
    expect(raw.llm?.brain?.['brain-b']?.key).toBe('sk-literal-secret-123') // 入参未变
    expect(redacted).not.toBe(raw)
    expect(redacted.llm?.brain?.['brain-b']?.key).toBe('[REDACTED]')
  })
})

describe('restoreRedactedSecrets 还原', () => {
  const disk = makeRaw() // 盘上原值（含真实明文 key）

  it('[REDACTED] key → 盘上原值（llm / media / mcp env / mcp url）', () => {
    const partial = redactConfigSecrets(makeRaw())
    const restored = restoreRedactedSecrets(partial, disk)
    expect(restored.llm?.brain?.['brain-b']?.key).toBe('sk-literal-secret-123')
    expect(restored.media?.image?.key).toBe('media-literal-secret')
    expect(restored.mcp_servers?.fs?.env?.OTHER).toBe('plain-secret')
    expect(restored.mcp_servers?.http?.url).toBe('https://user:pass@example.com/mcp')
  })

  it('显式新明文（非 [REDACTED]）以新值为准（允许换 key）', () => {
    const partial = redactConfigSecrets(makeRaw())
    if (partial.llm?.brain?.['brain-b']) partial.llm.brain['brain-b'].key = 'sk-new-secret'
    const restored = restoreRedactedSecrets(partial, disk)
    expect(restored.llm?.brain?.['brain-b']?.key).toBe('sk-new-secret')
  })

  it('$ENV 占位符直通（不还原也不改写）', () => {
    const partial = redactConfigSecrets(makeRaw())
    const restored = restoreRedactedSecrets(partial, disk)
    expect(restored.llm?.brain?.['brain-a']?.key).toBe('$OPENAI_KEY')
  })

  it('盘上无对应字段时 [REDACTED] 保留原样（不伪造值）', () => {
    const partial = redactConfigSecrets(makeRaw())
    if (partial.llm?.brain) partial.llm.brain['brain-new'] = { provider: 'mock', model: 'm', key: '[REDACTED]' }
    const restored = restoreRedactedSecrets(partial, disk)
    expect(restored.llm?.brain?.['brain-new']?.key).toBe('[REDACTED]')
  })

  it('深拷贝返回，不改入参', () => {
    const partial = redactConfigSecrets(makeRaw())
    const restored = restoreRedactedSecrets(partial, disk)
    expect(partial.llm?.brain?.['brain-b']?.key).toBe('[REDACTED]') // 入参未变
    expect(restored).not.toBe(partial)
    expect(restored.llm?.brain?.['brain-b']?.key).toBe('sk-literal-secret-123')
  })
})
