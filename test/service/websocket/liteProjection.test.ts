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

function notification(
  type: string,
  data: unknown,
  extra: Record<string, unknown> = {},
): Notification {
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
    const delta = notification('turn.delta', {
      turnId: 't1',
      messageId: 't1',
      channel: 'content',
      offset: 0,
      delta: 'x',
      runId: 'r1',
      extra: 'noise',
    })
    expect(applyLiteEvent(profile, delta)).toBeUndefined()
    const out = applyLiteEvent(turnDeltaProfile, delta) as Notification
    expect(out.data).toEqual({
      turnId: 't1',
      messageId: 't1',
      channel: 'content',
      offset: 0,
      delta: 'x',
    })
  })

  it('turn.delta 小增量（≤512B）单帧直发', () => {
    const small = notification('turn.delta', {
      turnId: 't1',
      messageId: 't1',
      channel: 'content',
      offset: 10,
      delta: '短增量',
    })
    const out = applyLiteEvent(turnDeltaProfile, small)
    expect(Array.isArray(out)).toBe(false)
    expect((out as Notification).data).toEqual({
      turnId: 't1',
      messageId: 't1',
      channel: 'content',
      offset: 10,
      delta: '短增量',
    })
  })

  it('turn.delta 超预算分片：每帧 ≤512B、不撕裂多字节、offset 字符数连续', () => {
    // 200 个中文 = 600 字节，必然分片
    const big = '汉'.repeat(200)
    const out = applyLiteEvent(
      turnDeltaProfile,
      notification('turn.delta', {
        turnId: 't1',
        messageId: 't1',
        channel: 'content',
        offset: 5,
        delta: big,
      }),
    )
    expect(Array.isArray(out)).toBe(true)
    const frames = (out as Array<Notification>).map((f) => f.data as Record<string, unknown>)
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
    const out = applyLiteEvent(
      profile,
      notification('input.updated', {
        inputId: 'i1',
        state: 'started',
        queueSequence: 1,
        content: '很长的用户输入全文……'.repeat(20),
        acceptedAt: 1,
      }),
    ) as Notification
    const data = out.data as Record<string, unknown>
    expect(data.content).toBeUndefined()
    expect(data.inputId).toBe('i1')
    expect(data.state).toBe('started')
  })

  it('sense_started 去 arguments（工具名级）', () => {
    const out = applyLiteEvent(
      profile,
      notification('sense_started', {
        id: 's1',
        senseName: 'read_file',
        arguments: '{...}',
      }),
    ) as Notification
    expect(out.data).toEqual({ id: 's1', senseName: 'read_file' })
  })

  it('accept/rejected 去 result 全文', () => {
    const out = applyLiteEvent(
      profile,
      notification('accept', {
        approvalId: 'a1',
        senseName: 'read_file',
        ok: true,
        result: 'x'.repeat(40000),
      }),
    ) as Notification
    expect(out.data).toEqual({ approvalId: 'a1', senseName: 'read_file', ok: true })
  })

  it('role_created 去 prompt/brain/senseGroup', () => {
    const out = applyLiteEvent(
      profile,
      notification('role_created', {
        taskId: 't1',
        childChatId: 'c1',
        parentChatId: 'p1',
        type: 'spawn_role',
        wake: 'immediate',
        prompt: '长任务描述',
        brain: 'longcat',
        senseGroup: 'safe',
      }),
    ) as Notification
    expect(out.data).toEqual({
      taskId: 't1',
      childChatId: 'c1',
      parentChatId: 'p1',
      type: 'spawn_role',
      wake: 'immediate',
    })
  })

  it('interrupt 全量但剔 waitTime/createdAt（C5，deadlineAt 单源）', () => {
    const out = applyLiteEvent(
      profile,
      notification('interrupt', {
        approvalId: 'a1',
        senseName: 'write_file',
        arguments: { path: '/x' },
        waitTime: 30000,
        createdAt: 1234567890,
      }),
    ) as Notification
    const data = out.data as Record<string, unknown>
    expect(data.waitTime).toBeUndefined()
    expect(data.createdAt).toBeUndefined()
    expect(data.approvalId).toBe('a1')
    expect(data.arguments).toEqual({ path: '/x' })
  })

  it('done 投影：contextUsage 为 number 直接透传（修复：非 ratio 对象）', () => {
    const out = applyLiteEvent(
      profile,
      notification('done', {
        contextUsage: 0.42,
        used: 1,
        total: 2,
        contextBreakdown: { a: 1 },
        canResume: true,
      }),
    ) as Notification
    const data = out.data as Record<string, unknown>
    expect(data.contextUsage).toBe(0.42)
    expect(data.used).toBeUndefined()
    expect(data.contextBreakdown).toBeUndefined()
  })

  it('interrupt：超长单字段截断并附 truncations 引用（D3 字段级智能截断）', () => {
    const out = applyLiteEvent(
      profile,
      notification('interrupt', {
        approvalId: 'a1',
        senseName: 'write_file',
        arguments: { path: '/x', content: 'y'.repeat(20000) },
        waitTime: 30000,
        createdAt: 123,
      }),
    ) as Notification
    const data = out.data as Record<string, unknown>
    expect(data.waitTime).toBeUndefined()
    const args = data.arguments as Record<string, unknown>
    expect(args.path).toBe('/x') // 短字段全文保留（决策结构完整）
    expect((args.content as string).length).toBeLessThan(20000) // 超长字段截断
    const truncs = data.truncations as Array<{
      field: string
      contentLength: number
      contentHash: string
    }>
    expect(truncs.length).toBe(1)
    expect(truncs[0]!.field).toBe('arguments.content')
    expect(truncs[0]!.contentHash).toMatch(/^[0-9a-f]{64}$/) // sha256 引用可校验
  })

  it('done 投影：去 contextBreakdown，finalMessage 超限截断', () => {
    const long = 'x'.repeat(8000)
    const out = applyLiteEvent(
      profile,
      notification('done', {
        finalMessage: { msgId: 'm1', content: long, agentChatId: 'c1' },
        canResume: true,
        used: 1,
        total: 2,
        contextBreakdown: { a: 1 },
      }),
    ) as Notification
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
    const out = applyLiteEvent(
      profile,
      notification('consumed', {
        count: 1,
        messages: [{ id: 'm1', role: 'user', createdAt: 1, content: '全文', msgId: 'm1' }],
      }),
    ) as Notification
    const data = out.data as Record<string, unknown>
    expect((data.messages as Array<Record<string, unknown>>)[0].content).toBeUndefined()
    expect((data.messages as Array<Record<string, unknown>>)[0].msgId).toBe('m1')
  })

  it('timeline.patch：upsert node 投影为 LeanTimelineNode，edges 不下发（D7）', () => {
    const node = {
      id: 'n1',
      kind: 'message',
      actor: { kind: 'agent', chatId: 'c1', roleType: 'helper' },
      direction: 'agent-to-user',
      orderKey: 5,
      status: 'committed',
      createdAt: 1,
      content: '很长'.repeat(300),
      thinking: 'x',
      toolCalls: [{ name: 'read_file', arguments: '{}' }],
    }
    const out = applyLiteEvent(
      profile,
      notification('timeline.patch', {
        chatId: 'c1',
        baseRevision: 1,
        revision: 2,
        rootPatch: {
          rootChatId: 'c1',
          view: 'conversation',
          baseRevision: 1,
          revision: 2,
          operations: [
            { type: 'upsert', node },
            { type: 'upsert-edge', edge: { id: 'e1' } },
            { type: 'revoke', nodeId: 'n0' },
          ],
        },
      }),
    ) as Notification
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
    [
      'run.outcome',
      {
        status: 'paused' as const,
        reasonCode: 'RUN_LOOP_LIMIT_REACHED',
        canResume: true,
        retryable: false,
        occurredAt: 2,
        feedback: {
          code: 'RUN_LOOP_LIMIT_REACHED',
          severity: 'warning' as const,
          source: 'system' as const,
          title: '已达到循环上限',
          description: '运行现场已保留。',
          guidance: '可以继续运行或调整循环上限。',
          actions: [
            { type: 'resume_run' as const },
            { type: 'open_settings' as const, section: 'limits' as const },
          ],
          retention: 'history' as const,
        },
      },
    ],
    ['turn.started', { turnId: 't1', messageId: 't1', createdAt: 1 }],
    ['turn.cancelled', { turnId: 't1', messageId: 't1', reason: 'retry_reset' as const }],
    ['turn.completed', { turnId: 't1', messageId: 't1' }],
    ['question_batch_completed', { batchId: 'b1' }],
    ['error', { message: '[abc12345] 出错了', canResume: true }],
    [
      'question_batch_requested',
      {
        batchId: 'b1',
        questions: [{ questionId: 'q1', question: '题干', options: [{ label: 'A' }] }],
      },
    ],
  ] as const
  for (const [type, data] of passthrough) {
    it(`${type} 透传且 data 不改写`, () => {
      const out = applyLiteEvent(
        profile,
        notification(type, data, { requestId: 'r9' }),
      ) as Notification
      expect(out.type).toBe(type)
      expect(out.data).toEqual(data)
    })
  }
  it('interaction.changed 透传', () => {
    const out = applyLiteEvent(
      profile,
      notification(
        'interaction.changed',
        {
          interactionId: 'i1',
          status: 'pending',
          revision: 1,
          presetId: 'p1',
        },
        { requestId: 'r9' },
      ),
    ) as Notification
    expect(out.data).toEqual({
      interactionId: 'i1',
      status: 'pending',
      revision: 1,
      presetId: 'p1',
    })
  })
})

