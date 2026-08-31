/**
 * checkpointMiddleware 集成测试（真实洋葱链 + mock provider）。
 *
 * 聚焦 chunk 归纳：consumed / 三 delta staged（thinking_end/content_end/sense_end）
 * / message_created effect / user input 注入。sense 执行细节见 tool.test.ts。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { bootstrapForTests, createAgent, runSend } from '../helpers/agentHarness.js'
import { checkpointMiddleware } from '@/agent/middleware/checkpoint.js'
import { createMockContext } from '../helpers/fakeContext.js'
import {
  stagedTypes,
  messageCreated,
  firstConsumed,
  collectContent,
  collectThinking,
  senseEnds,
  senseAccepts,
  filterType,
  hasDone,
  collectChunks,
} from '../helpers/chunkAssert.js'
import type { MiddlewareChunk, StreamChunk, StagedChunk } from '@/core/middleware/types.js'

describe('checkpointMiddleware 集成', () => {
  beforeAll(async () => {
    await bootstrapForTests()
  })

  it('content-only：consumed + thinking_end + content_end + message_created(user,assistant)', async () => {
    const agent = createAgent({ brain: 'mock_content', senseGroup: 'auto_senses' })
    const chunks = await runSend(agent, '你好')
    expect(firstConsumed(chunks)?.count).toBe(1)
    const staged = stagedTypes(chunks)
    expect(staged).toContain('thinking_end')
    expect(staged).toContain('content_end')
    const roles = messageCreated(chunks).map((m) => m.message.role)
    expect(roles).toContain('user')
    expect(roles).toContain('assistant')
    expect(collectContent(chunks)).toContain('纯文本回复')
    expect(collectThinking(chunks)).toContain('思考')
    expect(hasDone(chunks)).toBe(true)
  })

  it('三 delta 顺序：thinking_end 在 content_end 之前', async () => {
    const agent = createAgent({ brain: 'mock_content', senseGroup: 'auto_senses' })
    const chunks = await runSend(agent, '顺序测试')
    const staged = stagedTypes(chunks)
    const tIdx = staged.indexOf('thinking_end')
    const cIdx = staged.indexOf('content_end')
    expect(tIdx).toBeGreaterThanOrEqual(0)
    expect(cIdx).toBeGreaterThan(tIdx)
  })

  it('user input 注入 messages（consumed 携带 message）', async () => {
    const agent = createAgent({ brain: 'mock_content', senseGroup: 'auto_senses' })
    const chunks = await runSend(agent, '注入测试内容')
    const consumed = firstConsumed(chunks)
    expect(consumed?.count).toBe(1)
    expect(consumed?.messages?.[0]?.content).toBe('注入测试内容')
    expect(consumed?.messages?.[0]?.role).toBe('user')
    expect(consumed?.messages?.[0]?.id).toBeTruthy()
    expect(consumed?.messages?.[0]?.createdAt).toEqual(expect.any(Number))
  })

  it('模型专用指令不进入 consumed，自动附加内容保留用户原文', async () => {
    const agent = createAgent({ brain: 'mock_content', senseGroup: 'auto_senses' })
    const chunks: MiddlewareChunk[] = []
    for await (const chunk of agent.run('[[command:/review]]\n真实问题', {
      extraUserMessages: ['完整指令正文'],
      inputMeta: { persistedContent: '真实问题' },
    })) {
      chunks.push(chunk)
    }

    const consumed = firstConsumed(chunks)
    expect(consumed?.count).toBe(1)
    expect(consumed?.messages?.map((message) => message.content)).toEqual(['真实问题'])
    expect(
      messageCreated(chunks)
        .filter((chunk) => chunk.message.role === 'user')
        .map((chunk) => ({ content: chunk.message.content, ephemeral: chunk.message.ephemeral })),
    ).toEqual([
      { content: '完整指令正文', ephemeral: true },
      { content: '真实问题', ephemeral: undefined },
    ])
    expect(agent.getMessages().some((message) => message.content === '完整指令正文')).toBe(false)
  })

  it('同一 LLM turn 的 stream/staged 共用预分配 msgId', async () => {
    const agent = createAgent({ brain: 'mock_content', senseGroup: 'auto_senses' })
    const chunks = await runSend(agent, '消息身份测试')
    const streams = filterType<StreamChunk>(chunks, 'stream')
    const staged = filterType<StagedChunk>(chunks, 'staged')
    expect(streams.length).toBeGreaterThan(0)
    const msgId = streams[0]?.msgId
    expect(msgId).toBeTruthy()
    expect(streams.every((chunk) => chunk.msgId === msgId)).toBe(true)
    expect(staged.every((chunk) => chunk.msgId === msgId)).toBe(true)
    expect(streams.every((chunk) => chunk.createdAt === staged[0]?.createdAt)).toBe(true)
  })

  it('auto sense：sense_end staged + sense_accept + sense 消息创建', async () => {
    const agent = createAgent({ brain: 'mock_auto', senseGroup: 'auto_senses' })
    const chunks = await runSend(agent, '读文件')
    const staged = stagedTypes(chunks)
    expect(staged).toContain('sense_end')
    expect(senseEnds(chunks).length).toBeGreaterThanOrEqual(1)
    expect(senseAccepts(chunks).length).toBeGreaterThanOrEqual(1)
    const roles = messageCreated(chunks).map((m) => m.message.role)
    expect(roles).toContain('assistant')
    expect(roles).toContain('sense')
  })

  it('安全判定随工具协议透传：sense_end staged + assistant.senseCalls 均携带 security', async () => {
    const agent = createAgent({ brain: 'mock_auto', senseGroup: 'auto_senses' })
    const chunks = await runSend(agent, '读文件')

    // checkpoint 从 trigger 收集 security → staged sense_end 透传（历史回放渲染风险徽章）
    const senseEndStaged = filterType<StagedChunk>(chunks, 'staged').find(
      (c) => c.stagedType === 'sense_end',
    )
    expect(senseEndStaged?.id).toBeTruthy()
    expect(senseEndStaged?.security?.decision).toBeDefined()
    expect(senseEndStaged?.security?.assessmentHash).toBeTruthy()

    // recordSecurity → buildSenseCalls：message_created 的 assistant.senseCalls 落库携带 security
    const assistantCreated = messageCreated(chunks).find((m) => m.message.role === 'assistant')
    const senseCalls = assistantCreated?.message.senseCalls ?? []
    expect(senseCalls.length).toBeGreaterThan(0)
    expect(senseCalls[0]?.security?.decision).toBeDefined()
    expect(senseCalls[0]?.security?.assessmentHash).toBeTruthy()
  })

  it('纯 content 无 sense_end', async () => {
    const agent = createAgent({ brain: 'mock_content', senseGroup: 'auto_senses' })
    const chunks = await runSend(agent, '纯文本')
    expect(stagedTypes(chunks)).not.toContain('sense_end')
    expect(senseEnds(chunks)).toHaveLength(0)
  })

  it('流式多 sense_call：reconcile 双写回写内存 journal（复现 400 2013 根因）', async () => {
    const ctx = createMockContext({ messages: [] })
    const next = async function* (): AsyncGenerator<MiddlewareChunk> {
      // 首个 sense_end 到达时仅 ingest 了 index 0 的 delta → flushAssistant 落库的 senseCalls 不完整
      yield {
        type: 'stream',
        thinkingDelta: '',
        contentDelta: '调用',
        senseDelta: [{ index: 0, id: 't0', name: 'read_file', arguments: '{}' }],
      }
      yield {
        type: 'sense_end',
        id: 't0',
        name: 'read_file',
        arguments: '{}',
        supervisionLevel: 0,
      } as MiddlewareChunk
      // 流结束前第二个 sense call 的 delta 才到达（真实流式时序）
      yield {
        type: 'stream',
        thinkingDelta: '',
        contentDelta: '',
        senseDelta: [{ index: 1, id: 't1', name: 'write_file', arguments: '{}' }],
      }
    }

    await collectChunks(checkpointMiddleware(ctx, next))

    // 内存 journal 的 assistant.senseCalls 必须完整——loop 下一轮 buildMessages 从这里
    // 组装 tool_calls，缺失会造出孤儿 tool result（上游 400 2013，见 docs/agent/middleware.md）
    const assistant = ctx.soul.messages?.find((message) => message.role === 'assistant')
    expect(assistant?.senseCalls?.map((sc) => sc.id)).toEqual(['t0', 't1'])
  })

  it('rotates the assistant turn and discards accumulated content on retry_reset', async () => {
    const ctx = createMockContext({ messages: [] })
    const next = async function* (): AsyncGenerator<MiddlewareChunk> {
      yield { type: 'stream', thinkingDelta: '', contentDelta: 'discard-me' }
      yield { type: 'retry_reset' }
      yield { type: 'stream', thinkingDelta: '', contentDelta: 'clean-result' }
    }

    const chunks = await collectChunks(checkpointMiddleware(ctx, next))
    const streams = filterType<StreamChunk>(chunks, 'stream')
    const reset = chunks.find((chunk) => chunk.type === 'retry_reset') as
      | { type: 'retry_reset'; messageId?: string }
      | undefined
    const contentEnd = filterType<StagedChunk>(chunks, 'staged')
      .find((chunk) => chunk.stagedType === 'content_end')

    const firstTurnId = streams[0]?.msgId
    const retriedTurnId = streams.at(-1)?.msgId
    expect(firstTurnId).toBeTruthy()
    expect(reset?.messageId).toBe(firstTurnId)
    expect(retriedTurnId).toBeTruthy()
    expect(retriedTurnId).not.toBe(firstTurnId)
    expect(contentEnd).toMatchObject({ content: 'clean-result', msgId: retriedTurnId })
    expect(ctx.soul.messages?.filter((message) => message.role === 'assistant')).toEqual([
      expect.objectContaining({ id: retriedTurnId, content: 'clean-result' }),
    ])
  })
})
