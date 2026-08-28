import { describe, expect, it, vi } from 'vitest'
import { applyLiteEvent, type LiteProfile } from '@/service/websocket/liteProjection.js'
import type { Notification } from '@/service/message/types.js'

// T26 多 agent 折叠自洽性实测：mock getRootChatId 判定根/子。
const ROOT = 'chat-root'
const CHILD = 'chat-child'
vi.mock('@/db/chat.js', () => ({
  getRootChatId: vi.fn((chatId: string) => {
    if (chatId === ROOT) return ROOT
    if (chatId === CHILD) return ROOT
    throw new Error('chat not found: ' + chatId)
  }),
}))

const profile: LiteProfile = { kind: 'lite', v: 1, maxFrameBytes: 4096, turnDelta: false }

function notification(type: string, data: unknown, chatId?: string): Notification {
  return { kind: 'notification', type, data, ...(chatId ? { chatId } : {}) } as Notification
}

describe('T26 子 chat 折叠：服务端语义', () => {
  it('子 done 整帧抑制（最终回复只认 root 维度）', () => {
    expect(applyLiteEvent(profile, notification('done', { finalMessage: { msgId: 'm', content: 'x' } }, CHILD))).toBeUndefined()
  })

  it('root done 正常投影（含 finalMessage 截断链路可达）', () => {
    const out = applyLiteEvent(profile, notification('done', { canResume: false, finalMessage: { msgId: 'm', content: '回复' } }, ROOT))
    expect(out).toBeDefined()
    expect((out as Notification).data).toMatchObject({ canResume: false })
  })

  it('chat 已删除等异常路径：按 root 处理透传（保守不丢数据）', () => {
    const out = applyLiteEvent(profile, notification('done', { canResume: false }, 'chat-deleted'))
    expect(out).toBeDefined()
  })

  it('子 run.updated 透传（设备侧折叠——服务端不改写，信封 chatId 保留供分流）', () => {
    const out = applyLiteEvent(profile, notification('run.updated', { runId: 'r-child', status: 'paused' }, CHILD))
    expect(out).toBeDefined()
    expect((out as Notification).data).toEqual({ runId: 'r-child', status: 'paused' })
    expect((out as { chatId?: string }).chatId).toBe(CHILD)
  })

  it('子 error 透传且 message 原样（F11；设备按 chatId 折叠为子任务失败态）', () => {
    const out = applyLiteEvent(profile, notification('error', { message: '[abc12345] 感官出了点小问题', canResume: true }, CHILD))
    expect(out).toBeDefined()
    expect((out as Notification).data).toMatchObject({ message: '[abc12345] 感官出了点小问题' })
  })

  it('子 interrupt 不抑制（G4 审批全量不分根/子）', () => {
    const out = applyLiteEvent(profile, notification('interrupt', { approvalId: 'a1', senseName: 'write_file', arguments: { path: '/x' } }, CHILD))
    expect(out).toBeDefined()
  })

  it('子 accept 投影精简（去 result 全文）且 chatId 保留', () => {
    const out = applyLiteEvent(profile, notification('accept', { approvalId: 'a1', senseName: 'read_file', ok: true, result: 'x'.repeat(40000) }, CHILD))
    expect((out as Notification).data).toEqual({ approvalId: 'a1', senseName: 'read_file', ok: true })
    expect((out as { chatId?: string }).chatId).toBe(CHILD)
  })

  it('子 turn.started/cancelled/completed 透传（设备折叠为「子任务运行中」）', () => {
    for (const type of ['turn.started', 'turn.cancelled', 'turn.completed']) {
      const out = applyLiteEvent(profile, notification(type, { turnId: 't1' }, CHILD))
      expect(out).toBeDefined()
    }
  })

  it('role_created 投影去 prompt（子任务存在性）+ role_reply 抑制', () => {
    const created = applyLiteEvent(profile, notification('role_created', { taskId: 'tk', childChatId: CHILD, parentChatId: ROOT, type: 'spawn_role', wake: 'immediate', prompt: '长任务', brain: 'x', senseGroup: 'y' }, ROOT))
    expect((created as Notification).data).not.toHaveProperty('prompt')
    expect(applyLiteEvent(profile, notification('role_reply', { parentChatId: ROOT, childChatId: CHILD, type: 't', content: 'c' }, ROOT))).toBeUndefined()
  })

  it('return lean 节点经 timeline.patch 到达（子完成唯一权威通道）', () => {
    const patch = notification('timeline.patch', {
      chatId: ROOT,
      rootPatch: {
        rootChatId: ROOT, view: 'conversation', baseRevision: 1, revision: 2,
        operations: [{ type: 'upsert', node: { id: 'n1', kind: 'return', actor: { kind: 'agent', roleType: 'researcher' }, direction: 'child-to-parent', orderKey: 10, status: 'committed', createdAt: 1, content: '子任务结果全文……' } }],
      },
    }, ROOT)
    const out = applyLiteEvent(profile, patch) as Notification
    const rootPatch = (out.data as Record<string, unknown>).rootPatch as Record<string, unknown>
    const ops = rootPatch.operations as Array<{ type: string; node: Record<string, unknown> }>
    expect(ops.length).toBe(1)
    expect(ops[0]!.node.kind).toBe('return')
    expect(ops[0]!.node.actorRoleType).toBe('researcher')
    expect(ops[0]!.node.direction).toBe('child-to-parent')
    expect(ops[0]!.node).not.toHaveProperty('content') // lean：无全文
    expect(ops[0]!.node.summary).toBe('子任务结果全文……') // 摘要在
  })
})

describe('T26 游标分道（per-chat seq 不可跨 chat 比较）', () => {
  it('子事件与根事件 seq 独立保留（信封 seq 字段不被剥）', () => {
    const rootEvt = applyLiteEvent(profile, { kind: 'notification', type: 'turn.started', chatId: ROOT, seq: 5, data: { turnId: 't' } })
    const childEvt = applyLiteEvent(profile, { kind: 'notification', type: 'turn.started', chatId: CHILD, seq: 3, data: { turnId: 't2' } })
    expect((rootEvt as { seq?: number }).seq).toBe(5)
    expect((childEvt as { seq?: number }).seq).toBe(3)
  })
})
