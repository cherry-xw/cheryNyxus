/**
 * envGuard 敏感值遮蔽单测：redactSensitiveValues（纯函数，无 IO）。
 *
 * 契约（docs/utils/README.md「envGuard.ts — 环境变量敏感值脱敏」）：
 *  - key 名保留、值替换为 [REDACTED]（行内 KEY=value + 裸值子串两段式）
 *  - 敏感 key 按 /KEY|SECRET|TOKEN|PASSWORD|AUTH/i 匹配；非敏感 key 名与值完全不动
 *  - 裸值仅值长 ≥ MIN_BARE_VALUE_LENGTH（8）时替换，避免短值误伤
 * 纯函数测试（无 IO），不需要临时 CHERY_DIR。
 */
import { describe, it, expect } from 'vitest'
import { redactSensitiveValues, MIN_BARE_VALUE_LENGTH } from '@/utils/envGuard.js'

const PH = '[REDACTED]'

describe('redactSensitiveValues 行内 KEY=value 替换', () => {
  it('行内 API_KEY=value → key 名保留、值替换', () => {
    const out = redactSensitiveValues('API_KEY=sk-12345678', { API_KEY: 'sk-12345678' })
    expect(out).toBe(`API_KEY=${PH}`)
  })

  it('带引号 TOKEN="value" → TOKEN=[REDACTED]', () => {
    const out = redactSensitiveValues('TOKEN="abc-1234567890"', { TOKEN: 'abc-1234567890' })
    expect(out).toBe(`TOKEN=${PH}`)
  })

  it('短值行内仍替换（裸值限制只影响裸值 pass）', () => {
    const out = redactSensitiveValues('KEY=abc1234', { KEY: 'abc1234' })
    expect(out).toBe(`KEY=${PH}`)
  })

  it('CRLF 行内替换保留换行', () => {
    const out = redactSensitiveValues('API_KEY=sk-12345678\r\nNEXT=x', { API_KEY: 'sk-12345678' })
    expect(out).toBe(`API_KEY=${PH}\r\nNEXT=x`)
  })

  it('词边界：MY_API_KEY 不被 API_KEY 命中', () => {
    const out = redactSensitiveValues('MY_API_KEY=keep', { API_KEY: 'keep' })
    expect(out).toBe('MY_API_KEY=keep')
  })
})

describe('redactSensitiveValues 裸值子串替换', () => {
  it('值长 ≥ 8 的裸值在散文中被替换', () => {
    const out = redactSensitiveValues('请使用密钥 sk-12345678 登录', { API_KEY: 'sk-12345678' })
    expect(out).toBe(`请使用密钥 ${PH} 登录`)
  })

  it('恰好 8 字符裸值替换（边界）', () => {
    const out = redactSensitiveValues('abc12345 其他', { KEY: 'abc12345' })
    expect(out).toBe(`${PH} 其他`)
  })

  it('7 字符裸值不替换', () => {
    const out = redactSensitiveValues('abc1234 保留', { KEY: 'abc1234' })
    expect(out).toBe('abc1234 保留')
  })

  it('值含正则特殊字符可安全替换', () => {
    const out = redactSensitiveValues('前缀 sk-12345+abc@x 后缀', { KEY: 'sk-12345+abc@x' })
    expect(out).toBe(`前缀 ${PH} 后缀`)
  })

  it('两值一为另一子串时长值优先，不产生错位二次替换', () => {
    const out = redactSensitiveValues('abcdefghij 与 cdefghij', {
      A_KEY: 'abcdefghij',
      B_KEY: 'cdefghij',
    })
    expect(out).toBe(`${PH} 与 ${PH}`)
  })
})

describe('敏感 key 判定', () => {
  it('大小写不敏感：DB_PASSWORD / jwt_secret / AUTH_TOKEN / access_key', () => {
    const envMap = {
      DB_PASSWORD: 'pw-12345678',
      jwt_secret: 'sec-12345678',
      AUTH_TOKEN: 'tok-12345678',
      access_key: 'ak-12345678',
    }
    const out = redactSensitiveValues(
      'DB_PASSWORD=pw-12345678\njwt_secret=sec-12345678\nAUTH_TOKEN=tok-12345678\naccess_key=ak-12345678',
      envMap,
    )
    expect(out).toBe(
      `DB_PASSWORD=${PH}\njwt_secret=${PH}\nAUTH_TOKEN=${PH}\naccess_key=${PH}`,
    )
  })

  it('同行多 key 时整行被行内替换合并（[^\\r\\n]* 匹配到行尾，安全方向）', () => {
    const out = redactSensitiveValues('A_KEY=a1b2c3d4 B_KEY=b2c3d4e5 非敏感字段', {
      A_KEY: 'a1b2c3d4',
      B_KEY: 'b2c3d4e5',
    })
    expect(out).toBe(`A_KEY=${PH}`)
  })

  it('非敏感 key（NODE_ENV）名与值完全不动（行为变化回归锚点）', () => {
    const out = redactSensitiveValues('NODE_ENV=production', { NODE_ENV: 'production' })
    expect(out).toBe('NODE_ENV=production')
  })
})

describe('边界与防护', () => {
  it('空 envMap → 原样返回', () => {
    const out = redactSensitiveValues('API_KEY=sk-12345678', {})
    expect(out).toBe('API_KEY=sk-12345678')
  })

  it('值等于占位符时跳过（不二次替换）', () => {
    const out = redactSensitiveValues('API_KEY=[REDACTED]', { API_KEY: '[REDACTED]' })
    expect(out).toBe(`API_KEY=${PH}`)
  })

  it('值为占位符子串（REDACTED）时跳过，避免破坏占位符', () => {
    const out = redactSensitiveValues('前缀 [REDACTED] 后缀', { KEY: 'REDACTED' })
    expect(out).toBe(`前缀 ${PH} 后缀`)
  })

  it('MIN_BARE_VALUE_LENGTH 导出为 8', () => {
    expect(MIN_BARE_VALUE_LENGTH).toBe(8)
  })
})

describe('混合场景', () => {
  it('行内 + 裸值 + 非敏感 key 共存', () => {
    const envMap = { API_KEY: 'sk-12345678', NODE_ENV: 'production' }
    const content = 'API_KEY=sk-12345678\n使用 sk-12345678 访问\nNODE_ENV=production'
    const out = redactSensitiveValues(content, envMap)
    expect(out).toBe(`API_KEY=${PH}\n使用 ${PH} 访问\nNODE_ENV=production`)
  })
})
