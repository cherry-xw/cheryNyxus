import { cpSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkpointMiddleware } from '@/agent/middleware/checkpoint.js'
import { ModelRequestTimeoutError } from '@/agent/middleware/requestTimeout.js'
import { AgentParkError } from '@/core/middleware/errors.js'
import type { MiddlewareChunk, StreamChunk } from '@/core/middleware/types.js'
import { getSoulDb, closeAllDbs } from '@/db/index.js'
import * as verifications from '@/db/serverToolObservations.js'
import { readBrainServiceCapabilities } from '@/service/config/brainCapabilities.js'
import { resetModelCatalogCache } from '@/utils/modelCatalog.js'
import { createServerToolScope, type ServerToolConnection } from '@/utils/serverToolScope.js'
import { createMockContext, makeNext } from '../helpers/fakeContext.js'
import { collectChunks } from '../helpers/chunkAssert.js'

const connection: ServerToolConnection = {
  provider: 'custom',
  protocol: 'anthropic-messages',
  model: 'co-glm-5.3',
  url: 'https://example.com/v1',
  key: 'test-only-credential',
}
const scopeId = createServerToolScope(connection)!

function context() {
  const ctx = createMockContext({ messages: [] })
  ctx.runtime.serverToolScopeId = scopeId
  return ctx
}

function response(fields: Partial<StreamChunk> = {}): StreamChunk {
  return {
    type: 'stream',
    thinkingDelta: '',
    contentDelta: '网页读取结果已确认。',
    stopReason: 'end_turn',
    serverToolDeltas: [
      { kind: 'start', index: 0, id: 'server-1', name: 'webReader' },
      { kind: 'result', index: 1, callId: 'server-1', status: 'completed', result: '页面原文' },
    ],
    ...fields,
  }
}

beforeEach(() => {
  cpSync(
    new URL('../../../.chery.template/model-catalog.yaml', import.meta.url),
    join(process.env.CHERY_DIR!, '.chery/model-catalog.yaml'),
  )
  resetModelCatalogCache()
  getSoulDb().prepare('DELETE FROM server_tool_verifications').run()
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No remote calls allowed') }))
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('真实会话结束写入服务端工具验证', () => {
  it('正常结束后能力查询变为已验证，重开数据库仍保留，切换连接不借用记录', async () => {
    expect(readBrainServiceCapabilities(connection).verification.status).toBe('not-verified')
    const output = await collectChunks(checkpointMiddleware(context(), makeNext([response()])))
    closeAllDbs()
    const capabilities = readBrainServiceCapabilities(connection)
    expect(capabilities.verification.status).toBe('verified')
    expect(capabilities.knownTools.find(tool => tool.name === 'webReader')).toMatchObject({
      sources: ['catalog', 'verified'],
      verification: { status: 'verified', capability: 'webReader' },
    })
    expect(readBrainServiceCapabilities({ ...connection, key: 'another-credential' }).verification.status)
      .toBe('not-verified')
    expect(output).toContainEqual(expect.objectContaining({
      type: 'staged', executionOwner: 'server', serverState: 'completed',
    }))
    expect(fetch).not.toHaveBeenCalled()
  })

  it('工具明确失败或正文报告抓取失败时保留失败结论', async () => {
    await collectChunks(checkpointMiddleware(context(), makeNext([response({
      serverToolDeltas: [
        { kind: 'start', index: 0, id: 'server-1', name: 'webReader' },
        { kind: 'result', index: 1, callId: 'server-1', status: 'failed', error: '读取失败' },
      ],
    })])))
    expect(readBrainServiceCapabilities(connection).verification).toMatchObject({
      status: 'failed', reason: '读取失败',
    })
    await collectChunks(checkpointMiddleware(context(), makeNext([response({
      contentDelta: 'Failed to fetch https://example.com/page',
    })])))
    expect(readBrainServiceCapabilities(connection).verification).toMatchObject({
      status: 'failed', reason: '调用已结束，但目标内容抓取失败',
    })
  })

  it.each(['tool_use', undefined])('结束原因为 %s 时不把工具完成当作整个任务成功', async stopReason => {
    await collectChunks(checkpointMiddleware(context(), makeNext([response({ stopReason })])))
    expect(verifications.listServerToolVerifications(scopeId)).toEqual([])
  })

  it('缺少最终回答时不记录成功', async () => {
    await collectChunks(checkpointMiddleware(context(), makeNext([response({ contentDelta: '' })])))
    expect(readBrainServiceCapabilities(connection).verification).toMatchObject({
      status: 'failed', reason: '未生成有效最终回答',
    })
  })

  it.each([new Error('stream interrupted'), new ModelRequestTimeoutError(1000), new AgentParkError()])(
    '断流、超时或暂停不因已有工具结果写入成功：%s', async error => {
      const next = async function* (): AsyncGenerator<MiddlewareChunk> {
        yield response()
        throw error
      }
      await expect(collectChunks(checkpointMiddleware(context(), next))).rejects.toBe(error)
      expect(verifications.listServerToolVerifications(scopeId)).toEqual([])
    },
  )

  it('重试重置后不把前一次尝试的成功工具写入验证', async () => {
    await collectChunks(checkpointMiddleware(context(), makeNext([
      response(),
      { type: 'retry_reset' } as MiddlewareChunk,
      response({ serverToolDeltas: [] }),
    ])))
    expect(verifications.listServerToolVerifications(scopeId)).toEqual([])
  })

  it('验证归属于请求开始时的连接，不借用执行期间切换后的连接', async () => {
    const ctx = context()
    const otherScopeId = createServerToolScope({ ...connection, key: 'another-credential' })!
    const next = async function* (): AsyncGenerator<MiddlewareChunk> {
      ctx.runtime.serverToolScopeId = otherScopeId
      yield response()
    }
    await collectChunks(checkpointMiddleware(ctx, next))
    expect(verifications.listServerToolVerifications(scopeId)).toMatchObject([{ status: 'verified' }])
    expect(verifications.listServerToolVerifications(otherScopeId)).toEqual([])
  })

  it('未在本地执行的普通调用不写入验证或创建本地审批', async () => {
    const output = await collectChunks(checkpointMiddleware(context(), makeNext([response({
      senseDelta: [{ index: 2, id: 'local-1', name: 'web_fetch', arguments: '{}' }],
    })])))
    expect(verifications.listServerToolVerifications(scopeId).map(item => item.name)).toEqual(['webReader'])
    expect(output.some(item => item.type === 'sense_pending')).toBe(false)
    expect(output).toContainEqual(expect.objectContaining({
      type: 'staged', id: 'local-1', serverState: 'skipped-local',
    }))
  })

  it('验证保存失败不影响正文和服务端工具记录交付，日志不泄露异常内容', async () => {
    vi.spyOn(verifications, 'recordServerToolTaskVerification').mockImplementation(() => {
      throw new Error('private-database-error')
    })
    const ctx = context()
    const log = vi.fn()
    ctx.log = Object.assign(Object.create(ctx.log), { event: log })
    const output = await collectChunks(checkpointMiddleware(ctx, makeNext([response()])))
    expect(output).toContainEqual(expect.objectContaining({
      type: 'message_created', message: expect.objectContaining({ content: '网页读取结果已确认。' }),
    }))
    expect(output).toContainEqual(expect.objectContaining({
      type: 'staged', executionOwner: 'server', serverState: 'completed',
    }))
    expect(log).toHaveBeenCalledWith('llm.server_tool_verification.unavailable', {}, expect.anything())
    expect(JSON.stringify(log.mock.calls)).not.toContain('private-database-error')
  })
})
