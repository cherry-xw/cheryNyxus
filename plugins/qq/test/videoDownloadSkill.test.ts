import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readQQGroupFile, writeQQGroupFile } from '../src/files.js'
import { extractMediaLinksFromHtml, parseMasterM3u8, selectRecommendedOption, formatBytes } from '../skills/video-download/scripts/video.mjs'

describe('QQ group shared files and video-download skill helpers', () => {
  it('isolates group shared files by groupId and rejects private sessions', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'qq-group-files-'))
    try {
      const privateSubject = { selfId: '123456', userId: '649207438', conversationType: 'private' as const }
      await expect(writeQQGroupFile(root, privateSubject, { path: 'scripts/site.mjs', content: 'console.log(1)' })).rejects.toThrow('群共享文件仅限可信QQ群会话访问')

      const groupA = { selfId: '123456', userId: '649207438', groupId: '805107001', conversationType: 'group' as const }
      const groupB = { selfId: '123456', userId: '649207438', groupId: '999999999', conversationType: 'group' as const }

      const written = await writeQQGroupFile(root, groupA, { path: 'scripts/parser.mjs', content: '// reusable parser\nconsole.log("ok")\n' })
      expect(written.workerPath).toBe('/workspace/files/scripts/parser.mjs')

      const readBack = await readQQGroupFile(root, groupA, { path: 'scripts/parser.mjs' })
      expect(readBack.content).toContain('reusable parser')
      expect(readBack.version).toBe(written.version)

      await expect(readQQGroupFile(root, groupB, { path: 'scripts/parser.mjs' })).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('extracts m3u8/mp4 links, parses master playlist sizes, and recommends 720P/480P for mobile', () => {
    const html = `<script>var playUrl = "https:\\/\\/cdn.example.com\\/video\\/master.m3u8?token=abc"; var backup = "/static/clip.mp4";</script>`
    const links = extractMediaLinksFromHtml(html, 'https://www.example.com/watch/1')
    expect(links).toEqual([
      'https://cdn.example.com/video/master.m3u8?token=abc',
      'https://www.example.com/static/clip.mp4',
    ])

    const m3u8 = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=854x480,CODECS="avc1.64001f,mp4a.40.2"',
      '480p/index.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=1800000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"',
      '720p/index.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"',
      '1080p/index.m3u8',
    ].join('\n')

    const variants = parseMasterM3u8(m3u8, 'https://cdn.example.com/video/master.m3u8', 120)
    expect(variants).toHaveLength(3)
    expect(variants[1]?.quality).toBe('720P')
    expect(variants[1]?.sizeLabel).toContain('MB')
    expect(selectRecommendedOption(variants, 1024 * 1024 * 1024)).toBe('hls-720')
    expect(formatBytes(52 * 1024 * 1024)).toBe('52.0 MB')
    expect(formatBytes(1.25 * 1024 * 1024 * 1024)).toBe('1.25 GB')
  })
})
