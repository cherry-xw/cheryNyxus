import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { QQCapabilities, QQDeliveryResultRequestSchema, type QQNotification } from '@chery/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Adapter } from '../src/adapter.js'
import type { BackendWire } from '../src/wire.js'
import { serviceFixture } from './serviceFixture.js'

let root: string
let adapter: Adapter | undefined
beforeEach(async () => { root = await mkdtemp('/tmp/opencode/asset-adapter-') })
afterEach(async () => { adapter?.close(); adapter = undefined; await rm(root, { recursive: true, force: true }) })
const bytes = Buffer.from('fixture')
const event = (): QQNotification => ({ kind: 'notification', type: 'qq.reply.file', data: {
  selfId: '123', conversationType: 'group', targetId: '456', requestId: 'request', eventId: 'output', seq: 1, completeReply: true,
  asset: { assetId: 'asset', assetVersionId: 'version', originalName: 'fixture.txt', mimeType: 'text/plain', sizeBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') },
} })

async function setup() {
  const action = vi.fn(async (name: string, _params: unknown) => name === 'get_login_info' ? { user_id: '123' }
    : name === 'get_status' ? { online: true, good: true } : { status: 'ok', retcode: 0, data: { file_id: null } })
  const request = vi.fn(async (method: string, _params: unknown): Promise<any> => {
    const data = method === 'qq.plugin.hello' ? { protocolVersion: 1, backendVersion: 'test', selfId: '123', authenticated: true, capabilities: [...QQCapabilities] }
      : method === 'qq.identity.bind' ? { bound: true, selfId: '123', sourceType: 'napcat-action', validation: 'accepted' }
      : method === 'qq.image.scope.get' ? {schemaVersion:1,backendEpoch:'epoch',connectionGeneration:'generation',sessionId:'session',selfId:'123',appliedRevision:0,scopeDigest:'0'.repeat(64),enabled:true,allowedTargets:[{conversationType:'group',targetId:'456'},{conversationType:'private',targetId:'789'},{conversationType:'private',targetId:'999'}],targets:[],limits:{}}
      : method === 'qq.request.recover' ? { events: [], service: serviceFixture() }
      : method === 'qq.file.read' ? { offset: 0, dataBase64: bytes.toString('base64'), eof: true } : { recorded: true }
    return { success: true, data }
  })
  const wire = { connect: vi.fn(), close: vi.fn(), onMessage: vi.fn(() => () => undefined), request }
  adapter = new Adapter({ dataPath: root, configPath: root + '/config.json', adapterName: 'test', pluginManager: { config: {} },
    logger: { warn: vi.fn() }, actions: { call: action } }, wire as unknown as BackendWire)
  await adapter.start()
  expect(adapter.status().ready).toBe(true)
  const deliver = (frame: QQNotification) => (adapter as any).notification(frame) as Promise<void>
  return { action, request, deliver }
}

describe('当前适配器文件交付（纯模拟）', () => {
  it('按当前群媒体范围上传大视频并返回独立文件回执', async () => {
    const { action, request, deliver } = await setup()
    const frame: QQNotification = { kind: 'notification', type: 'qq.reply.video', data: {
      selfId: '123', conversationType: 'group', targetId: '456', requestId: 'request', eventId: 'video', seq: 1,
      mediaScope: 'group-456', mediaFile: '123456.mp4', uploadAsFile: true, fileName: 'fixture.mp4',
    } }
    await deliver(frame)
    expect(action.mock.calls.find(([name]) => name === 'upload_group_file')?.[1]).toMatchObject({ file: '/app/cherynyxus-media/scoped/group-456/123456.mp4' })
    expect(request.mock.calls.find(([name]) => name === 'qq.delivery.result')?.[1]).toMatchObject({ status: 'sent', fileUploaded: true, terminal: true })
  })
  it('拒绝其他群媒体范围，不调用原生上传', async () => {
    const { action, deliver } = await setup()
    await deliver({ kind: 'notification', type: 'qq.reply.video', data: {
      selfId: '123', conversationType: 'group', targetId: '456', requestId: 'request', eventId: 'video', seq: 1,
      mediaScope: 'group-789', mediaFile: '123456.mp4', uploadAsFile: true,
    } })
    expect(action.mock.calls.some(([name]) => name === 'upload_group_file')).toBe(false)
  })
  it('认证分段读取后上传并回传独立文件回执，重放只补回执不再上传', async () => {
    const { action, request, deliver } = await setup()
    await deliver(event())
    const calls = request.mock.calls.filter(([method]) => method === 'qq.delivery.result')
    expect(QQDeliveryResultRequestSchema.parse(calls[0]![1])).toMatchObject({ status: 'sent', messageIds: [], fileIds: [], fileUploaded: true, terminal: true })
    expect(request).toHaveBeenCalledWith('qq.file.read', { selfId: '123', eventId: 'output', offset: 0 })
    expect(action.mock.calls.filter(([name]) => name === 'upload_group_file')).toHaveLength(1)
    await deliver(event())
    expect(action.mock.calls.filter(([name]) => name === 'upload_group_file')).toHaveLength(1)
    expect(request.mock.calls.filter(([method]) => method === 'qq.delivery.result')).toHaveLength(2)
    expect(await readdir(root + '/file-deliveries')).toEqual([])
  })

  it('另一身份或无效资产不读取，也不调用原生上传', async () => {
    const { request, deliver } = await setup()
    const other = event(); other.data.selfId = '999'
    await deliver(other)
    const invalid = event(); invalid.data.asset!.sha256 = 'bad'
    await deliver(invalid)
    expect(request.mock.calls.some(([method]) => method === 'qq.file.read')).toBe(false)
  })

  it('读取中停止时清理临时文件，不上传、不发送旧回执', async () => {
    const { request, action, deliver } = await setup()
    const original = request.getMockImplementation()!
    request.mockImplementation(async (method, params) => {
      if (method === 'qq.file.read') adapter!.close()
      return original(method, params)
    })
    await deliver(event())
    expect(action.mock.calls.some(([name]) => name === 'upload_group_file')).toBe(false)
    expect(request.mock.calls.some(([method]) => method === 'qq.delivery.result')).toBe(false)
    expect(await readdir(root + '/file-deliveries')).toEqual([])
  })
})