describe('信封最小化（§3.8）', () => {
  it('省略 requestId/subscriptionId/eventSeq/rootEventSeq/sourceEventSeq，保留 type/chatId/runId/seq', () => {
    const out = applyLiteEvent(
      profile,
      notification(
        'run.updated',
        { runId: 'run-1', status: 'running' },
        {
          requestId: 'req-1',
          chatId: 'chat-1',
          runId: 'run-1',
          seq: 42,
          subscriptionId: 'sub-1',
          eventSeq: 7,
          rootEventSeq: 8,
          sourceEventSeq: 9,
        },
      ),
    ) as Record<string, unknown>
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
    const out = applyLiteEvent(
      profile,
      notification('run.updated', { runId: 'run-1', status: 'running' }, { runId: 'run-1' }),
    ) as Record<string, unknown>
    expect((out.data as Record<string, unknown>).runId).toBeUndefined()
    expect(out.runId).toBe('run-1')
  })
})

describe('applyLiteResponse：timeline 投影', () => {
  const node = {
    id: 'n1',
    kind: 'message',
    actor: { kind: 'user', actorId: 'human' },
    direction: 'user-to-agent',
    orderKey: 1,
    status: 'committed',
    createdAt: 1,
    content: 'hello',
    toolCalls: [],
    thinking: 'secret',
  }
  it('timeline.get/open 响应 rootTimeline.nodes 投影为 lean、edges 置空', () => {
    const response = {
      id: 'a1',
      kind: 'response',
      requestId: 'r1',
      success: true,
      data: {
        chatId: 'c1',
        revision: 2,
        rootTimeline: {
          rootChatId: 'c1',
          revision: 2,
          nodes: [node],
          edges: [{ id: 'e1' }],
          generations: [],
        },
      },
    }
    const out = applyLiteResponse(profile, response) as Record<string, unknown>
    const timeline = (out.data as Record<string, unknown>).rootTimeline as Record<string, unknown>
    const lean = (timeline.nodes as Array<Record<string, unknown>>)[0]
    expect(lean.summary).toBe('hello')
    expect(lean.contentHash).toBeUndefined() // 未截断不附引用
    expect(lean.content).toBeUndefined()
    expect(lean.thinking).toBeUndefined()
    expect(timeline.edges).toEqual([])
  })

  it('非 timeline 响应原样返回', () => {
    const response = {
      id: 'a1',
      kind: 'response',
      requestId: 'r1',
      success: true,
      data: { chats: [] },
    }
    expect(applyLiteResponse(profile, response)).toBe(response)
  })

  it('失败响应原样返回', () => {
    const response = {
      id: 'a1',
      kind: 'response',
      requestId: 'r1',
      success: false,
      error: { code: 'INTERNAL', message: 'x' },
    }
    expect(applyLiteResponse(profile, response)).toBe(response)
  })

  // ---- P1-② 游标分页（before=orderKey 排他下界 / limit / nextCursor）----
  const nodes30 = Array.from({ length: 30 }, (_, i) => ({
    id: 'n' + i,
    kind: 'message',
    actor: { kind: 'user', actorId: 'human' },
    direction: 'user-to-agent',
    orderKey: i + 1,
    status: 'committed',
    createdAt: i + 1,
    content: 'm' + i,
    toolCalls: [],
    thinking: '',
  }))
  const response30 = {
    id: 'a2',
    kind: 'response',
    requestId: 'r2',
    success: true,
    data: {
      chatId: 'c1',
      revision: 2,
      rootTimeline: { rootChatId: 'c1', revision: 2, nodes: nodes30, edges: [], generations: [] },
    },
  }
  function pageOf(out: Record<string, unknown>): Array<Record<string, unknown>> {
    return ((out.data as Record<string, unknown>).rootTimeline as Record<string, unknown>)
      .nodes as Array<Record<string, unknown>>
  }
  function timelineOf(out: Record<string, unknown>): Record<string, unknown> {
    return (out.data as Record<string, unknown>).rootTimeline as Record<string, unknown>
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
    const out = applyLiteResponse(profile, response30, { before: 21, limit: 5 }) as Record<
      string,
      unknown
    >
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
    id: 'n' + i,
    kind: 'message',
    actor: { kind: 'user', actorId: 'human' },
    direction: 'user-to-agent',
    orderKey: i + 1,
    status: 'committed',
    createdAt: i + 1,
    content: '内容'.repeat(60), // summary 顶满 180B → 单 lean 节点 ≈400+B
    toolCalls: [],
    thinking: '',
  }))
  const fatResponse = {
    id: 'a3',
    kind: 'response',
    requestId: 'r3',
    success: true,
    data: {
      chatId: 'c1',
      revision: 2,
      rootTimeline: { rootChatId: 'c1', revision: 2, nodes: fatNodes, edges: [], generations: [] },
    },
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
    const cursor = timelineOf(first).nextCursor as number
    const second = applyLiteResponse(tinyProfile, fatResponse, { before: cursor }) as Record<
      string,
      unknown
    >
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

  it('T30：二次预算收缩后 nextCursor 对齐当前保留页最小 orderKey', () => {
    const baseline = applyLiteResponse(tinyProfile, fatResponse) as Record<string, unknown>
    const responseWithRunning = {
      ...fatResponse,
      data: {
        ...fatResponse.data,
        state: {
          executionSteps: Array.from({ length: 4 }, (_, index) => ({
            id: `running-${index}`,
            runId: 'run-budget',
            chatId: 'c1',
            kind: 'tool',
            name: `tool-${index}-${'长名称'.repeat(20)}`,
            status: 'running',
            startedAt: index + 1,
          })),
        },
      },
    }
    const out = applyLiteResponse(tinyProfile, responseWithRunning, {
      executionStepLimit: 4,
    }) as Record<string, unknown>
    const page = pageOf(out)
    const timeline = timelineOf(out)

    expect(page.length).toBeGreaterThanOrEqual(1)
    expect(page.length).toBeLessThan(pageOf(baseline).length)
    expect(timeline.hasMore).toBe(true)
    expect(timeline.nextCursor).toBe(page[0].orderKey)
  })

  it('executionSteps 默认 16 项、保留活动步骤并与 maxFrameBytes 同时生效', () => {
    const steps = Array.from({ length: 24 }, (_, index) => ({
      id: `step-${index}`,
      runId: 'run-1',
      chatId: index % 2 === 0 ? 'root' : 'child',
      kind: index % 3 === 0 ? 'tool' : 'model',
      name: `tool-${index}-${'长名称'.repeat(20)}`,
      status: index === 0 || index === 23 ? 'running' : 'completed',
      startedAt: index + 1,
      ...(index === 0 || index === 23 ? {} : { completedAt: index + 2 }),
    }))
    const response = {
      id: 'steps-1',
      kind: 'response',
      requestId: 'steps-request',
      success: true,
      data: {
        chatId: 'root',
        state: {
          pendingInputs: [],
          activeTurns: [],
          questionBatches: [],
          runningTools: [],
          executionSteps: steps,
          roles: [],
        },
      },
    }
    const out = applyLiteResponse(tinyProfile, response) as Record<string, unknown>
    const state = (out.data as Record<string, unknown>).state as Record<string, unknown>
    const projected = state.executionSteps as Array<Record<string, unknown>>
    expect(projected.length).toBeLessThanOrEqual(16)
    expect(projected.some((step) => step.id === 'step-0' && step.status === 'running')).toBe(true)
    expect(projected.some((step) => step.id === 'step-23' && step.status === 'running')).toBe(true)
    expect(
      projected.every(
        (step) => step.name === undefined || Buffer.byteLength(String(step.name), 'utf8') <= 96,
      ),
    ).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(out), 'utf8')).toBeLessThanOrEqual(2048)
  })

  it('executionStepLimit 是显式数量上界，时间字段在 lean state 中保留', () => {
    const response = {
      id: 'steps-2',
      kind: 'response',
      requestId: 'steps-request-2',
      success: true,
      data: {
        chatId: 'root',
        state: {
          executionSteps: Array.from({ length: 8 }, (_, index) => ({
            id: `step-${index}`,
            runId: 'run-2',
            chatId: 'root',
            kind: 'tool',
            name: 'read_file',
            status: 'completed',
            startedAt: index * 10,
            completedAt: index * 10 + 5,
          })),
        },
      },
    }
    const out = applyLiteResponse(profile, response, { executionStepLimit: 3 }) as Record<
      string,
      unknown
    >
    const state = (out.data as Record<string, unknown>).state as Record<string, unknown>
    const projected = state.executionSteps as Array<Record<string, unknown>>
    expect(projected.map((step) => step.id)).toEqual(['step-5', 'step-6', 'step-7'])
    expect(projected[0]).toMatchObject({ startedAt: 50, completedAt: 55 })
  })

  it('executionStepLimit 在 running 数量超限时严格保留最新活动步骤', () => {
    const response = {
      id: 'steps-running-limit',
      kind: 'response',
      requestId: 'steps-running-limit-request',
      success: true,
      data: {
        chatId: 'root',
        state: {
          executionSteps: Array.from({ length: 6 }, (_, index) => ({
            id: `running-${index}`,
            runId: 'run-running-limit',
            chatId: 'root',
            kind: 'tool',
            name: `tool-${index}`,
            status: 'running',
            startedAt: index + 1,
          })),
        },
      },
    }
    const out = applyLiteResponse(profile, response, { executionStepLimit: 3 }) as Record<
      string,
      unknown
    >
    const state = (out.data as Record<string, unknown>).state as Record<string, unknown>
    const projected = state.executionSteps as Array<Record<string, unknown>>

    expect(projected.map((step) => step.id)).toEqual(['running-3', 'running-4', 'running-5'])
  })

  it('16 个 running 步骤在 2048B 预算下收缩并保留最新活动项', () => {
    const response = {
      id: 'steps-running-budget',
      kind: 'response',
      requestId: 'steps-running-budget-request',
      success: true,
      data: {
        chatId: 'root',
        state: {
          executionSteps: Array.from({ length: 16 }, (_, index) => ({
            id: `running-budget-${index}`,
            runId: 'run-running-budget',
            chatId: 'root',
            kind: 'tool',
            name: `tool-${index}-${'长名称'.repeat(30)}`,
            status: 'running',
            startedAt: index + 1,
          })),
        },
      },
    }

    const out = applyLiteResponse(tinyProfile, response) as Record<string, unknown>
    const state = (out.data as Record<string, unknown>).state as Record<string, unknown>
    const projected = state.executionSteps as Array<Record<string, unknown>>

    expect(Buffer.byteLength(JSON.stringify(out), 'utf8')).toBeLessThanOrEqual(2048)
    expect(projected.length).toBeGreaterThanOrEqual(1)
    expect(projected.length).toBeLessThan(16)
    expect(projected.at(-1)?.id).toBe('running-budget-15')
  })
})

