import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import readSense from '@/agent/sense/read.js'
import { callMediaService } from '@/service/media/index.js'
import { addMemory } from '@/memory/manager.js'
import { getAppliedRawConfig, replaceRuntimeConfig } from '@/utils/config.js'
import { cleanupTempDir, createTempDir, createTempFile } from '../../helpers/tempDir.js'

const baseline = getAppliedRawConfig()
const sharedData = new Map<string, Map<string, unknown>>()
const readFile = readSense.executor.execute.bind(readSense.executor)

afterEach(() => {
  replaceRuntimeConfig(baseline)
  vi.unstubAllGlobals()
})

describe('live settings real consumers', () => {
  it('file reads use the compression settings published before each operation', async () => {
    const dir = createTempDir()
    try {
      const file = createTempFile(
        dir,
        'hot-compression.dat',
        Array.from({ length: 40 }, (_, i) => `line-${i}-padding`).join('\n'),
      )
      const relaxed = getAppliedRawConfig()
      relaxed.global.file_compression = {
        truncate_threshold: 100_000,
        truncate_preview_lines: 2,
      }
      replaceRuntimeConfig(relaxed)
      expect(
        (await readFile({ path: file, compression: 'auto' }, sharedData)).content,
      ).not.toContain('大文件截断')

      const strict = getAppliedRawConfig()
      strict.global.file_compression = { truncate_threshold: 10, truncate_preview_lines: 2 }
      replaceRuntimeConfig(strict)
      expect((await readFile({ path: file, compression: 'auto' }, sharedData)).content).toContain(
        '大文件截断',
      )
    } finally {
      cleanupTempDir(dir)
    }
  })

  it('media calls use the service published before the operation', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ text: 'ok' }) })
    vi.stubGlobal('fetch', fetchMock)
    const first = getAppliedRawConfig()
    first.media = {
      live_image: { type: 'image', url: 'http://media-one.test', enabled: true },
    }
    replaceRuntimeConfig(first)
    await callMediaService('image', 'generate', { prompt: 'one' })

    const second = getAppliedRawConfig()
    second.media!.live_image!.url = 'http://media-two.test'
    replaceRuntimeConfig(second)
    await callMediaService('image', 'generate', { prompt: 'two' })

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://media-one.test',
      'http://media-two.test',
    ])
  })

  it('memory operations use the latest published limit', () => {
    const name = `hot-${randomUUID()}`
    const strict = getAppliedRawConfig()
    strict.memory = { ...(strict.memory ?? {}), global: { max_count: 30, max_chars: 3 } }
    replaceRuntimeConfig(strict)
    expect(
      addMemory({ name, description: 'hot', content: '1234', type: 'fact', scope: 'global' }),
    ).toMatchObject({ ok: false, error: expect.stringContaining('3 字') })

    const relaxed = getAppliedRawConfig()
    relaxed.memory = { ...(relaxed.memory ?? {}), global: { max_count: 30, max_chars: 4 } }
    replaceRuntimeConfig(relaxed)
    expect(
      addMemory({ name, description: 'hot', content: '1234', type: 'fact', scope: 'global' }),
    ).toMatchObject({ ok: true })
  })
})
