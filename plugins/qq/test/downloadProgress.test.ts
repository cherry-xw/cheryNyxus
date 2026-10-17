import { describe, it, expect } from 'vitest'
import { createDownloadReporter } from '../src/downloadProgress.js'
import { QQConfigSchema, QQDefaultConfig } from '@chery/protocol'

describe('download progress reporting', () => {
  it('defaults to ten minutes and validates configuration without frontend changes', () => {
    expect(QQConfigSchema.parse(QQDefaultConfig).workerProgressIntervalMinutes).toBe(10)
    expect(QQConfigSchema.parse(QQDefaultConfig).workerProgressEnabled).toBe(true)
    expect(QQConfigSchema.safeParse({ ...QQDefaultConfig, workerProgressIntervalMinutes: 0 }).success).toBe(false)
  })
  it('throttles, uses MB/GB, never invents percentages, and detects stalled output', () => {
    let now = 0; const messages: string[] = []
    const report = createDownloadReporter(600000, text => messages.push(text), () => now)
    report({ phase: 'downloading', bytes: 0, elapsedMs: 0 })
    now = 599999; report({ phase: 'downloading', bytes: 1048576, elapsedMs: now })
    expect(messages).toHaveLength(0)
    now = 600000; report({ phase: 'downloading', bytes: 1048576, elapsedMs: now })
    expect(messages[0]).toContain('1.0 MB'); expect(messages[0]).not.toContain('%')
    now = 1200000; report({ phase: 'downloading', bytes: 1048576, elapsedMs: now })
    expect(messages[1]).toContain('暂未观察到进度增长')
    now = 1800000; report({ phase: 'processing', bytes: 1073741824, elapsedMs: now })
    expect(messages[2]).toContain('1.00 GB'); expect(messages[2]).toContain('转码')
  })
  it('isolates notification failure from executing commands', () => {
    let now = 0
    const report = createDownloadReporter(1, () => { throw Error('offline') }, () => now)
    now = 2
    expect(() => report({ phase: 'preparing', bytes: 0, elapsedMs: 2 })).not.toThrow()
  })
})
