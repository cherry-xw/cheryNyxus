import type {
  ApprovalState,
  QuestionBatchState,
  QuestionItemState,
} from '@/domain/chat/projectionTypes'
import type { ChatSession } from '@/application/chat/public'
import type { ExecutionNode } from './executionGraph'
import { toolBatchDetail } from './toolBatchDetails'

export interface NodePopoverQuestion {
  batch: QuestionBatchState
  question: QuestionItemState
  currentIndex: number
}

export interface DefaultNodePopover {
  id: string
  chatId: string
  anchorNodeId: string
  /**
   * 附加锚点节点：与主锚点一起闪烁，点击任一都打开同一交互卡。
   * 提问批除锚定 assistant 消息节点外，同时锚定 ask_user_question 问号工具节点。
   */
  anchorAltNodeIds?: string[]
  displayNodeId: string
  selectedCallId?: string
  approval?: ApprovalState
  question?: NodePopoverQuestion
  createdAt: number
}

interface NodeMatch {
  anchor: ExecutionNode
  display: ExecutionNode
}

function foldDisplayMatch(
  node: ExecutionNode,
  predicate: (candidate: ExecutionNode) => boolean,
): ExecutionNode | undefined {
  return node.fold?.members
    .flatMap((member) => [member.displayNode, ...member.nodes])
    .find(predicate)
}

function findNodeMatch(
  nodes: readonly ExecutionNode[],
  predicate: (candidate: ExecutionNode) => boolean,
): NodeMatch | undefined {
  for (const node of nodes) {
    const display = foldDisplayMatch(node, predicate)
    if (display) return { anchor: node, display }
    if (predicate(node)) return { anchor: node, display: node }
  }
  return undefined
}

function callMatch(nodes: readonly ExecutionNode[], callId: string): NodeMatch | undefined {
  return findNodeMatch(nodes, (node) =>
    Boolean(toolBatchDetail(node)?.calls.some((call) => call.callId === callId)),
  )
}

function messageMatch(nodes: readonly ExecutionNode[], messageId: string): NodeMatch | undefined {
  return findNodeMatch(
    nodes,
    (node) => node.id === messageId || node.sourceFact?.sourceMessageId === messageId,
  )
}

function pendingQuestion(
  session: ChatSession,
  batch: QuestionBatchState,
): NodePopoverQuestion | undefined {
  const currentIndex = Math.max(
    0,
    batch.questions.findIndex(
      (question) =>
        question.questionId === session.interaction.activeQuestionId ||
        question.localStatus === 'pending',
    ),
  )
  const question = batch.questions[currentIndex]
  return question ? { batch, question, currentIndex } : undefined
}

/** Pending node interactions are open by default; hover remains only a detail affordance. */
export function buildDefaultNodePopovers(
  nodes: readonly ExecutionNode[],
  sessionsById: Readonly<Record<string, ChatSession>>,
): DefaultNodePopover[] {
  const models: DefaultNodePopover[] = []
  for (const session of Object.values(sessionsById)) {
    const approvals = [
      ...(session.interaction.approval ? [session.interaction.approval] : []),
      ...session.interaction.approvalQueue,
    ].filter(
      (approval, index, all) =>
        all.findIndex((candidate) => candidate.approvalId === approval.approvalId) === index,
    )
    for (const approval of approvals) {
      const match = callMatch(nodes, approval.approvalId)
      if (!match) continue
      models.push({
        id: `node-action:approval:${approval.approvalId}`,
        chatId: session.chatId,
        anchorNodeId: match.anchor.id,
        displayNodeId: match.display.id,
        selectedCallId: approval.approvalId,
        approval,
        createdAt: approval.createdAt,
      })
    }

    for (const batch of session.interaction.questionBatches) {
      const question = pendingQuestion(session, batch)
      const match = messageMatch(nodes, batch.assistantMessageId)
      if (!question || !match) continue
      // 除 assistant 消息节点外，同时锚定触发该提问的 ask_user_question 问号工具节点：
      // 提问批内每题的 questionId 即触发它的调用 callId，两个锚点一起闪烁、
      // 点击任一都打开同一提问卡。
      const toolMatch = callMatch(nodes, question.question.questionId)
      const anchorAltNodeIds =
        toolMatch && toolMatch.anchor.id !== match.anchor.id
          ? [toolMatch.anchor.id]
          : undefined
      models.push({
        id: `node-action:question:${batch.batchId}`,
        chatId: session.chatId,
        anchorNodeId: match.anchor.id,
        anchorAltNodeIds,
        displayNodeId: match.display.id,
        question,
        createdAt: batch.createdAt,
      })
    }
  }
  return models.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
}
