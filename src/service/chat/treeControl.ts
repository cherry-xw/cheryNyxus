import type { HandlerContext } from '../message/router.js'
import {
  Method,
  type ChatResumeTreeRequestData,
  type ChatResumeTreeResponseData,
  type TreeControlState,
  type TreeControlTarget,
} from '../message/types.js'
import {
  getActiveTreeControl,
  getTreeControlOperation,
  refreshTreeControlStatus,
  updateTreeControlOperation,
  updateTreeControlTarget,
} from '@/db/treeControl.js'
import { bumpTimelineRevision, getChat, getRootChatId, getTimelineRevision } from '@/db/chat.js'
import { claimRequest, completeRequest } from '@/db/delivery.js'
import { listLatestExecutionRuns } from '@/db/executionGraph.js'
import { computeCanResume } from './canResume.js'
import { getActiveChatRunId } from './runtime.js'
import { launchDetachedResume } from './send.js'
import { emitTimelinePatch } from './rootGraphPatch.js'

/** A single service process owns chat runtimes; fence overlapping tree resumes. */
const resumingRoots = new Set<string>()

export function toTreeControlState(rootChatId: string): TreeControlState | undefined {
  const operation = getActiveTreeControl(rootChatId)
  if (!operation) return undefined
  // 目标回落（视图层）：resumed 目标若最新 run 已回到 paused 且 computeCanResume
  // （续跑失败/再次暂停），投影为 paused，前端「继续」按钮重现。
  // 语义见 docs/interaction.md 工作台树级暂停与续接「目标可续语义（回落）」。
  const latestRuns = new Map(listLatestExecutionRuns(rootChatId).map((run) => [run.chatId, run]))
  return {
    pauseId: operation.pauseId,
    rootChatId: operation.rootChatId,
    status: operation.status,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    targets: operation.targets.map(({ pauseId: _pauseId, ...target }) => {
      if (target.status !== 'resumed') return target
      const latest = latestRuns.get(target.chatId)
      if (latest?.status === 'paused' && computeCanResume(target.chatId)) {
        return { ...target, status: 'paused' as const, pausedRunId: latest.runId }
      }
      return target
    }),
  }
}

function targetView(
  target: NonNullable<ReturnType<typeof getTreeControlOperation>>['targets'][number],
): TreeControlTarget {
  const { pauseId: _pauseId, ...view } = target
  return view
}

function chatDepth(rootChatId: string, chatId: string): number {
  let depth = 0
  let current = getChat(chatId)
  const seen = new Set<string>()
  while (current?.parent_chat_id && current.id !== rootChatId && !seen.has(current.id)) {
    seen.add(current.id)
    depth += 1
    current = getChat(current.parent_chat_id)
  }
  return depth
}

