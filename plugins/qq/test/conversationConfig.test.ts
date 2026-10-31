import { describe, expect, it } from 'vitest'
import { QQConfigSchema, QQDefaultConfig, resolveConversationPolicy } from '@chery/protocol'
import { convertQQConfiguration } from '../src/configConversion.js'

describe('QQ conversation configuration', () => {
  it('inherits each field and distinguishes empty style from missing', () => {
    const config = QQConfigSchema.parse({ ...QQDefaultConfig, groups: ['2'], conversation: { ...QQDefaultConfig.conversation,
      defaults: { ...QQDefaultConfig.conversation.defaults, customStyle: '默认补充' }, groups: { '2': { mode: 'proactive', customStyle: '' } } } })
    expect(resolveConversationPolicy(config, 'group:2')).toMatchObject({ effective: { mode: 'proactive', style: 'casual', customStyle: '' }, origins: { mode: 'group', style: 'default' } })
    expect(resolveConversationPolicy(config, 'private:user:3').effective.mode).toBe('followup')
  })
  it('rejects null, unrelated groups and invalid waits', () => {
    for (const conversation of [{ ...QQDefaultConfig.conversation, groups: { '2': { mode: null } } },
      { ...QQDefaultConfig.conversation, groups: { '2': { mode: 'proactive' } } },
      { ...QQDefaultConfig.conversation, proactive: { ...QQDefaultConfig.conversation.proactive, batchWaitMs: 5000, minCheckIntervalMs: 1000 } }])
      expect(QQConfigSchema.safeParse({ ...QQDefaultConfig, conversation }).success).toBe(false)
  })
  it('converts once without accepting legacy config in the runtime', () => {
    const { schemaVersion, backgroundMessageLimit, managementHistoryLimit, ...rest } = QQDefaultConfig
    const old = { ...rest, historyLimit: 37, continuationMaxMessages: 5 }
    expect(QQConfigSchema.safeParse(old).success).toBe(false)
    const converted = convertQQConfiguration(old)
    expect(converted.config.backgroundMessageLimit).toBe(37)
    expect(converted.config.managementHistoryLimit).toBe(37)
    expect(convertQQConfiguration(converted.config).changes).toEqual([])
  })
})
