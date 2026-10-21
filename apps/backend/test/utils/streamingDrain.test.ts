import { describe, expect, it } from 'vitest'
import { StreamingDrain } from '@/utils/drain/index.js'

describe('StreamingDrain', () => {
  it('decodes split UTF-8, retains three samples and keeps stderr independent', async () => {
    const drain = new StreamingDrain()
    const text = Buffer.from('\u001b[32m任务 12 完成\u001b[0m\n任务 13 完成\n任务 14 完成\n任务 15 完成\n')
    for (const byte of text) await drain.write('stdout', Buffer.from([byte]))
    await drain.write('stderr', Buffer.from('任务 16 完成\n'))
    const result = await drain.finish()
    expect(result).toMatchObject({ status: 'complete', lineCount: 5 })
    expect(result.templates.filter((template) => template.stream === 'stdout')).toMatchObject([{ count: 4, samples: ['任务 12 完成', '任务 13 完成', '任务 14 完成'] }])
    expect(result.templates.filter((template) => template.stream === 'stderr')).toMatchObject([{ count: 1 }])
    expect(await drain.finish()).toEqual(result)
  })

  it('bounds templates, per-line text and processing of a dense chunk', async () => {
    const drain = new StreamingDrain()
    await drain.write('stdout', Buffer.from('x'.repeat(100_000) + '\n'))
    for (let i = 1; i <= 250; i++) await drain.write('stdout', Buffer.from(Array(i).fill('distinct').join(' ') + '\n'))
    await drain.write('stderr', Buffer.from('\n'.repeat(4096)))
    const result = await drain.finish()
    expect(result.status).toBe('partial')
    expect(result.templates.length).toBeLessThanOrEqual(200)
    expect(result.retiredLineCount).toBeGreaterThan(0)
    expect(result.truncatedLineCount).toBeGreaterThan(0)
    expect(result.skippedLineCount).toBe(2048)
    expect(result.templates.every((template) => template.samples.every((sample) => sample.length <= 4096))).toBe(true)
  })
})
