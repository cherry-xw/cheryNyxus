import type { HandlerContext } from '../message/router.js'
import type {
  ChatTimelineGetRequestData,
  ChatTimelineGetResponseData,
  TimelineNode,
  ExecutionEdgeFact,
  ActiveRunFact,
  RootTimelineSnapshot,
} from '../message/types.js'
import { getTimelineRevision } from '@/db/chat.js'
import { getConversationTask, listConversationBranches } from '@/db/conversationBranch.js'
import { logger } from '@/utils/logger/index.js'
import { assertChatExists } from './guards.js'
import { buildCanonicalTimeline, buildRootTimeline } from './timeline.js'
function decodeTimelineCursor(cursor: string): { createdAt: number; id: string } | undefined {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8')
    const parsed = JSON.parse(raw) as { createdAt?: unknown; id?: unknown }
    if (typeof parsed.createdAt !== 'number' || typeof parsed.id !== 'string') return undefined
    return { createdAt: parsed.createdAt, id: parsed.id }
  } catch {
    return undefined
  }
}

function encodeTimelineCursor(value: { createdAt: number; id: string }): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

/** V2 authoritative timeline snapshot. The frontend receives complete messages only. */
export async function handleChatTimelineGet(
  _ctx: HandlerContext,
  data: ChatTimelineGetRequestData,
): Promise<ChatTimelineGetResponseData> {
  if (data.taskId) {
    const task = getConversationTask(data.taskId)
    if (!task) throw new Error('任务不存在')
    const branches = listConversationBranches(data.taskId)
    const snapshots = branches.map((branch) => ({
      branch,
      timeline: buildRootTimeline(branch.chatId, data.view ?? 'tree'),
    }))
    const nodes: TimelineNode[] = []
    const edges: ExecutionEdgeFact[] = []
    const activeRuns: ActiveRunFact[] = []
    const pendingInputs: RootTimelineSnapshot['pendingInputs'] = []
    const generations: RootTimelineSnapshot['generations'] = []
    let orderOffset = 0
    for (const { branch, timeline } of snapshots) {
      const maxOrder = Math.max(
        0,
        ...timeline.nodes.map((node) => node.orderKey),
        ...timeline.edges.map((edge) => edge.orderKey),
      )
      for (const node of timeline.nodes) {
        nodes.push({
          ...node,
          rootChatId: task.originalChatId,
          orderKey: node.orderKey + orderOffset,
          taskId: data.taskId,
          branchId: branch.branchId,
          branchKind: branch.kind,
        })
      }
      for (const edge of timeline.edges) {
        edges.push({
          ...edge,
          rootChatId: task.originalChatId,
          orderKey: edge.orderKey + orderOffset,
          taskId: data.taskId,
          branchId: branch.branchId,
        })
      }
      activeRuns.push(
        ...timeline.activeRuns.map((run) => ({ ...run, rootChatId: task.originalChatId })),
      )
      pendingInputs.push(...timeline.pendingInputs)
      generations.push(
        ...timeline.generations.map((entry) => ({
          ...entry,
          fromOrderKey: entry.fromOrderKey + orderOffset,
          boundaryOrderKey: entry.boundaryOrderKey + orderOffset,
          sourceRootChatId: branch.chatId,
          branchId: branch.branchId,
        })),
      )
      orderOffset += maxOrder + 1
    }
    for (const { branch, timeline } of snapshots) {
      if (!branch.sourceBranchId || !branch.anchorNodeId) continue
      const first = timeline.nodes
        .filter((node) => node.status === 'committed')
        .sort((a, b) => a.orderKey - b.orderKey)[0]
      const anchor = nodes.find(
        (node) => node.id === branch.anchorNodeId && node.branchId === branch.sourceBranchId,
      )
      if (!first || !anchor) continue
      anchor.forkAnchor = true
      const projectedFirst = nodes.find(
        (node) => node.id === first.id && node.branchId === branch.branchId,
      )
      if (projectedFirst) projectedFirst.forkAnchor = true
      edges.push({
        id: `edge:fork:${branch.branchId}`,
        rootChatId: task.originalChatId,
        fromNodeId: anchor.id,
        toNodeId: first.id,
        kind: branch.kind === 'detail' ? 'fork-detail' : 'fork-continuation',
        orderKey: orderOffset++,
        sourceChatId: anchor.sourceChatId,
        targetChatId: branch.chatId,
        taskId: data.taskId,
        branchId: branch.branchId,
      })
    }
    const rootTimeline: RootTimelineSnapshot = {
      rootChatId: task.originalChatId,
      taskId: data.taskId,
      activeBranchId: task.activeBranchId,
      branches: snapshots.map(({ branch, timeline }) => {
        const firstUserMessage = timeline.nodes
          .filter((node) => node.status === 'committed' && node.actor.kind === 'user')
          .sort((a, b) => a.orderKey - b.orderKey)[0]
          ?.content.trim()
        const snapshotMetadata = branch.runtimeSnapshot.metadata
        const storedTitle =
          snapshotMetadata && typeof snapshotMetadata === 'object'
            ? (snapshotMetadata as Record<string, unknown>).branchTitle
            : undefined
        const title =
          typeof storedTitle === 'string' && storedTitle.trim()
            ? storedTitle.trim()
            : firstUserMessage
        return {
          branchId: branch.branchId,
          taskId: branch.taskId,
          chatId: branch.chatId,
          kind: branch.kind,
          ...(branch.sourceBranchId ? { sourceBranchId: branch.sourceBranchId } : {}),
          ...(branch.anchorRootChatId ? { anchorRootChatId: branch.anchorRootChatId } : {}),
          ...(branch.anchorNodeId ? { anchorNodeId: branch.anchorNodeId } : {}),
          ...(title ? { title } : {}),
          createdAt: branch.createdAt,
        }
      }),
      view: data.view ?? 'tree',
      revision: Math.max(0, ...snapshots.map((item) => item.timeline.revision)),
      nodes,
      edges,
      activeRuns,
      pendingInputs,
      generations,
      capturedEventSeq: Math.max(0, ...snapshots.map((item) => item.timeline.capturedEventSeq)),
    }
    return {
      chatId: task.originalChatId,
      revision: rootTimeline.revision,
      messages: [],
      rootTimeline,
    }
  }
  const requestedChatId = data.chatId ?? data.rootChatId
  if (!requestedChatId) throw new Error('缺少 chatId/rootChatId/taskId')
  assertChatExists(requestedChatId)
  if (data.rootChatId) {
    // knownRevision 短路：客户端已持有该 revision 的窗口快照，不重传图
    const revision = getTimelineRevision(data.rootChatId)
    if (data.knownRevision !== undefined && data.knownRevision >= revision) {
      return { chatId: data.rootChatId, revision, unchanged: true }
    }
    const rootTimeline = buildRootTimeline(data.rootChatId, data.view ?? 'conversation')
    logger.event('chat.rootTimeline.get', {
      rootChatId: data.rootChatId,
      view: data.view ?? 'conversation',
      revision: rootTimeline.revision,
      count: rootTimeline.nodes.length,
    })
    return {
      chatId: data.rootChatId,
      revision: rootTimeline.revision,
      messages: [],
      rootTimeline,
    }
  }
  const revision = getTimelineRevision(requestedChatId)
  let messages = buildCanonicalTimeline(requestedChatId)
  // lite P1-② 的 number 游标（orderKey）不进本 legacy 消息路径（由 lite 投影层消费）；仅字符串复合游标在此解码。
  const cursor = typeof data.before === 'string' ? decodeTimelineCursor(data.before) : undefined
  if (typeof data.before === 'string' && !cursor) throw new Error('历史分页游标无效')
  if (cursor) {
    messages = messages.filter(
      (m) =>
        m.createdAt < cursor.createdAt || (m.createdAt === cursor.createdAt && m.id < cursor.id),
    )
  }
  const limit = data.limit ?? 500
  const hasMore = messages.length > limit
  if (hasMore) messages = messages.slice(messages.length - limit)
  const oldest = messages[0]
  logger.event('chat.timeline.get', {
    chatId: requestedChatId,
    revision,
    count: messages.length,
    hasMore,
  })
  return {
    chatId: requestedChatId,
    revision,
    messages,
    ...(hasMore && oldest
      ? { nextCursor: encodeTimelineCursor({ createdAt: oldest.createdAt, id: oldest.id }) }
      : {}),
  }
}