/** Resume only runs that still represent the exact pause operation target. */
export async function handleChatResumeTree(
  ctx: HandlerContext,
  data: ChatResumeTreeRequestData,
): Promise<ChatResumeTreeResponseData> {
  const root = getChat(data.rootChatId)
  if (!root || root.parent_chat_id || getRootChatId(data.rootChatId) !== data.rootChatId) {
    throw new Error('树级续接只能作用于主会话')
  }
  const operation = getTreeControlOperation(data.pauseId)
  if (!operation || operation.rootChatId !== data.rootChatId) throw new Error('暂停操作不存在')
  if (operation.status === 'superseded') throw new Error('暂停操作已被新的暂停取代')
  if (resumingRoots.has(data.rootChatId)) throw new Error('该任务树正在继续运行')

  const claimed = claimRequest(data.commandId, Method.CHAT_RESUME_TREE, data)
  if (claimed.state === 'completed') {
    return JSON.parse(claimed.responseJson) as ChatResumeTreeResponseData
  }
  if (claimed.state === 'active') throw new Error('该续接命令正在处理')
  if (claimed.state === 'mismatch') throw new Error('commandId 已用于另一条命令')

  resumingRoots.add(data.rootChatId)
  try {
    // A process can stop after persisting `resuming` but before launching the
    // run. With no live in-process owner, turn those targets back into an
    // explicit retryable failure before starting this new command.
    if (operation.status === 'resuming') {
      for (const target of operation.targets.filter(
        (candidate) => candidate.status === 'resuming',
      )) {
        updateTreeControlTarget(data.pauseId, target.chatId, 'failed', {
          detail: '上次续接在完成前中断',
        })
      }
    }

    updateTreeControlOperation(data.pauseId, 'resuming')
    const currentOperation = getTreeControlOperation(data.pauseId)!
    const latestRuns = new Map(
      listLatestExecutionRuns(data.rootChatId).map((run) => [run.chatId, run]),
    )
    const targets = currentOperation.targets
      // resumed 目标也纳入续接范围：若续跑后再次失败/暂停（最新 run paused 且可续），
      // 仍属可续目标（回落语义）；delegated/skipped 永不参与续接。
      .filter(
        (target) =>
          target.status === 'paused' || target.status === 'failed' || target.status === 'resumed',
      )
      .sort((a, b) => {
        const depthDelta =
          chatDepth(data.rootChatId, b.chatId) - chatDepth(data.rootChatId, a.chatId)
        return depthDelta || a.chatId.localeCompare(b.chatId)
      })

    for (const target of targets) {
      if (getTreeControlOperation(data.pauseId)?.status === 'superseded') break
      const chat = getChat(target.chatId)
      const latest = latestRuns.get(target.chatId)
      if (!chat) {
        updateTreeControlTarget(data.pauseId, target.chatId, 'skipped', { detail: '会话已删除' })
        continue
      }
      if (getActiveChatRunId(target.chatId)) {
        updateTreeControlTarget(data.pauseId, target.chatId, 'skipped', {
          detail: '目标已由其他操作启动',
        })
        continue
      }
      // 匹配放宽：resumed 目标（续跑失败回落后）不再要求 runId===pausedRunId，
      // 改以「最新 run paused 且 computeCanResume」判定可续；paused/failed 保持原判据。
      const runMatch =
        target.status === 'resumed'
          ? !!latest && latest.status === 'paused'
          : !!latest && latest.runId === target.pausedRunId && latest.status === 'paused'
      if (!runMatch) {
        updateTreeControlTarget(data.pauseId, target.chatId, 'skipped', {
          detail: '原暂停运行已被新状态取代',
        })
        continue
      }
      if (!computeCanResume(target.chatId)) {
        updateTreeControlTarget(data.pauseId, target.chatId, 'failed', {
          detail: '目标当前不可续接',
        })
        continue
      }
      // resumed 目标续接前回落为 paused，并把 paused_run_id 对齐当前 run，
      // 保证后续（再失败再暂停）投影与续接判据一致（toTreeControlState 同判据）。
      if (target.status === 'resumed') {
        updateTreeControlTarget(data.pauseId, target.chatId, 'paused', {
          pausedRunId: latest!.runId,
        })
      }
      const resumeRunId = `tree-resume:${data.commandId}:${target.chatId}`
      updateTreeControlTarget(data.pauseId, target.chatId, 'resuming', { resumeRunId })
      try {
        await launchDetachedResume(ctx, target.chatId, resumeRunId)
        updateTreeControlTarget(data.pauseId, target.chatId, 'resumed', { resumeRunId })
      } catch (error) {
        updateTreeControlTarget(data.pauseId, target.chatId, 'failed', {
          resumeRunId,
          detail: error instanceof Error ? error.message : '恢复执行失败',
        })
      }
    }

    const result = getTreeControlOperation(data.pauseId)!
    const status =
      result.status === 'superseded' ? 'superseded' : refreshTreeControlStatus(data.pauseId)
    const response: ChatResumeTreeResponseData = {
      rootChatId: data.rootChatId,
      pauseId: data.pauseId,
      commandId: data.commandId,
      status,
      results: getTreeControlOperation(data.pauseId)!.targets.map(targetView),
    }
    const baseRevision = getTimelineRevision(data.rootChatId)
    bumpTimelineRevision(data.rootChatId)
    emitTimelinePatch(data.rootChatId, baseRevision)
    completeRequest(data.commandId, response)
    return response
  } finally {
    resumingRoots.delete(data.rootChatId)
  }
}
