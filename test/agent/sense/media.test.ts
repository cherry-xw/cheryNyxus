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
  resolveMediaAsset: vi.fn(),
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

describe('media sense 图生图参考图透传', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('提供 reference（/api/media/<file>）时解析资产并透传给 callMediaService', async () => {
    mediaMocks.resolveMediaAsset.mockResolvedValueOnce({
      id: 'ref-1',
      kind: 'image',
      mimeType: 'image/png',
      filename: 'aaa.png',
      path: '/tmp/aaa.png',
      size: 10,
    })
    mediaMocks.callMediaService.mockResolvedValueOnce({
      assets: [{ data: 'aGVsbG8=', mimeType: 'image/png', filename: 'gen.png' }],
    })
    mediaMocks.saveMediaAsset.mockResolvedValueOnce({ filename: 'gen.png' })

    const exec = mediaSenses[0]!.executor.execute.bind(mediaSenses[0]!.executor)
    const result = await exec({ prompt: '再画一张', reference: '/api/media/aaa.png' }, new Map())

    expect(mediaMocks.resolveMediaAsset).toHaveBeenCalledWith('aaa.png')
    expect(mediaMocks.callMediaService).toHaveBeenCalledWith('image', 'generate', {
      prompt: '再画一张',
      assets: [
        {
          id: 'ref-1',
          kind: 'image',
          mimeType: 'image/png',
          filename: 'aaa.png',
          path: '/tmp/aaa.png',
          size: 10,
        },
      ],
    })
    expect(result.content).toBe('/api/media/gen.png')
  })

  it('提供 reference（[[media:<file>]]）时同样解析', async () => {
    mediaMocks.resolveMediaAsset.mockResolvedValueOnce({
      id: 'ref-2',
      kind: 'image',
      mimeType: 'image/jpeg',
      filename: 'bbb.jpg',
      path: '/tmp/bbb.jpg',
      size: 10,
    })
    mediaMocks.callMediaService.mockResolvedValueOnce({})
    mediaMocks.saveMediaAsset.mockResolvedValueOnce({ filename: 'gen2.png' })

    const exec = mediaSenses[0]!.executor.execute.bind(mediaSenses[0]!.executor)
    await exec({ prompt: 'p', reference: '[[media:bbb.jpg]]' }, new Map())

    expect(mediaMocks.resolveMediaAsset).toHaveBeenCalledWith('bbb.jpg')
    expect(mediaMocks.callMediaService).toHaveBeenCalledWith(
      'image',
      'generate',
      expect.objectContaining({ prompt: 'p' }),
    )
  })

  it('reference 指向不存在的资产时不透传 assets，只带 prompt', async () => {
    mediaMocks.resolveMediaAsset.mockResolvedValueOnce(undefined)
    mediaMocks.callMediaService.mockResolvedValueOnce({})

    const exec = mediaSenses[0]!.executor.execute.bind(mediaSenses[0]!.executor)
    await exec({ prompt: 'p', reference: '/api/media/missing.png' }, new Map())

    expect(mediaMocks.callMediaService).toHaveBeenCalledWith('image', 'generate', { prompt: 'p' })
  })
})
