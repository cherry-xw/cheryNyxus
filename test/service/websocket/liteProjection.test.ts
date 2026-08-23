import { describe, expect, it } from 'vitest'
import {
  applyLiteEvent,
  applyLiteResponse,
  type LiteProfile,
} from '@/service/websocket/liteProjection.js'
import { parseLiteProfile } from '@/service/websocket/index.js'
import type { Notification } from '@/service/message/types.js'

const profile: LiteProfile = { kind: 'lite', v: 1, maxFrameBytes: 4096, turnDelta: false }
const turnDeltaProfile: LiteProfile = { ...profile, turnDelta: true }

function notification(type: string, data: unknown, extra: Record<string, unknown> = {}): Notification {
  return {
    kind: 'notification',
    type: type as Notification['type'],
    data,
    ...extra,
  } as Notification
}

describe('lite 白名单矩阵：抑制类', () => {
  it('stream chunk（0x01 旧通道）抑制', () => {
    const out = applyLiteEvent(profile, {
      kind: 'chunk',
      type: 'stream',
      requestId: 'r1',
      data: { msgId: 'm1', createdAt: 1, content: 'tok' },
    })
    expect(out).toBeUndefined()
  })

  it('staged chunk（thinking_end/content_end/sense_end）抑制', () => {
    for (const stagedType of ['thinking_end', 'content_end', 'sense_end']) {
      const out = applyLiteEvent(profile, {
        kind: 'chunk',
        type: 'staged',
        requestId: 'r1',
        data: { type: stagedType, content: '全文' },
      })
      expect(out).toBeUndefined()
    }
  })

  it('turn.delta 默认关（turnDelta=0 抑制，=1 透传）', () => {
    const delta = notification('turn.delta', { turnId: 't1', messageId: 't1', channel: 'content', offset: 0, delta: 'x' })
    expect(applyLiteEvent(profile, delta)).toBeUndefined()
    expect(applyLiteEvent(turnDeltaProfile, delta)).toBeDefined()
  })

  it('role_reply 抑制（D16）；loaded/replaced 抑制', () => {
    for (const type of ['role_reply', 'loaded', 'replaced']) {
      expect(applyLiteEvent(profile, notification(type, {}))).toBeUndefined()
    }
  })
})

