import { describe, expect, it } from 'vitest'
import type { ToolAuthorization } from '@/domain/chat/projectionTypes'
import { applyCurrentState, createEmptySession } from '@/stores/chats/model/hydration'
import { reduce, replaceTimeline } from '@/stores/chats/model/reducer'
import { selectCurrentState } from '@/stores/chats/read-model/selectors'

function authorization(
  decision: ToolAuthorization['decision'],
  severity?: 'medium' | 'high',
): ToolAuthorization {
  return {
    decision,
    roleType: 'workspace-developer',
    policyHash: 'policy',
    findings: severity
      ? [{ code: `risk.${severity}`, category: 'test', severity, message: severity }]
      : [],
    assessmentHash: `assessment-${decision}`,
  }
}

describe('工具风险前端投影', () => {
  it('同批 staged 工具调用分别保留各自的 security', () => {
    const session = createEmptySession('chat-1')
    reduce(
      session,
      {
        kind: 'chunk',
        type: 'staged',
        requestId: 'request-1',
        data: { type: 'content_end', role: 'assistant', msgId: 'assistant-1', content: '' },
      },
      { now: 1 },
    )

    for (const [id, name, security] of [
      ['call-safe', 'read_file', authorization('allow')],
      ['call-risky', 'write_file', authorization('ask', 'high')],
    ] as const) {
      reduce(
        session,
        {
          kind: 'chunk',
          type: 'staged',
          requestId: 'request-1',
          data: { type: 'sense_end', id, senseName: name, arguments: '{}', security },
        },
        { now: 2 },
      )
    }

    expect(
      session.messagesById['assistant-1']?.senseCalls.map((call) => ({
        id: call.id,
        decision: call.security?.decision,
        severity: call.security?.findings[0]?.severity,
      })),
    ).toEqual([
      { id: 'call-safe', decision: 'allow', severity: undefined },
      { id: 'call-risky', decision: 'ask', severity: 'high' },
    ])
  })

  it('V2 canonical timeline 恢复逐调用 security', () => {
    const session = createEmptySession('chat-1')
    replaceTimeline(session, {
      chatId: 'chat-1',
      revision: 1,
      messages: [
        {
          id: 'assistant-1',
          chatId: 'chat-1',
          role: 'assistant',
          content: '',
          createdAt: 1,
          updatedAt: 1,
          status: 'committed',
          senseCalls: [
            {
              id: 'call-1',
              name: 'execute_command',
              arguments: '{}',
              status: 'accepted',
              security: authorization('ask', 'medium'),
            },
          ],
        },
      ],
    })

    expect(session.messagesById['assistant-1']?.senseCalls[0]?.security).toMatchObject({
      decision: 'ask',
      findings: [{ severity: 'medium' }],
    })
  })

  it('审批 currentState 恢复与导出均保留 security', () => {
    const session = createEmptySession('chat-1')
    const security = authorization('ask', 'high')
    applyCurrentState(
      session,
      {
        pendingApproval: {
          approvalId: 'approval-1',
          senseName: 'write_file',
          arguments: '{}',
          supervisionLevel: 1,
          waitTime: 0,
          createdAt: 1,
          security,
        },
        runningTools: [],
      },
      1,
    )

    expect(session.interaction.approval?.security).toEqual(security)
    expect(selectCurrentState(session)?.pendingApproval?.security).toEqual(security)
  })
})
