import { readComponentSource } from '../helpers/componentSource'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PERFORMANCE_FRAME_SAMPLE_LIMIT,
  summarizeFrameIntervals,
} from '../../src/utils/performanceDiagnostics'

describe('performance diagnostics frame summary', () => {
  it('reports nearest-rank p95 and the maximum interval', () => {
    const intervals = Array.from({ length: 100 }, (_, index) => index + 1)

    expect(summarizeFrameIntervals(intervals)).toEqual({
      sampleCount: 100,
      p95Ms: 95,
      maxMs: 100,
    })
  })

  it('ignores unusable samples and returns a stable empty summary', () => {
    expect(summarizeFrameIntervals([Number.NaN, Number.POSITIVE_INFINITY, 0, -1])).toEqual({
      sampleCount: 0,
      p95Ms: 0,
      maxMs: 0,
    })
    expect(PERFORMANCE_FRAME_SAMPLE_LIMIT).toBe(7_200)
  })

  it('records each shared display frame for the development snapshot', async () => {
    const source = await readComponentSource(resolve('web/src/utils/frameCoordinator.ts'), 'utf8')

    expect(source).toContain('recordPerformanceFrame(deltaMs)')
  })
})
