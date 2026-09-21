/**
 * mediaUrls 工具单测。
 *
 * 覆盖：
 * - extractMediaUrls 识别展示型 URL（/api/media/<filename>，原有行为）
 * - extractMediaUrls 识别上传图内部标记（[[media:<filename>]]，用户上传图发送后落库形态）
 * - 两种形式混合 / kind 推导 / 非媒体文件归 image
 * - stripMediaMarkers 剥离 [[media:...]] 且不误伤 [[command:...]] 等其它标记
 */
import { describe, it, expect } from 'vitest'
import { extractMediaUrls, stripMediaMarkers } from '@/utils/mediaUrls'

describe('extractMediaUrls', () => {
  it('识别展示型 /api/media/<filename> URL（原有行为）', () => {
    const text = '看图：/api/media/550e8400-e29b-41d4-a716-446655440000.png'
    const urls = extractMediaUrls(text)
    expect(urls).toHaveLength(1)
    expect(urls[0]).toMatchObject({
      filename: '550e8400-e29b-41d4-a716-446655440000.png',
      kind: 'image',
      mimeType: 'image/png',
    })
  })

  it('识别上传图内部标记 [[media:<filename>]]', () => {
    const text = '看这张图 [[media:550e8400-e29b-41d4-a716-446655440000.png]]'
    const urls = extractMediaUrls(text)
    expect(urls).toHaveLength(1)
    expect(urls[0]).toMatchObject({
      filename: '550e8400-e29b-41d4-a716-446655440000.png',
      kind: 'image',
      mimeType: 'image/png',
    })
  })

  it('两种形式混合时全部提取，按扩展名推导 kind/mimeType', () => {
    const text =
      '图一 [[media:aaa.png]] 视频 /api/media/bbb.mp4 音频 [[media:ccc.wav]]'
    const urls = extractMediaUrls(text)
    expect(urls).toHaveLength(3)
    expect(urls[0].kind).toBe('image')
    expect(urls[1]).toMatchObject({ filename: 'bbb.mp4', kind: 'video', mimeType: 'video/mp4' })
    expect(urls[2]).toMatchObject({ filename: 'ccc.wav', kind: 'audio', mimeType: 'audio/wav' })
  })

  it('未知扩展名归 image / octet-stream', () => {
    const urls = extractMediaUrls('[[media:a1b2.bin]]')
    expect(urls[0]).toMatchObject({
      filename: 'a1b2.bin',
      kind: 'image',
      mimeType: 'application/octet-stream',
    })
  })

  it('无媒体时不返回', () => {
    expect(extractMediaUrls('普通文本')).toEqual([])
  })
})

describe('stripMediaMarkers', () => {
  it('剥离 [[media:...]] 标记并保留周边文本', () => {
    // 真实格式：marker 以换行追加在消息末尾
    const text = '看这张图\n[[media:aaa.png]]\n[[media:bbb.png]]'
    expect(stripMediaMarkers(text)).toBe('看这张图')
  })

  it('紧邻文本的标记剥离后无缝拼接', () => {
    expect(stripMediaMarkers('看图[[media:aaa.png]]和这张')).toBe('看图和这张')
  })

  it('纯图消息剥离后为空字符串', () => {
    expect(stripMediaMarkers('[[media:aaa.png]]')).toBe('')
  })

  it('不误伤其它 [[...]] 标记（如 command）', () => {
    const text = '压缩 [[command:/compact]] [[media:aaa.png]]'
    expect(stripMediaMarkers(text)).toBe('压缩 [[command:/compact]]')
  })
})
