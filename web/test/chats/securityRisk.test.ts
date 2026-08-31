import { describe, expect, it } from 'vitest'
import { riskLevelOf } from '@/domain/chat/securityRisk'

describe('工具调用风险等级', () => {
  it('未提供判定时标为未知，而不是误标为安全', () => {
    expect(riskLevelOf(undefined)).toBe('unknown')
    expect(riskLevelOf(null)).toBe('unknown')
  })

  it('每次调用按自己的 findings 独立判定', () => {
    expect(riskLevelOf({ findings: [] })).toBe('safe')
    expect(riskLevelOf({ findings: [{ severity: 'medium' }] })).toBe('medium')
    expect(riskLevelOf({ findings: [{ severity: 'high' }] })).toBe('high')
    expect(
      riskLevelOf({ findings: [{ severity: 'high' }, { severity: 'unknown' }] }),
    ).toBe('unknown')
  })
})
