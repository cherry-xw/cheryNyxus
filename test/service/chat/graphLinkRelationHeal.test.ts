/**
 * buildRootTimeline 的位置型 link relation 自愈回归测试。
 *
 * 背景：历史版本曾把子会话首条指令的 message_links.relation 误写成 root_input
 * （assistant 误写成 agent_output）。投影器按 link.relation 赋 actor：root_input →
 * actor=user 且 sourceChatId=子会话，前端 diagnostics 判定 illegal-user-child-input。
 * 懒回填只补缺失链接、从不修正已存在的错误 relation，因此重启与重新同步都无法消除。
 *
 * 修复约定：位置型关系（root_input/child_input/agent_output/child_output）必须与消息
 * 所在会话的拓扑一致，build 时发现矛盾即重写为正确值并推进 revision；
 * child_return/system/tool_result 由显式写路径负责，自愈不触碰。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createChat, deleteChat, getTimelineRevision } from '@/db/chat.js'
import { addMessage } from '@/db/message.js'
import { getMessageLinksForRoot } from '@/db/messageLink.js'
import { buildRootTimeline } from '@/service/chat/timeline.js'

const cleanup: string[] = []
afterEach(() => {
  for (const id of cleanup.splice(0).reverse()) deleteChat(id)
})

/** 搭建含历史脏 link 的最小任务：子会话消息全部被误标为 root 侧关系。 */
function setupCorruptedTask(): { rootChatId: string; childChatId: string } {
  const rootChatId = 'heal-root'
  const childChatId = 'heal-child'
  cleanup.push(rootChatId, childChatId)
  createChat(rootChatId)
  createChat(childChatId, {}, rootChatId)
  // 子会话 user 消息被误写成 root_input（触发 illegal-user-child-input 的脏数据）
  addMessage('01-child-user', childChatId, {
    role: 'user',
    content: '子任务指令',
    link: { rootChatId, sourceChatId: childChatId, parentChatId: rootChatId, relation: 'root_input' },
  })
  // 子会话 assistant 消息被误写成 agent_output（同源脏数据，不触发诊断但同样错位）
  addMessage('02-child-done', childChatId, {
    role: 'assistant',
    content: '子任务完成',
    link: { rootChatId, sourceChatId: childChatId, parentChatId: rootChatId, relation: 'agent_output' },
  })
  // root 会话 user 消息被误写成 child_input（对称错位，自愈应还原为 root_input）
  addMessage('03-root-user', rootChatId, {
    role: 'user',
    content: '先派子任务',
    link: { rootChatId, sourceChatId: rootChatId, parentChatId: rootChatId, relation: 'child_input' },
  })
  return { rootChatId, childChatId }
}

describe('buildRootTimeline 位置型 link relation 自愈', () => {
  it('误标的子会话消息 link 被修正，节点不再以 user 身份投影', () => {
    const { rootChatId, childChatId } = setupCorruptedTask()
    const timeline = buildRootTimeline(rootChatId, 'tree')

    // 持久层 link 已自愈为拓扑正确值
    const links = new Map(
      getMessageLinksForRoot(rootChatId).map((link) => [link.messageId, link]),
    )
    expect(links.get('01-child-user')?.relation).toBe('child_input')
    expect(links.get('02-child-done')?.relation).toBe('child_output')
    expect(links.get('03-root-user')?.relation).toBe('root_input')

    // 子会话指令节点不再以 user 身份出现在快照里（前端 illegal-user-child-input 消失）
    const childInputNode = timeline.nodes.find((n) => n.id === '01-child-user')
    expect(childInputNode).toBeDefined()
    expect(childInputNode!.actor.kind).toBe('agent')
    expect(childInputNode!.direction).toBe('parent-to-child')
    expect(childInputNode!.sourceChatId).toBe(childChatId)
    // root 会话用户输入恢复 user 身份
    const rootInputNode = timeline.nodes.find((n) => n.id === '03-root-user')
    expect(rootInputNode!.actor.kind).toBe('user')
  })

  it('自愈推进 revision，且二次构建不再变更（收敛）', () => {
    const { rootChatId } = setupCorruptedTask()
    const revisionBefore = getTimelineRevision(rootChatId)
    const first = buildRootTimeline(rootChatId, 'tree')
    // 自愈属于图变更 ⇒ revision 必须前进，客户端才能丢弃旧增量后自愈
    expect(first.revision).toBeGreaterThan(revisionBefore)

    // 第二次构建：无新变更 ⇒ revision 稳定（不无限翻新）
    const second = buildRootTimeline(rootChatId, 'tree')
    expect(second.revision).toBe(first.revision)
  })

  it('显式关系（child_return）不被自愈重写', () => {
    const rootChatId = 'heal-return-root'
    const childChatId = 'heal-return-child'
    cleanup.push(rootChatId, childChatId)
    createChat(rootChatId)
    createChat(childChatId, {}, rootChatId)
    addMessage('01-child-user', childChatId, { role: 'user', content: '子任务指令' })
    addMessage('02-child-done', childChatId, { role: 'assistant', content: '子任务完成' })
    // wake.ts 写入的 child_return 挂在 root 的 role 行上，带语义字段
    addMessage('03-root-return', rootChatId, {
      role: 'role',
      content: '[角色 子任务] 结果',
      link: {
        rootChatId,
        sourceChatId: childChatId,
        parentChatId: rootChatId,
        relation: 'child_return',
        relatedMessageId: '02-child-done',
      },
    })

    buildRootTimeline(rootChatId, 'tree')
    const links = new Map(
      getMessageLinksForRoot(rootChatId).map((link) => [link.messageId, link]),
    )
    expect(links.get('03-root-return')?.relation).toBe('child_return')
    expect(links.get('03-root-return')?.relatedMessageId).toBe('02-child-done')
  })
})
