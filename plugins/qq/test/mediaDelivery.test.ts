import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { QQPlugin } from '../src/index.js'
import { emptyState } from '../src/state.js'
import { QQDefaultConfig } from '../../../packages/protocol/src/qq.js'
import { inspectMedia } from '../src/mediaFacts.js'

vi.mock('../src/mediaFacts.js', async original => ({ ...await original<typeof import('../src/mediaFacts.js')>(), inspectMedia: vi.fn() }))
const roots: string[] = []
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = fs.mkdtempSync('/tmp/opencode/qq-media-delivery-'); roots.push(root)
  fs.mkdirSync(path.join(root, 'scoped/group-456'), { recursive: true })
  fs.writeFileSync(path.join(root, 'scoped/group-456/123.mp4'), 'fixture')
  vi.stubEnv('CHERY_MEDIA_DIR', root)
  const plugin = Object.create(QQPlugin.prototype) as any
  const job = { requestId: 'request', coreRequestId: 'core', state: 'running', sourceScopeId: 'scope', target: 'group:456',
    input: { selfId: '123', senderId: '789', conversationType: 'group', targetId: '456' }, snapshot: { config: QQDefaultConfig } }
  Object.assign(plugin, { state: { ...emptyState(), jobs: [job] }, connection: 'connection', recovered: true, paused: false,
    stopped: false, persist: vi.fn(), sources: { validate: vi.fn() }, adoptedJobs: new Set() })
  vi.mocked(inspectMedia).mockResolvedValue({ width: 1920, height: 818, durationSeconds: 1812.842, videoCodec: 'h264', audioCodec: 'aac' })
  return { plugin, job }
}
describe('media queue result', () => {
  it('reports measured facts but promises only queue admission', async () => {
    const { plugin } = fixture()
    const result = await plugin.deliverMedia('core', { mediaFile: '123.mp4', forceUploadAsFile: true })
    expect(result).toMatchObject({ status: 'queued', bytes: 7, media: { width: 1920, height: 818 }, deliveryMode: 'group_or_private_file' })
    expect(result.rule).toContain('尚未取得平台发送成功确认')
    expect(plugin.state.outbox).toHaveLength(1)
    expect(plugin.state.outbox[0].status).toBe('pending')
  })
  it('does not queue a file when probing fails', async () => {
    const { plugin } = fixture(); vi.mocked(inspectMedia).mockRejectedValueOnce(new Error('invalid video'))
    await expect(plugin.deliverMedia('core', { mediaFile: '123.mp4' })).rejects.toThrow()
    expect(plugin.state.outbox).toEqual([])
  })
  it.each(['completed', 'disconnected', 'revoked'])('rechecks %s after asynchronous probing', async kind => {
    const { plugin, job } = fixture()
    vi.mocked(inspectMedia).mockImplementationOnce(async () => {
      if (kind === 'completed') job.state = 'completed'
      if (kind === 'disconnected') plugin.connection = undefined
      if (kind === 'revoked') plugin.sources.validate.mockImplementation(() => { throw new Error('IDENTITY_REJECTED') })
      return { width: 1920, height: 818, durationSeconds: 1, videoCodec: 'h264' }
    })
    await expect(plugin.deliverMedia('core', { mediaFile: '123.mp4' })).rejects.toThrow()
    expect(plugin.state.outbox).toEqual([])
  })
})