describe('lite 白名单矩阵：投影精简类', () => {
  it('input.updated 去 content（T7 修正③）', () => {
    const out = applyLiteEvent(profile, notification('input.updated', {
      inputId: 'i1', state: 'started', queueSequence: 1, content: '很长的用户输入全文……'.repeat(20), acceptedAt: 1,
    })) as Notification
    const data = out.data as Record<string, unknown>
    expect(data.content).toBeUndefined()
    expect(data.inputId).toBe('i1')
    expect(data.state).toBe('started')
  })

  it('sense_started 去 arguments（工具名级）', () => {
    const out = applyLiteEvent(profile, notification('sense_started', {
      id: 's1', senseName: 'read_file', arguments: '{...}',
    })) as Notification
    expect(out.data).toEqual({ id: 's1', senseName: 'read_file' })
  })

  it('accept/rejected 去 result 全文', () => {
    const out = applyLiteEvent(profile, notification('accept', {
      approvalId: 'a1', senseName: 'read_file', ok: true, result: 'x'.repeat(40000),
    })) as Notification
    expect(out.data).toEqual({ approvalId: 'a1', senseName: 'read_file', ok: true })
  })

  it('role_created 去 prompt/brain/senseGroup', () => {
    const out = applyLiteEvent(profile, notification('role_created', {
      taskId: 't1', childChatId: 'c1', parentChatId: 'p1', type: 'spawn_role', wake: 'immediate',
      prompt: '长任务描述', brain: 'longcat', senseGroup: 'safe',
    })) as Notification
    expect(out.data).toEqual({ taskId: 't1', childChatId: 'c1', parentChatId: 'p1', type: 'spawn_role', wake: 'immediate' })
  })

  it('interrupt 全量但剔 waitTime/createdAt（C5，deadlineAt 单源）', () => {
    const out = applyLiteEvent(profile, notification('interrupt', {
      approvalId: 'a1', senseName: 'write_file', arguments: { path: '/x' },
      waitTime: 30000, createdAt: 1234567890,
    })) as Notification
    const data = out.data as Record<string, unknown>
    expect(data.waitTime).toBeUndefined()
    expect(data.createdAt).toBeUndefined()
    expect(data.approvalId).toBe('a1')
    expect(data.arguments).toEqual({ path: '/x' })
  })

  it('done 投影：contextUsage 为 number 直接透传（修复：非 ratio 对象）', () => {
    const out = applyLiteEvent(profile, notification('done', {
      contextUsage: 0.42, used: 1, total: 2, contextBreakdown: { a: 1 }, canResume: true,
    })) as Notification
    const data = out.data as Record<string, unknown>
    expect(data.contextUsage).toBe(0.42)
    expect(data.used).toBeUndefined()
    expect(data.contextBreakdown).toBeUndefined()
  })

  it('interrupt：超长单字段截断并附 truncations 引用（D3 字段级智能截断）', () => {
    const out = applyLiteEvent(profile, notification('interrupt', {
      approvalId: 'a1', senseName: 'write_file',
      arguments: { path: '/x', content: 'y'.repeat(20000) },
      waitTime: 30000, createdAt: 123,
    })) as Notification
    const data = out.data as Record<string, unknown>
    expect(data.waitTime).toBeUndefined()
    const args = data.arguments as Record<string, unknown>
    expect(args.path).toBe('/x') // 短字段全文保留（决策结构完整）
    expect((args.content as string).length).toBeLessThan(20000) // 超长字段截断
    const truncs = data.truncations as Array<{ field: string; contentLength: number; contentHash: string }>
    expect(truncs.length).toBe(1)
    expect(truncs[0]!.field).toBe('arguments.content')
    expect(truncs[0]!.contentHash).toMatch(/^[0-9a-f]{64}$/) // sha256 引用可校验
  })

  it('done 投影：去 contextBreakdown，finalMessage 超限截断', () => {
    const long = 'x'.repeat(8000)
    const out = applyLiteEvent(profile, notification('done', {
      finalMessage: { msgId: 'm1', content: long, agentChatId: 'c1' },
      canResume: true, used: 1, total: 2, contextBreakdown: { a: 1 },
    })) as Notification
    const data = out.data as Record<string, unknown>
    expect(data.canResume).toBe(true)
    expect(data.used).toBeUndefined()
    expect(data.contextBreakdown).toBeUndefined()
    const fm = data.finalMessage as Record<string, unknown>
    expect(fm.contentLength).toBe(8000)
    expect((fm.content as string).length).toBeLessThan(8000)
    expect(Buffer.byteLength(fm.content as string, 'utf8')).toBeLessThanOrEqual(4096 - 256)
    expect(fm.contentHash).toMatch(/^[0-9a-f]{64}$/) // boundedContent 截断引用（与 T16 格式一致）
  })

  it('consumed 去 content 附 msgId（D10）', () => {
    const out = applyLiteEvent(profile, notification('consumed', {
      count: 1, messages: [{ id: 'm1', role: 'user', createdAt: 1, content: '全文', msgId: 'm1' }],
    })) as Notification
    const data = out.data as Record<string, unknown>
    expect((data.messages as Array<Record<string, unknown>>)[0].content).toBeUndefined()
    expect((data.messages as Array<Record<string, unknown>>)[0].msgId).toBe('m1')
  })

  it('timeline.patch：upsert node 投影为 LeanTimelineNode，edges 不下发（D7）', () => {
    const node = {
      id: 'n1', kind: 'message',
      actor: { kind: 'agent', chatId: 'c1', roleType: 'helper' },
      direction: 'agent-to-user', orderKey: 5, status: 'committed', createdAt: 1,
      content: '很长'.repeat(300), thinking: 'x', toolCalls: [{ name: 'read_file', arguments: '{}' }],
    }
    const out = applyLiteEvent(profile, notification('timeline.patch', {
      chatId: 'c1', baseRevision: 1, revision: 2,
      rootPatch: {
        rootChatId: 'c1', view: 'conversation', baseRevision: 1, revision: 2,
        operations: [
          { type: 'upsert', node },
          { type: 'upsert-edge', edge: { id: 'e1' } },
          { type: 'revoke', nodeId: 'n0' },
        ],
      },
    })) as Notification
    const rootPatch = (out.data as Record<string, unknown>).rootPatch as Record<string, unknown>
    const ops = rootPatch.operations as Array<Record<string, unknown>>
    expect(ops).toHaveLength(2) // edge 不下发
    const lean = ops[0].node as Record<string, unknown>
    expect(lean.summary).toBeDefined()
    expect(Buffer.byteLength(lean.summary as string, 'utf8')).toBeLessThanOrEqual(180)
    expect(lean.contentHash).toMatch(/^[0-9a-f]{64}$/) // 截断时附 sha256 引用（统一 boundedContent）
    expect(lean.contentLength).toBe('很长'.repeat(300).length)
    expect(lean.toolNames).toEqual(['read_file'])
    expect(lean.actorKind).toBe('agent')
    expect(lean.actorRoleType).toBe('helper')
    expect(lean.direction).toBe('agent-to-user')
    expect(lean.content).toBeUndefined()
    expect(lean.thinking).toBeUndefined()
    expect(ops[1]).toEqual({ type: 'revoke', nodeId: 'n0' })
  })
})

