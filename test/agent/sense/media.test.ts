/**
 * media sense 单元测试。
 *
 * 覆盖：
 * - 三个 sense 定义：generate_image / generate_video / generate_audio
 * - supervision = smart
 * - handler：mock callMediaService + saveMediaAsset
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import mediaSenses from '@/agent/sense/media.js'
import { SupervisionLevel } from '@/core/config.js'

const mediaMocks = vi.hoisted(() => ({
  callMediaService: vi.fn(),
  saveMediaAsset: vi.fn(),
}))

vi.mock('@/service/media/index.js', () => mediaMocks)

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

  it('supervision = smart', () => {
    for (const s of mediaSenses) {
      expect(s.supervisionLevel).toBe(SupervisionLevel.smart)
    }
  })
})

describe('media sense handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each([
    ['image', 0, 'a cat', 'image/png', 'test-img.png'],
    ['video', 1, 'a movie', 'video/mp4', 'test-video.mp4'],
    ['audio', 2, 'a song', 'audio/mpeg', 'test-audio.mp3'],
  ] as const)('generate_%s mock 调用', async (kind, index, prompt, mimeType, filename) => {
    mediaMocks.callMediaService.mockResolvedValueOnce({
      assets: [{ data: 'aGVsbG8=', mimeType, filename }],
    })
    mediaMocks.saveMediaAsset.mockResolvedValueOnce({ filename })

    const exec = mediaSenses[index]!.executor.execute.bind(mediaSenses[index]!.executor)
    const result = await exec({ prompt }, new Map())

    expect(mediaMocks.callMediaService).toHaveBeenCalledWith(kind, 'generate', { prompt })
    expect(mediaMocks.saveMediaAsset).toHaveBeenCalledWith(expect.any(Uint8Array), mimeType, filename)
    expect(result.content).toBe(`/api/media/${filename}`)
  })
})