describe('applyLiteResponse：node.get 精确帧预算与真实游标', () => {
  const method = 'chat.timeline.node.get'

  function responseForNode(node: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    return {
      id: 'node-detail-response',
      kind: 'response',
      requestId: 'node-detail-request',
      success: true,
      data: {
        rootChatId: 'root',
        node: { id: 'node-1', ...node },
        refs: [],
        hasMore: false,
        ...extra,
      },
    }
  }

  function safePage(text: string, offset: number, limit: number): string {
    let end = Math.min(text.length, offset + limit)
    const last = end > offset ? text.charCodeAt(end - 1) : 0
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end++
    return text.slice(offset, end)
  }

  for (const maxFrameBytes of [512, 2048]) {
    it(`${maxFrameBytes}B：JSON 转义与超长 Unicode 正文按实际 UTF-16 nextOffset 连续重组`, () => {
      const constrained: LiteProfile = { ...profile, maxFrameBytes }
      const full = '引号"\\换行\n😀中'.repeat(180)
      let offset = 0
      let rebuilt = ''
      for (let guard = 0; guard < 200; guard++) {
        const source = safePage(full, offset, 256)
        const raw = responseForNode(
          { content: source },
          { hasMore: offset + source.length < full.length },
        )
        const out = applyLiteResponse(
          constrained,
          raw,
          { sections: ['content'], offset, limit: 256 },
          method,
        ) as Record<string, unknown>
        expect(Buffer.byteLength(JSON.stringify(out), 'utf8')).toBeLessThanOrEqual(maxFrameBytes)
        const data = out.data as Record<string, unknown>
        const node = data.node as Record<string, unknown>
        const page = data.page as Record<string, unknown>
        const chunk = String(node.content ?? '')
        expect(page.offset).toBe(offset)
        expect(page.consumed).toBe(chunk.length)
        expect(chunk).not.toMatch(/[\uD800-\uDBFF]$/)
        rebuilt += chunk
        if (page.nextOffset === undefined) break
        const next = Number(page.nextOffset)
        expect(next).toBe(offset + chunk.length)
        expect(next).toBeGreaterThan(offset)
        offset = next
      }
      expect(rebuilt).toBe(full)
    })
  }

  it('thinking 使用独立 UTF-16 offset，恰好整页只产生一次空终页探测', () => {
    const constrained: LiteProfile = { ...profile, maxFrameBytes: 512 }
    const full = '😀'.repeat(128) // 256 UTF-16 code units，恰好命中请求 limit
    const first = applyLiteResponse(
      constrained,
      responseForNode({ thinking: full }),
      { sections: ['thinking'], offset: 0, limit: 256 },
      method,
    ) as Record<string, unknown>
    const firstData = first.data as Record<string, unknown>
    const firstPage = firstData.page as Record<string, unknown>
    expect(firstPage.nextOffset).toBeDefined()
    const nextOffset = Number(firstPage.nextOffset)

    const terminal = applyLiteResponse(
      constrained,
      responseForNode({ thinking: '' }),
      { sections: ['thinking'], offset: nextOffset, limit: 256 },
      method,
    ) as Record<string, unknown>
    const terminalData = terminal.data as Record<string, unknown>
    const terminalPage = terminalData.page as Record<string, unknown>
    expect(terminalData.hasMore).toBe(false)
    expect(terminalPage.nextOffset).toBeUndefined()
    expect(terminalPage.consumed).toBe(0)
  })

  it('toolCalls 跨数组、arguments/result 字段连续分页且每帧 ≤512B', () => {
    const constrained: LiteProfile = { ...profile, maxFrameBytes: 512 }
    const calls = Array.from({ length: 40 }, (_, index) => ({
      callId: `call-${index}`,
      index,
      name: `tool_${index}`,
      status: 'completed',
      arguments: `{"路径":"C:\\\\${index}","值":"😀"}`.repeat(12),
      result: `结果"${index}\\😀`.repeat(18),
    }))
    type Cursor = { callIndex: number; field: 'arguments' | 'result'; offset: number }
    let cursor: Cursor | undefined = { callIndex: 0, field: 'arguments', offset: 0 }
    const rebuilt = calls.map(() => ({ arguments: '', result: '' }))
    for (let guard = 0; cursor && guard < 1000; guard++) {
      const call = calls[cursor.callIndex]!
      const fieldText = call[cursor.field]
      const chunk = safePage(fieldText, cursor.offset, 256)
      const end = cursor.offset + chunk.length
      const handlerNext: Cursor | undefined =
        end < fieldText.length
          ? { ...cursor, offset: end }
          : cursor.field === 'arguments'
            ? { callIndex: cursor.callIndex, field: 'result', offset: 0 }
            : cursor.callIndex + 1 < calls.length
              ? { callIndex: cursor.callIndex + 1, field: 'arguments', offset: 0 }
              : undefined
      const raw = responseForNode(
        {
          toolCalls: [
            {
              callId: call.callId,
              index: call.index,
              name: call.name,
              status: call.status,
              arguments: cursor.field === 'arguments' ? chunk : '',
              ...(cursor.field === 'result' ? { result: chunk } : {}),
            },
          ],
        },
        {
          hasMore: !!handlerNext,
          page: {
            section: 'toolCalls',
            cursor,
            consumed: chunk.length,
            ...(handlerNext ? { nextCursor: handlerNext } : {}),
          },
        },
      )
      const out = applyLiteResponse(
        constrained,
        raw,
        { sections: ['toolCalls'], limit: 256, toolCursor: cursor },
        method,
      ) as Record<string, unknown>
      expect(Buffer.byteLength(JSON.stringify(out), 'utf8')).toBeLessThanOrEqual(512)
      const data = out.data as Record<string, unknown>
      const node = data.node as Record<string, unknown>
      const page = data.page as Record<string, unknown>
      const pageCursor = page.cursor as Cursor
      const pageCalls = node.toolCalls as Array<Record<string, unknown>>
      expect(pageCalls.length).toBeLessThanOrEqual(1)
      const returned = pageCalls[0] ? String(pageCalls[0]![pageCursor.field] ?? '') : ''
      rebuilt[pageCursor.callIndex]![pageCursor.field] += returned
      const next = page.nextCursor as Cursor | undefined
      if (next) {
        expect(JSON.stringify(next)).not.toBe(JSON.stringify(cursor))
      }
      cursor = next
    }
    expect(cursor).toBeUndefined()
    expect(rebuilt).toEqual(
      calls.map((call) => ({ arguments: call.arguments, result: call.result })),
    )
  })

  it('node.get 失败响应在 512B 内精确收缩 message，并保留正常 correlation', () => {
    const constrained: LiteProfile = { ...profile, maxFrameBytes: 512 }
    const raw = {
      id: 'normal-response-id',
      kind: 'response',
      requestId: 'normal-request-id',
      success: false,
      error: { code: 'NODE_NOT_FOUND', message: '失败"\\\n😀'.repeat(400) },
    }

    const out = applyLiteResponse(constrained, raw, undefined, method) as Record<string, unknown>
    const error = out.error as Record<string, unknown>

    expect(Buffer.byteLength(JSON.stringify(out), 'utf8')).toBeLessThanOrEqual(512)
    expect(out.id).toBe(raw.id)
    expect(out.requestId).toBe(raw.requestId)
    expect(out.success).toBe(false)
    expect(error.code).toBe('NODE_NOT_FOUND')
    expect(String(error.message).length).toBeLessThan(raw.error.message.length)
  })

  it('异常超长 correlation 稳定降级为 sha256 标识，且失败信封字段完整', () => {
    const constrained: LiteProfile = { ...profile, maxFrameBytes: 512 }
    const raw = {
      id: 'id"\\\n😀'.repeat(100),
      kind: 'response',
      requestId: 'request"\\\n😀'.repeat(100),
      success: false,
      error: { code: 'INTERNAL', message: 'x'.repeat(2000) },
    }

    const first = applyLiteResponse(constrained, raw, undefined, method) as Record<string, unknown>
    const second = applyLiteResponse(constrained, raw, undefined, method) as Record<string, unknown>

    expect(Buffer.byteLength(JSON.stringify(first), 'utf8')).toBeLessThanOrEqual(512)
    expect(first).toHaveProperty('id')
    expect(first).toHaveProperty('requestId')
    expect(first.id).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(first.requestId).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(first.id).not.toBe(raw.id)
    expect(first.requestId).not.toBe(raw.requestId)
    expect(first.id).toBe(second.id)
    expect(first.requestId).toBe(second.requestId)
    expect(first.success).toBe(false)
  })

  it('toolCalls 基础 metadata 无法装入 512B 时返回有界失败，不伪造不可续拉成功页', () => {
    const constrained: LiteProfile = { ...profile, maxFrameBytes: 512 }
    const raw = responseForNode(
      {
        toolCalls: [
          {
            callId: 'call-'.repeat(100),
            index: 0,
            name: 'tool-'.repeat(100),
            status: 'completed',
            arguments: '{}',
          },
        ],
      },
      {
        page: {
          section: 'toolCalls',
          cursor: { callIndex: 0, field: 'arguments', offset: 0 },
          consumed: 2,
        },
      },
    )

    const out = applyLiteResponse(
      constrained,
      raw,
      { sections: ['toolCalls'], toolCursor: { callIndex: 0, field: 'arguments', offset: 0 } },
      method,
    ) as Record<string, unknown>

    expect(Buffer.byteLength(JSON.stringify(out), 'utf8')).toBeLessThanOrEqual(512)
    expect(out.success).toBe(false)
    expect(out.data).toBeUndefined()
    expect(out.error).toMatchObject({ code: 'INTERNAL' })
  })

  it('仅显式 node.get 方法命中详情投影，其他响应保持同一对象引用', () => {
    const raw = responseForNode({ content: 'x'.repeat(4000) })
    expect(
      applyLiteResponse(
        { ...profile, maxFrameBytes: 512 },
        raw,
        { sections: ['content'] },
        'chat.list',
      ),
    ).toBe(raw)
  })
})

