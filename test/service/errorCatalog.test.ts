import { describe, expect, it } from 'vitest'
import { ErrorId } from '@chery/protocol'
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

  it.each([
    [
      ErrorId.BRAIN_CONFIG_MODEL_MISSING,
      '当前 AI 服务没有配置模型。',
      '请在设置中为当前 AI 服务选择模型后，再重新发送。',
    ],
    [
      ErrorId.BRAIN_CONFIG_URL_MISSING,
      '当前 AI 服务没有配置服务地址。',
      '请在设置中填写服务地址后，再重新发送。',
    ],
    [
      ErrorId.BRAIN_CONFIG_KEY_MISSING,
      '当前 AI 服务没有配置密钥。',
      '请在设置中填写密钥或环境变量后，再重新发送。',
    ],
    [
      ErrorId.BRAIN_CONFIG_KEY_ENV_UNRESOLVED,
      '密钥引用的环境变量尚未配置。',
      '请配置对应环境变量，或在设置中改用可用密钥后重新发送。',
    ],
  ])('错误 ID %s → 查询具体配置响应', (errorId, description, guidance) => {
    const result = runFailureFeedback({
      errorId,
      category: 'validation',
      source: 'brain',
      description: '不应暴露的核心异常文本',
      tracingId: 'test-trace',
      canResume: true,
    })

    expect(result).toMatchObject({
      reasonCode: 'RUN_VALIDATION_FAILED',
      feedback: {
        code: errorId,
        title: 'AI 服务配置不完整',
        description,
        guidance,
        actions: expect.arrayContaining([{ type: 'open_settings', section: 'provider' }]),
      },
    })
  })
})
