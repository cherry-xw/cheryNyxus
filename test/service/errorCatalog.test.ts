import { describe, expect, it } from 'vitest'
import { runFailureFeedback } from '@/service/errorCatalog.js'

describe('runFailureFeedback', () => {
  it('大脑配置校验错误 → 直接引导用户进入服务设置', () => {
    const result = runFailureFeedback({
      category: 'validation',
      source: 'brain',
      description: 'AI 服务密钥 环境变量占位符格式错误：仅支持 $API_KEY 这类全大写格式。',
      tracingId: 'test-trace',
      canResume: true,
    })

    expect(result).toMatchObject({
      reasonCode: 'RUN_VALIDATION_FAILED',
      feedback: {
        title: 'AI 服务配置有误',
        guidance: '请在设置中修正模型地址、模型或密钥配置后，再继续运行。',
        actions: expect.arrayContaining([{ type: 'open_settings', section: 'provider' }]),
      },
    })
  })
})