describe('lite 白名单矩阵：原样透传类（信封仍最小化）', () => {
  const passthrough = [
    ['run.updated', { runId: 'r1', status: 'running' as const }],
    ['turn.started', { turnId: 't1', messageId: 't1', createdAt: 1 }],
    ['turn.completed', { turnId: 't1', messageId: 't1' }],
    ['question_batch_completed', { batchId: 'b1' }],
    ['error', { message: '[abc12345] 出错了', canResume: true }],
    ['question_batch_requested', { batchId: 'b1', questions: [{ questionId: 'q1', question: '题干', options: [{ label: 'A' }] }] }],
  ] as const
  for (const [type, data] of passthrough) {
    it(`${type} 透传且 data 不改写`, () => {
      const out = applyLiteEvent(profile, notification(type, data, { requestId: 'r9' })) as Notification
      expect(out.type).toBe(type)
      expect(out.data).toEqual(data)
    })
  }
  it('interaction.changed 透传', () => {
    const out = applyLiteEvent(profile, notification('interaction.changed', {
      interactionId: 'i1', status: 'pending', revision: 1, presetId: 'p1',
    }, { requestId: 'r9' })) as Notification
    expect(out.data).toEqual({ interactionId: 'i1', status: 'pending', revision: 1, presetId: 'p1' })
  })
})

describe('信封最小化（§3.8）', () => {
  it('省略 requestId/subscriptionId/eventSeq/rootEventSeq/sourceEventSeq，保留 type/chatId/runId/seq', () => {
    const out = applyLiteEvent(profile, notification('run.updated', { runId: 'run-1', status: 'running' }, {
      requestId: 'req-1', chatId: 'chat-1', runId: 'run-1', seq: 42,
      subscriptionId: 'sub-1', eventSeq: 7, rootEventSeq: 8, sourceEventSeq: 9,
    })) as Record<string, unknown>
    expect(out.requestId).toBeUndefined()
    expect(out.subscriptionId).toBeUndefined()
    expect(out.eventSeq).toBeUndefined()
    expect(out.rootEventSeq).toBeUndefined()
    expect(out.sourceEventSeq).toBeUndefined()
    expect(out.type).toBe('run.updated')
    expect(out.chatId).toBe('chat-1')
    expect(out.runId).toBe('run-1')
    expect(out.seq).toBe(42)
  })

  it('data.runId 与信封 runId 去重（T7 修正①）', () => {
    const out = applyLiteEvent(profile, notification('run.updated', { runId: 'run-1', status: 'running' }, { runId: 'run-1' })) as Record<string, unknown>
    expect((out.data as Record<string, unknown>).runId).toBeUndefined()
    expect(out.runId).toBe('run-1')
  })
})

