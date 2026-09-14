// Temporary end-to-end verification: fixed recorder -> journal -> state/evidence,
// mirroring the real eab4d156 session shape (text+tool round then loop 2).
import { describe, expect, it, vi } from 'vitest'
import type { WorkflowJournalEventInput } from '@/db/workflowJournal.js'

const fixture = vi.hoisted(() => ({
  appendCalls: [] as WorkflowJournalEventInput[][],
}))

vi.mock('@/db/chat.js', () => ({
  getMessages: () => [],
  getRootChatId: (chatId: string) => chatId,
}))
vi.mock('@/db/conversationBranch.js', () => ({ getConversationBranchByChat: () => undefined }))
vi.mock('@/db/workflowJournal.js', () => ({
  appendWorkflowJournalEvents: (events: WorkflowJournalEventInput[]) =>
    fixture.appendCalls.push(structuredClone(events)),
  recordWorkflowJournalGap: () => {},
  readWorkflowStepSnapshot: () => ({ active: [] }),
}))
vi.mock('@/db/delivery.js', () => ({ getSpawnTaskByChild: () => undefined }))
vi.mock('@/service/chat/runtime.js', () => ({ getActiveChatRunId: () => 'run' }))

import { reportWorkflow } from '@/core/middleware/workflowObservation.js'
import { startWorkflowRunRecorder } from '@/service/chat/workflowRecorder.js'
import { installWorkflowSnapshot } from '../../../../web/src/features/agent/workbench/runtime-diagram/workflowState'
import { projectHeaderState } from '../../../../web/src/features/agent/workbench/runtime-diagram/headerState'
import { projectHeaderEdgeEvidence } from '../../../../web/src/features/agent/workbench/runtime-diagram/headerEdgeEvidence'
import type { WorkflowStepEvent } from '@chery/protocol'

function senseEnd(id: string) {
  return {
    type: 'sense_end',
    id,
    name: 'config_manage',
    arguments: '{}',
    security: { findings: [], decision: 'allow' } as { findings: { code: string }[]; decision: string },
  } as const
}

function buildEvents() {
  const seen = new Set<string>()
  return fixture.appendCalls
    .flat()
    .filter((event) => {
      if (seen.has(event.sourceKey)) return false
      seen.add(event.sourceKey)
      return true
    })
    .map((event, i) => ({
      ...event,
      eventId: event.sourceKey,
      sequence: i + 1,
      revision: i + 1,
      at: i + 1,
      orderQuality: 'exact',
    })) as WorkflowStepEvent[]
}

describe('fixed recorder end-to-end lighting', () => {
  it('lights context after input, one checkpoint with two simultaneous inputs, and grays loop 1 at loop 2', () => {
    const recorder = startWorkflowRunRecorder('root')

    // ---- iteration 1 (text + tool round) ----
    reportWorkflow('root', { newIteration: true, iteration: 1 })
    reportWorkflow('root', { activeNodeId: 'input', status: 'succeeded' })
    reportWorkflow('root', { activeNodeId: 'model', phaseLabel: '准备请求' })
    reportWorkflow('root', { activeNodeId: 'model', phaseLabel: '调用中', waitReason: 'model' })
    reportWorkflow('root', { activeNodeId: 'model', phaseLabel: '处理响应' })
    recorder.recordCommittedMessage({ id: 'assistant-with-tool', role: 'assistant' })
    recorder.recordChunk({ type: 'sense_pending', approvalId: 'call', senseName: 'config_manage', arguments: '{}', supervisionLevel: 1 })
    recorder.recordChunk(senseEnd('call'))
    recorder.recordChunk({ type: 'sense_started', id: 'call', name: 'config_manage', arguments: '{}', startedAt: 1 })
    recorder.recordChunk({ type: 'sense_accept', id: 'call', name: 'config_manage', result: 'ok' })
    reportWorkflow('root', { activeNodeId: 'checkpoint', phaseLabel: '记录汇总' })
    recorder.recordCommittedMessage({ id: 'call', role: 'sense' })
    reportWorkflow('root', { activeNodeId: 'decision', phaseLabel: '继续判断', status: 'waiting', waitReason: 'loop' })
    reportWorkflow('root', { activeNodeId: 'decision', status: 'succeeded' })

    // ---- iteration 2 (pure text) ----
    reportWorkflow('root', { newIteration: true, iteration: 2 })
    reportWorkflow('root', { activeNodeId: 'input', status: 'succeeded' })
    reportWorkflow('root', { activeNodeId: 'model', phaseLabel: '准备请求' })
    reportWorkflow('root', { activeNodeId: 'model', phaseLabel: '调用中', waitReason: 'model' })
    reportWorkflow('root', { activeNodeId: 'model', phaseLabel: '处理响应' })
    recorder.recordCommittedMessage({ id: 'assistant-2', role: 'assistant' })
    recorder.finish('succeeded', 'normal')

    const events = buildEvents()
    const all = Object.values(installWorkflowSnapshot({
      rootChatId: 'root',
      revision: events.length,
      upperSequence: events.length,
      active: [],
      recentEvents: events,
      gaps: [],
      hasEarlier: false,
      historyComplete: true,
    }).occurrences)

    // Q2: context starts after the loop input, at 准备请求, run-level.
    const contextEvents = events.filter((event) => event.kind === 'context')
    const inputStart = events.findIndex((event) => event.kind === 'input' && event.eventKind === 'started')
    const contextStart = events.findIndex((event) => event.kind === 'context' && event.eventKind === 'started')
    expect(contextStart).toBeGreaterThan(inputStart)
    expect(contextEvents.every((event) => event.iteration === undefined)).toBe(true)
    expect(contextEvents.every((event) => event.attempt === undefined)).toBe(true)

    // Q1: exactly one checkpoint occurrence; both inputs target it.
    const checkpointIds = new Set(all.filter((item) => item.kind === 'checkpoint').map((item) => item.occurrenceId))
    expect(checkpointIds.size).toBe(1)
    const graph = projectHeaderEdgeEvidence(
      projectHeaderState({ chatId: 'root', occurrences: all, calls: [], recorded: true, complete: true }),
      all,
    )
    expect(graph.has('channels:checkpoint')).toBe(true)
    expect(graph.has('tool-result:checkpoint')).toBe(true)
    expect(graph.get('channels:checkpoint')?.targetOccurrenceId).toBe(
      graph.get('tool-result:checkpoint')?.targetOccurrenceId,
    )

    // Q3: at loop 2 with an incomplete live record, loop-1 chain is gray idle, not unknown.
    // 本轮（iter2 纯文本）重新点亮的节点保持实际状态；上一轮工具链/内容记录/继续判断
    // 不再出现在本轮 → 全部灰色 idle。
    const live = projectHeaderState({ chatId: 'root', occurrences: all, calls: [], recorded: true, complete: false })
    expect(live.scope.iteration).toBe(2)
    expect(live.slots.input?.status).toBe('succeeded')
    expect(live.slots.request?.status).toBe('succeeded')
    expect(live.slots.model?.status).toBe('succeeded')
    expect(live.slots['tool-list']?.status).toBe('idle')
    expect(live.slots.validation?.status).toBe('idle')
    expect(live.slots.authorization?.status).toBe('idle')
    expect(live.slots.approval?.status).toBe('idle')
    expect(live.slots.preflight?.status).toBe('idle')
    expect(live.slots.execution?.status).toBe('idle')
    expect(live.slots['tool-result']?.status).toBe('idle')
    expect(live.slots.checkpoint?.status).toBe('idle')
    expect(live.slots.decision?.status).toBe('idle')
  })
})
