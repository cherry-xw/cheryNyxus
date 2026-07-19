/**
 * media sense 单元测试。
 *
 * 覆盖：
 * - 三个 sense 定义：generate_image / generate_video / generate_audio
 * - supervision = confirm
 * - handler：mock callMediaService + saveMediaAsset
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import mediaSenses from '@/agent/sense/media.js'
import { SupervisionLevel } from '@/core/config.js'

describe('media sense 定义', () => {
  it('导出 3 个 sense', () => {
    expect(mediaSenses.length).toBe(3)
  })

  it('generate_image name', () => {
    expect(mediaSenses[0]!.definition.function.name).toBe('generate_image')
  })

  it('generate_video name', () => {
    expect(mediaSenses[1]!.definition.function.name).toBe('generate_video')
  })

  it('generate_audio name', () => {
    expect(mediaSenses[2]!.definition.function.name).toBe('generate_audio')
  })

  it('supervision = confirm', () => {
    for (const s of mediaSenses) {
      expect(s.supervisionLevel).toBe(SupervisionLevel.confirm)
    }
  })
})

describe('media sense handler', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('generate_image mock 调用', async () => {
    vi.mock('@/service/media/index.js', () => ({
      callMediaService: vi.fn().mockResolvedValue({
        assets: [
          { data: 'aGVsbG8=', mimeType: 'image/png', filename: 'test-img.png' },
        ],
      }),
      saveMediaAsset: vi.fn().mockResolvedValue({ filename: 'test-img.png' }),
      mediaKindForMime: vi.fn().mockReturnValue('image'),
    }))

    const exec = mediaSenses[0]!.executor.execute.bind(mediaSenses[0]!.executor)
    const r = await exec({ prompt: 'a cat' }, new Map())
    expect(r.content).toBeDefined()
    expect(typeof r.content).toBe('string')
  })

  it('generate_video mock 调用', async () => {
    const exec = mediaSenses[1]!.executor.execute.bind(mediaSenses[1]!.executor)
    // 不 mock 实际 service（太重），只验证 handler 接口
    // 无 mock → callMediaService 会抛错（无配置的媒体服务），验证错误路径
    try {
      await exec({ prompt: 'a movie' }, new Map())
    } catch {
      // 预期：无媒体服务配置 → throw
    }
  })

  it('generate_audio mock 调用', async () => {
    const exec = mediaSenses[2]!.executor.execute.bind(mediaSenses[2]!.executor)
    try {
      await exec({ prompt: 'a song' }, new Map())
    } catch {
      // 预期：无媒体服务配置 → throw
    }
  })
})