describe('applyLiteResponse：timeline 投影', () => {
  const node = {
    id: 'n1', kind: 'message', actor: { kind: 'user', actorId: 'human' },
    direction: 'user-to-agent', orderKey: 1, status: 'committed', createdAt: 1,
    content: 'hello', toolCalls: [], thinking: 'secret',
  }
  it('timeline.get/open 响应 rootTimeline.nodes 投影为 lean、edges 置空', () => {
    const response = {
      id: 'a1', kind: 'response', requestId: 'r1', success: true,
      data: { chatId: 'c1', revision: 2, rootTimeline: { rootChatId: 'c1', revision: 2, nodes: [node], edges: [{ id: 'e1' }], generations: [] } },
    }
    const out = applyLiteResponse(profile, response) as Record<string, unknown>
    const timeline = ((out.data as Record<string, unknown>).rootTimeline) as Record<string, unknown>
    const lean = (timeline.nodes as Array<Record<string, unknown>>)[0]
    expect(lean.summary).toBe('hello')
    expect(lean.contentHash).toBeUndefined() // 未截断不附引用
    expect(lean.content).toBeUndefined()
    expect(lean.thinking).toBeUndefined()
    expect(timeline.edges).toEqual([])
  })

  it('非 timeline 响应原样返回', () => {
    const response = { id: 'a1', kind: 'response', requestId: 'r1', success: true, data: { chats: [] } }
    expect(applyLiteResponse(profile, response)).toBe(response)
  })

  it('失败响应原样返回', () => {
    const response = { id: 'a1', kind: 'response', requestId: 'r1', success: false, error: { code: 'INTERNAL', message: 'x' } }
    expect(applyLiteResponse(profile, response)).toBe(response)
  })
})

describe('parseLiteProfile', () => {
  it('?profile=lite&v=1 → LiteProfile（缺省 maxFrameBytes=4096 turnDelta=false）', () => {
    expect(parseLiteProfile('/?profile=lite&v=1')).toEqual({
      kind: 'lite', v: 1, maxFrameBytes: 4096, turnDelta: false,
    })
  })
  it('自定义 maxFrameBytes/turnDelta', () => {
    expect(parseLiteProfile('/?profile=lite&v=1&maxFrameBytes=2048&turnDelta=1')).toEqual({
      kind: 'lite', v: 1, maxFrameBytes: 2048, turnDelta: true,
    })
  })
  it('未知版本 → unsupported', () => {
    expect(parseLiteProfile('/?profile=lite&v=2')).toBe('unsupported')
    expect(parseLiteProfile('/?profile=lite&v=abc')).toBe('unsupported')
  })
  it('无 profile / 无 v（默认 v1）', () => {
    expect(parseLiteProfile('/')).toBeUndefined()
    expect(parseLiteProfile(undefined)).toBeUndefined()
    expect(parseLiteProfile('/?profile=lite')).toEqual({ kind: 'lite', v: 1, maxFrameBytes: 4096, turnDelta: false })
  })
  it('多余参数/大小写容错', () => {
    expect(parseLiteProfile('/?foo=1&profile=lite&v=1&bar=2')?.kind ?? parseLiteProfile('/?foo=1&profile=lite&v=1&bar=2')).toBe('lite' as const)
    // PROFILE 大小写不同视为不同参数名（URLSearchParams 精确匹配）→ 非 lite
    expect(parseLiteProfile('/?PROFILE=lite&v=1')).toBeUndefined()
  })
})

describe('非 lite 零影响', () => {
  it('applyLiteEvent/applyLiteResponse 为纯 lite 函数——非 lite 由调用方短路（此处验证投影器自身不误伤非目标形态）', () => {
    // 非 notification/chunk 的其他对象原样返回（防御）
    const passthroughObj = { kind: 'pong' }
    expect(applyLiteEvent(profile, passthroughObj)).toBe(passthroughObj)
  })
})