describe('parseLiteProfile', () => {
  it('?profile=lite&v=1 → LiteProfile（缺省 maxFrameBytes=4096 turnDelta=false）', () => {
    expect(parseLiteProfile('/?profile=lite&v=1')).toEqual({
      kind: 'lite',
      v: 1,
      maxFrameBytes: 4096,
      turnDelta: false,
    })
  })
  it('自定义 maxFrameBytes/turnDelta', () => {
    expect(parseLiteProfile('/?profile=lite&v=1&maxFrameBytes=2048&turnDelta=1')).toEqual({
      kind: 'lite',
      v: 1,
      maxFrameBytes: 2048,
      turnDelta: true,
    })
  })
  it('未知版本 → unsupported', () => {
    expect(parseLiteProfile('/?profile=lite&v=2')).toBe('unsupported')
    expect(parseLiteProfile('/?profile=lite&v=abc')).toBe('unsupported')
  })
  it('无 profile / 无 v（默认 v1）', () => {
    expect(parseLiteProfile('/')).toBeUndefined()
    expect(parseLiteProfile(undefined)).toBeUndefined()
    expect(parseLiteProfile('/?profile=lite')).toEqual({
      kind: 'lite',
      v: 1,
      maxFrameBytes: 4096,
      turnDelta: false,
    })
  })
  it('多余参数/大小写容错', () => {
    expect(
      parseLiteProfile('/?foo=1&profile=lite&v=1&bar=2')?.kind ??
        parseLiteProfile('/?foo=1&profile=lite&v=1&bar=2'),
    ).toBe('lite' as const)
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
