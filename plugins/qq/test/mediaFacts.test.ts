import { describe, expect, it } from 'vitest'
import { mediaFacts } from '../src/mediaFacts.js'

const video = { codec_type: 'video', codec_name: 'h264', width: 1920, height: 818 }
describe('actual media facts', () => {
  it('keeps actual cropped dimensions instead of inventing a requested quality label', () => {
    expect(mediaFacts({ streams: [video, { codec_type: 'audio', codec_name: 'aac' }], format: { duration: '1812.842' } }))
      .toEqual({ width: 1920, height: 818, durationSeconds: 1812.842, videoCodec: 'h264', audioCodec: 'aac' })
  })
  it('permits a genuine silent video without inventing audio', () => {
    expect(mediaFacts({ streams: [video], format: { duration: 1 } })).not.toHaveProperty('audioCodec')
  })
  it.each([
    { streams: [], format: { duration: 1 } },
    { streams: [{ ...video, width: 0 }], format: { duration: 1 } },
    { streams: [{ codec_type: 'video' }], format: { duration: 1 } },
    ...['0', '-1', 'NaN', 'Infinity'].map(duration => ({ streams: [video], format: { duration } })),
  ])('rejects invalid or missing video facts: %j', probe => {
    expect(() => mediaFacts(probe)).toThrow()
  })
})
