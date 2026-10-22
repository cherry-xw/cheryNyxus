import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { observeServerTools } from '@/agent/provider/serverToolObservation.js'
import { listServerToolObservations } from '@/db/serverToolObservations.js'
import type { MessageProviderAdapterConfig, ServerToolCallDelta, ServerToolCallInfo } from '@/core/message/adapter.js'

const adapter: MessageProviderAdapterConfig = {
  content: () => '', buildMessages: () => [], extractStreamDelta: () => '',
  extractStreamServerToolDeltas: raw => raw as ServerToolCallDelta[],
  serverToolCalls: raw => raw as ServerToolCallInfo[],
}
function create(stream = true) {
  const scope = randomUUID()
  const parent = { start: vi.fn(), response: vi.fn(), finish: vi.fn() }
  return { scope, parent, observer: observeServerTools(parent, scope, adapter, stream, 'model') }
}
const start: ServerToolCallDelta = { kind: 'start', index: 0, id: 'server-id', name: 'webReader', arguments: '{"secret":"not-stored"}' }
const end: ServerToolCallDelta = { kind: 'result', index: 1, callId: 'server-id', status: 'completed', result: 'private page text' }

describe('模型请求工具观察记录', () => {
  it('重放重复快照不复制工具，不让后到的开始事件覆盖完成；不保存敏感内容', () => {
    const { observer, parent, scope } = create()
    observer.start('model')
    observer.response([start]); observer.response([end]); observer.response([start, end])
    observer.finish('completed'); observer.finish('completed')
    const tools = listServerToolObservations(scope).tools
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({ name: 'webReader', status: 'completed' })
    expect(JSON.stringify(tools)).not.toMatch(/secret|private page text/)
    expect(parent.start).toHaveBeenCalledWith('model')
    expect(parent.response).toHaveBeenCalledTimes(3)
  })

  it.each(['failed', 'cancelled'] as const)('请求%s不改写已完成工具；未完成工具改为未知', status => {
    const { observer, scope } = create()
    observer.start()
    observer.response([start, end, { ...start, id: 'second', name: 'another' }])
    observer.finish(status)
    expect(listServerToolObservations(scope).tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'webReader', status: 'completed' }),
      expect.objectContaining({ name: 'another', status: 'unknown' }),
    ]))
  })

  it('孤立结果保持未知，没有真实名称的孤立结果不编造目录项', () => {
    const { observer, scope } = create()
    observer.start()
    observer.response([end, { ...end, callId: 'orphan', name: 'known_name' }])
    observer.finish('completed')
    expect(listServerToolObservations(scope).tools).toEqual([
      expect.objectContaining({ name: 'known_name', status: 'unknown' }),
    ])
  })

  it('重试清除旧调用关联，同 ID 的结果不会借用前一次调用名', () => {
    const { observer, scope } = create()
    observer.start(); observer.response([start])
    observer.start(); observer.response([end]); observer.finish('completed')
    expect(listServerToolObservations(scope).tools).toEqual([
      expect.objectContaining({ name: 'webReader', status: 'unknown' }),
    ])
  })

  it('模型被替换时不写到原配置，完成后迟到事件不再改变记录', () => {
    const { observer, scope } = create()
    observer.start('other-model'); observer.response([start, end]); observer.finish('completed')
    expect(listServerToolObservations(scope).tools).toEqual([])
    observer.start('model'); observer.response([start]); observer.finish('cancelled')
    observer.response([end])
    expect(listServerToolObservations(scope).tools[0]?.status).toBe('unknown')
  })

  it('非流式明确失败保留失败；未本地执行的普通工具不进入服务目录', () => {
    const { observer, scope } = create(false)
    observer.start()
    observer.response([
      { id: '1', name: 'webReader', status: 'failed', executionOwner: 'server', arguments: '{}' },
      { id: '2', name: 'WebFetch', status: 'skipped-local', executionOwner: 'server', arguments: '{}' },
    ])
    observer.finish('completed')
    expect(listServerToolObservations(scope).tools).toEqual([
      expect.objectContaining({ name: 'webReader', status: 'failed' }),
    ])
  })

  it('无连接身份时不包装现有观察器', () => {
    const parent = { start: vi.fn(), response: vi.fn(), finish: vi.fn() }
    expect(observeServerTools(parent, undefined, adapter, true, 'model')).toBe(parent)
  })
})
