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

  it('turn.delta 默认关（turnDelta=0 抑制）；开启时 data 裁剪为 channel/offset/delta/turnId/messageId', () => {
    const delta = notification('turn.delta', { turnId: 't1', messageId: 't1', channel: 'content', offset: 0, delta: 'x', runId: 'r1', extra: 'noise' })
    expect(applyLiteEvent(profile, delta)).toBeUndefined()
    const out = applyLiteEvent(turnDeltaProfile, delta) as Notification
    expect(out.data).toEqual({ turnId: 't1', messageId: 't1', channel: 'content', offset: 0, delta: 'x' })
  })

  it('turn.delta 小增量（≤512B）单帧直发', () => {
    const small = notification('turn.delta', { turnId: 't1', messageId: 't1', channel: 'content', offset: 10, delta: '短增量' })
    const out = applyLiteEvent(turnDeltaProfile, small)
    expect(Array.isArray(out)).toBe(false)
    expect((out as Notification).data).toEqual({ turnId: 't1', messageId: 't1', channel: 'content', offset: 10, delta: '短增量' })
  })

  it('turn.delta 超预算分片：每帧 ≤512B、不撕裂多字节、offset 字符数连续', () => {
    // 200 个中文 = 600 字节，必然分片
    const big = '汉'.repeat(200)
    const out = applyLiteEvent(turnDeltaProfile, notification('turn.delta', { turnId: 't1', messageId: 't1', channel: 'content', offset: 5, delta: big }))
    expect(Array.isArray(out)).toBe(true)
    const frames = (out as Array<Notification>).map(f => f.data as Record<string, unknown>)
    let reassembled = ''
    let expectedOffset = 5
    for (const f of frames) {
      const delta = f.delta as string
      expect(Buffer.byteLength(delta, 'utf8')).toBeLessThanOrEqual(512)
      expect(delta).not.toMatch(/[\uD800-\uDBFF]$/) // 不以代理对高半区结尾（不撕裂）
      expect(f.offset).toBe(expectedOffset)
      expectedOffset += delta.length // 字符数口径（与 streamMapper state.content += length 一致）
      reassembled += delta
    }
    expect(reassembled).toBe(big)
    expect(frames.length).toBeGreaterThanOrEqual(2)
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

  // ---- P1-② 游标分页（before=orderKey 排他下界 / limit / nextCursor）----
  const nodes30 = Array.from({ length: 30 }, (_, i) => ({
    id: 'n' + i, kind: 'message', actor: { kind: 'user', actorId: 'human' },
    direction: 'user-to-agent', orderKey: i + 1, status: 'committed', createdAt: i + 1,
    content: 'm' + i, toolCalls: [], thinking: '',
  }))
  const response30 = {
    id: 'a2', kind: 'response', requestId: 'r2', success: true,
    data: { chatId: 'c1', revision: 2, rootTimeline: { rootChatId: 'c1', revision: 2, nodes: nodes30, edges: [], generations: [] } },
  }
  function pageOf(out: Record<string, unknown>): Array<Record<string, unknown>> {
    return ((out.data as Record<string, unknown>).rootTimeline as Record<string, unknown>).nodes as Array<Record<string, unknown>>
  }
  function timelineOf(out: Record<string, unknown>): Record<string, unknown> {
    return ((out.data as Record<string, unknown>).rootTimeline) as Record<string, unknown>
  }

  it('无参数保持 P0 行为：最新 20 条 + nodeCount + hasMore', () => {
    const out = applyLiteResponse(profile, response30) as Record<string, unknown>
    const tl = timelineOf(out)
    expect(pageOf(out)).toHaveLength(20)
    expect(pageOf(out)[0].orderKey).toBe(11)
    expect(pageOf(out)[19].orderKey).toBe(30)
    expect(tl.nodeCount).toBe(30)
    expect(tl.hasMore).toBe(true)
  })

  it('before 游标返回更早页（排他下界）', () => {
    const out = applyLiteResponse(profile, response30, { before: 11 }) as Record<string, unknown>
    const tl = timelineOf(out)
    expect(pageOf(out)).toHaveLength(10) // orderKey 1..10
    expect(pageOf(out)[0].orderKey).toBe(1)
    expect(pageOf(out)[9].orderKey).toBe(10)
    expect(tl.hasMore).toBeUndefined() // 全部返回完
    expect(tl.nodeCount).toBe(10)
  })

  it('before + limit 自定义页大小 + nextCursor 续拉字段', () => {
    const out = applyLiteResponse(profile, response30, { before: 21, limit: 5 }) as Record<string, unknown>
    const tl = timelineOf(out)
    expect(pageOf(out)).toHaveLength(5) // orderKey 16..20
    expect(pageOf(out)[0].orderKey).toBe(16)
    expect(tl.hasMore).toBe(true)
    expect(tl.nextCursor).toBe(16)
  })

  it('越界 before（小于最小 orderKey）返回空页', () => {
    const out = applyLiteResponse(profile, response30, { before: 0 }) as Record<string, unknown>
    expect(pageOf(out)).toHaveLength(0)
    expect(timelineOf(out).nodeCount).toBe(0)
  })

  it('limit 边界：非法值回退默认 20', () => {
    const out = applyLiteResponse(profile, response30, { limit: 999 }) as Record<string, unknown>
    expect(pageOf(out)).toHaveLength(20)
    const out2 = applyLiteResponse(profile, response30, { limit: 0 }) as Record<string, unknown>
    expect(pageOf(out2)).toHaveLength(20)
  })

  // ---- T30：maxFrameBytes 自动收缩 limit（§3.7 有界负载）----
  const tinyProfile: LiteProfile = { ...profile, maxFrameBytes: 2048 } // 预算 2048-512=1536B
  const fatNodes = Array.from({ length: 30 }, (_, i) => ({
    id: 'n' + i, kind: 'message', actor: { kind: 'user', actorId: 'human' },
    direction: 'user-to-agent', orderKey: i + 1, status: 'committed', createdAt: i + 1,
    content: '内容'.repeat(60), // summary 顶满 180B → 单 lean 节点 ≈400+B
    toolCalls: [], thinking: '',
  }))
  const fatResponse = {
    id: 'a3', kind: 'response', requestId: 'r3', success: true,
    data: { chatId: 'c1', revision: 2, rootTimeline: { rootChatId: 'c1', revision: 2, nodes: fatNodes, edges: [], generations: [] } },
  }

  it('T30：小 maxFrameBytes 下页被字节装箱收缩（≤预算，从最新端保留）', () => {
    const out = applyLiteResponse(tinyProfile, fatResponse) as Record<string, unknown>
    const tl = timelineOf(out)
    const page = pageOf(out)
    expect(page.length).toBeLessThan(20) // 被收缩
    expect(page.length).toBeGreaterThanOrEqual(1) // 至少 1 节点
    // 从最新端装箱：本页最后一条 = orderKey 30
    expect(page[page.length - 1].orderKey).toBe(30)
    // 实际字节数 ≤ 预算（1536B）
    const bytes = Buffer.byteLength(JSON.stringify(page), 'utf8')
    expect(bytes).toBeLessThanOrEqual(1536)
    // 续拉链完整
    expect(tl.nodeCount).toBe(30)
    expect(tl.hasMore).toBe(true)
    expect(tl.nextCursor).toBe(page[0].orderKey)
  })

  it('T30：收缩后 nextCursor 续拉链衔接（下页 before=上页最小 orderKey）', () => {
    const first = applyLiteResponse(tinyProfile, fatResponse) as Record<string, unknown>
    const cursor = (timelineOf(first).nextCursor as number)
    const second = applyLiteResponse(tinyProfile, fatResponse, { before: cursor }) as Record<string, unknown>
    const secondPage = pageOf(second)
    expect(secondPage.length).toBeGreaterThanOrEqual(1)
    expect(Math.max(...secondPage.map((n) => n.orderKey as number))).toBeLessThan(cursor) // 排他下界，无重叠
  })

  it('T30：显式 limit=3 不被放大（min 语义），hasMore/nextCursor 仍附', () => {
    const out = applyLiteResponse(tinyProfile, fatResponse, { limit: 3 }) as Record<string, unknown>
    const tl = timelineOf(out)
    expect(pageOf(out)).toHaveLength(3)
    expect(tl.hasMore).toBe(true)
    expect(tl.nextCursor).toBe(28)
  })

  it('T30：大页响应序列化后整体不超 maxFrameBytes（含 nodeCount 等固定字段开销）', () => {
    const out = applyLiteResponse(tinyProfile, fatResponse) as Record<string, unknown>
    expect(Buffer.byteLength(JSON.stringify(out), 'utf8')).toBeLessThanOrEqual(2048 + 600) // 页内节点 ≤1536B + 信封/固定字段余量
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
