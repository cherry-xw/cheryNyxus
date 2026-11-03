import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createChat, deleteChat } from '@/db/chat.js'
import {
  addMessage,
  getMessages,
  parseMessageRow,
  updateAssistantSenseCalls,
} from '@/db/message.js'
import { CheckpointState } from '@/agent/middleware/checkpointState.js'
import { registerAnthropicAdapter } from '@/agent/provider/anthropic.js'
import { getMessageAdapter, type ServerToolCallInfo } from '@/core/message/adapter.js'
import { getSenseAdapter } from '@/core/sense/adapter.js'
import { buildRootTimeline } from '@/service/chat/timeline.js'
import { messagesToStagedEvents } from '@/service/chat/stagedHistory.js'
import { createMockContext, createMockRuntime } from '../agent/helpers/fakeContext.js'

describe('服务端工具持久化', () => {
  it('新增、更新、重新读取与清空均不破坏独立续接字段和本地工具', () => {
    const chatId = randomUUID()
    createChat(chatId)
    try {
      const call: ServerToolCallInfo = {
        id: 'server-1',
        name: 'webReader',
        arguments: '{}',
        executionOwner: 'server',
        status: 'started',
        protocol: 'anthropic-messages',
      }
      const local = [{ id: 'local-1', name: 'read_file', arguments: '{}' }]
      const row = addMessage(randomUUID(), chatId, {
        role: 'assistant',
        content: 'answer',
        senseCall: local,
        serverToolCalls: [call],
        providerContinuation: { thoughtSignature: 'protected-continuation' },
      })
      const load = () =>
        parseMessageRow(getMessages(chatId).find((message) => message.id === row.id)!)
      expect(load().serverToolCalls).toEqual([call])
      expect(load().senseCall).toEqual(local)
      const completed = {
        ...call,
        status: 'completed' as const,
        result: 'page',
        sources: [{ url: 'https://example.com' }],
      }
      updateAssistantSenseCalls(chatId, row.id, local, [completed])
      expect(load().serverToolCalls).toEqual([completed])
      expect(load().providerContinuation?.thoughtSignature).toBe('protected-continuation')
      updateAssistantSenseCalls(chatId, row.id, [])
      expect(load().serverToolCalls).toEqual([completed])
      updateAssistantSenseCalls(chatId, row.id, local, [])
      expect(load().serverToolCalls).toBeUndefined()
      expect(load().senseCall).toEqual(local)
      expect(load().providerContinuation?.thoughtSignature).toBe('protected-continuation')
    } finally {
      deleteChat(chatId)
    }
  })

  it('旧消息未记录服务端调用时不补造记录', () => {
    const chatId = randomUUID()
    createChat(chatId)
    try {
      const row = addMessage(randomUUID(), chatId, { role: 'assistant', content: 'history' })
      expect(parseMessageRow(row).serverToolCalls).toBeUndefined()
      expect(row.provider_continuation).toBeNull()
    } finally {
      deleteChat(chatId)
    }
  })

  it('按真实块序保存思考、正文、服务端工具与本地工具，且受保护原始续接与脱敏展示分离、跨厂商不回放', () => {
    registerAnthropicAdapter()
    const messageAdapter = getMessageAdapter('anthropic')!
    const senseAdapter = getSenseAdapter('anthropic')!
    const chatId = randomUUID()
    createChat(chatId)
    try {
      const rawResponse = {
        id: 'msg_ordered_1',
        type: 'message',
        role: 'assistant',
        stop_reason: 'tool_use',
        content: [
          { type: 'thinking', thinking: '先检索再本地核对', signature: 'sig_glm_01' },
          { type: 'text', text: '正在执行检索。' },
          {
            type: 'server_tool_use',
            id: 'srvtoolu_01',
            name: 'webReader',
            input: { url: 'https://example.com/private?token=secret123&lang=zh' },
          },
          {
            type: 'tool_result',
            tool_use_id: 'srvtoolu_01',
            content: [{ type: 'text', text: '{"title":"Doc","content":"正文内容"}' }],
          },
          { type: 'text', text: '接下来调用本地工具。' },
          {
            type: 'tool_use',
            id: 'toolu_local_01',
            name: 'read_file',
            input: { path: 'README.md' },
          },
        ],
      }

      const state = new CheckpointState()
      state.ingest({
        type: 'stream',
        thinkingDelta: messageAdapter.thinking?.(rawResponse as never) ?? '',
        thinkingBlocksDelta: [
          { kind: 'start', index: 0, blockType: 'thinking' },
          { kind: 'thinking_delta', index: 0, thinking: '先检索再本地核对' },
          { kind: 'signature_delta', index: 0, signature: 'sig_glm_01' },
          { kind: 'stop', index: 0 },
        ],
        contentDelta: messageAdapter.content(rawResponse as never),
        turnSegments: messageAdapter.turnSegments?.(rawResponse as never),
        senseDelta: senseAdapter.senseCalls(rawResponse as never),
        serverToolDeltas: messageAdapter.extractNonStreamServerToolDeltas?.(rawResponse as never),
        stopReason: messageAdapter.stopReason?.(rawResponse as never),
      })

      const runtime = createMockRuntime({ brain: { provider: 'bigmodel' } })
      const ctx = createMockContext({ runtime, messages: [] })
      const flushed = state.flushAssistant(ctx)!

      // 1. 展示副本 serverToolCalls 必须已脱敏 token，而受保护续接保留原始块供同供应商回传
      expect(flushed.serverToolCalls?.[0]?.arguments).toContain('%5BREDACTED%5D')
      expect(flushed.serverToolCalls?.[0]?.arguments).not.toContain('secret123')
      expect(
        JSON.stringify(flushed.providerContinuation?.serverToolContinuation),
      ).toContain('secret123')

      const row = addMessage(flushed.id, chatId, {
        role: 'assistant',
        content: flushed.content,
        thinking: flushed.thinking,
        thinkingBlocks: flushed.thinkingBlocks,
        senseCall: flushed.senseCalls,
        serverToolCalls: flushed.serverToolCalls,
        providerContinuation: flushed.providerContinuation,
      })

      // 2. 数据库重启恢复、Timeline 与 StagedHistory 均保持真实块顺序（server_tool index=2 在 local sense index=5 之前），且不泄露受保护续接
      const timeline = buildRootTimeline(chatId)
      const assistantNode = timeline.nodes.find((n) => n.id === row.id)
      expect(assistantNode?.toolCalls?.map((c) => [c.callId, c.executionOwner, c.index])).toEqual([
        ['srvtoolu_01', 'server', 2],
        ['toolu_local_01', undefined, 5],
      ])
      expect(JSON.stringify(timeline)).not.toContain('secret123')

      const staged = messagesToStagedEvents(chatId)
      const senseEndIds = staged
        .filter((c) => c.type === 'staged' && (c.data as { type?: string }).type === 'sense_end')
        .map((c) => (c.data as { id?: string }).id)
      expect(senseEndIds).toEqual(['srvtoolu_01', 'toolu_local_01'])
      expect(JSON.stringify(staged)).not.toContain('secret123')

      // 3. 同供应商显式启用受保护续接时，按原始块序号还原完整内容块（绝不用脱敏副本拼装）
      const parsed = parseMessageRow(getMessages(chatId)[0]!)
      const sameProviderBuilt = messageAdapter.buildMessages(
        [
          { id: 'u1', role: 'user', content: '查文档', createdAt: 1, updateAt: 1 },
          {
            id: row.id,
            role: 'assistant',
            content: parsed.content ?? '',
            thinking: parsed.thinking,
            thinkingBlocks: parsed.thinkingBlocks,
            senseCalls: parsed.senseCall,
            serverToolCalls: parsed.serverToolCalls,
            providerContinuation: parsed.providerContinuation,
            createdAt: 2,
            updateAt: 2,
          },
        ],
        undefined,
        {
          provider: 'bigmodel',
          includeServerToolContinuation: true,
        },
      )
      const sameAssistant = sameProviderBuilt.messages[1] as { content: Array<{ type: string }> }
      expect(sameAssistant.content.map((b) => b.type)).toEqual([
        'thinking',
        'text',
        'server_tool_use',
        'tool_result',
        'text',
        'tool_use',
      ])
      expect(JSON.stringify(sameAssistant.content[2])).toContain('secret123')

      // 4. 切换供应商时不回放他方受保护服务端块与签名
      const crossProviderBuilt = messageAdapter.buildMessages(
        [
          { id: 'u1', role: 'user', content: '查文档', createdAt: 1, updateAt: 1 },
          {
            id: row.id,
            role: 'assistant',
            content: parsed.content ?? '',
            thinking: parsed.thinking,
            thinkingBlocks: parsed.thinkingBlocks,
            senseCalls: parsed.senseCall,
            serverToolCalls: parsed.serverToolCalls,
            providerContinuation: parsed.providerContinuation,
            createdAt: 2,
            updateAt: 2,
          },
        ],
        undefined,
        {
          provider: 'anthropic',
          includeServerToolContinuation: true,
        },
      )
      const crossAssistant = crossProviderBuilt.messages[1] as {
        content: Array<{ type: string; signature?: string }>
      }
      expect(crossAssistant.content.map((b) => b.type)).toEqual(['thinking', 'text', 'tool_use'])
      expect(crossAssistant.content[0]?.signature).toBeUndefined()
      expect(JSON.stringify(crossAssistant)).not.toContain('srvtoolu_01')
      expect(JSON.stringify(crossAssistant)).not.toContain('secret123')
    } finally {
      deleteChat(chatId)
    }
  })
})
