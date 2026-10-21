/** Presentation-facing chat types owned by the chat domain, not by a Pinia store. */

import type { StagedReverseChunkData as ProtocolStagedReverseChunkData } from '@chery/protocol'

export interface RuntimeSelection {
  brain: string
  senseGroup: string
  mcpServers?: string[]
}

export interface SenseCallRecord {
  parts?: import('@chery/protocol').MessagePart[]
  fileOperations?: import('@chery/protocol').FileOperationRecord[]
  id?: string
  name: string
  args?: unknown
  result?: unknown
  status: 'running' | 'done' | 'error'
  /** 工具执行归属（local=本机/客户端执行，server=由模型服务执行） */
  executionOwner?: 'local' | 'server'
  /** 服务端工具状态或普通调用被跳过的说明 */
  serverState?: 'started' | 'completed' | 'failed' | 'unknown' | 'skipped-local'
  /** 服务端工具关联的外部来源/引用链接 */
  sources?: Array<{ url: string; title?: string; snippet?: string; refer?: string }>
  /** 工具调用的安全授权判定（authorizeToolCall 输出；缺省 = 无判定，兼容旧数据） */
  security?: ToolAuthorization
}

export interface RunningTool {
  id: string
  name: string
  /** 本次执行的最终安全授权判定（缺省 = 无判定） */
  security?: ToolAuthorization
}

export type { TerminationFact } from '@chery/protocol'
import type { TerminationFact } from '@chery/protocol'

export interface HistoryItem {
  fileOperations?: import('@chery/protocol').FileOperationRecord[]
  role: 'user' | 'assistant' | 'role' | 'subagent' | 'master'
  content: string
  parts?: import('@chery/protocol').MessagePart[]
  thinking?: string
  senseCalls?: SenseCallRecord[]
  petName?: string
  subPetChatId?: string
  callerSubPetChatId?: string
  mergedView?: 'child-to-master'
  spawnSenseCallId?: string
  runtime?: RuntimeSelection
  createdAt?: number
  msgId?: string
  agentChatId?: string
  /** Pending input lifecycle state, present only while the canonical user node has not replaced it. */
  pendingInputState?: 'accepted' | 'started' | 'queued' | 'consumed' | 'cancelled' | 'rejected'
  pendingInputId?: string
  pendingInputReason?: string
  pendingClientMessageId?: string
  pendingInputQueueSequence?: number
  contextCompaction?: boolean
  contextCompactionTokens?: number
  termination?: TerminationFact
  delivery?: {
    status: 'sending' | 'failed' | 'committed'
    error?: { code: string; message: string; retryable: boolean; retryAfterMs?: number }
  }
}

export interface SecurityFinding {
  code: string
  category: string
  severity: 'low' | 'medium' | 'high' | 'unknown'
  message: string
  fragment?: string
  start?: number
  end?: number
}

export interface ToolAuthorization {
  decision: 'allow' | 'ask' | 'deny'
  roleType: string
  policyHash: string
  requiredSandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access'
  findings: SecurityFinding[]
  assessmentHash: string
}

export interface ApprovalState {
  approvalId: string
  senseName: string
  args?: unknown
  waitTime: number
  createdAt: number
  security?: ToolAuthorization
}

export interface QuestionDraftAnswer {
  selectedLabels: string[]
  optionNotes?: Record<string, string>
  freeText?: string
  cancelled?: boolean
}

export interface QuestionItemState {
  questionId: string
  position: number
  question: string
  header?: string
  options: Array<{ label: string; description?: string }>
  multiSelect: boolean
  createdAt: number
  localStatus: 'pending' | 'ready'
  draftAnswer?: QuestionDraftAnswer
}

export interface QuestionBatchState {
  batchId: string
  assistantMessageId: string
  createdAt: number
  status: 'pending' | 'submitting'
  questions: QuestionItemState[]
}

export interface QuestionBatchPayload {
  batchId: string
  assistantMessageId: string
  createdAt: number
  questions: Array<{
    questionId: string
    position: number
    question: string
    header?: string
    options: Array<{ label: string; description?: string }>
    multiSelect: boolean
    createdAt: number
  }>
}

export interface StreamChunkData {
  msgId: string
  createdAt: number
  thinking?: string
  content?: string
  senseCall?: Array<{ index?: number; id?: string; name?: string; arguments?: string }>
}

export interface StagedChunkData {
  parts?: import('@chery/protocol').MessagePart[]
  fileOperations?: import('@chery/protocol').FileOperationRecord[]
  type: 'thinking_end' | 'content_end' | 'sense_end' | 'reverse'
  role?: 'user' | 'assistant' | 'system' | 'sense' | 'role' | 'subagent'
  thinking?: string
  content?: string
  senseName?: string
  arguments?: string
  id?: string
  runtime?: RuntimeSelection
  createdAt?: number
  contextCompaction?: boolean
  contextCompactionTokens?: number
  msgId?: string
  messageIds?: ProtocolStagedReverseChunkData['messageIds']
  agentChatId?: string
  /** sense_end 携带：工具调用的安全授权判定（历史回放渲染风险徽章） */
  security?: ToolAuthorization
  /** 工具执行归属（local=本机/客户端执行，server=由模型服务执行） */
  executionOwner?: 'local' | 'server'
  /** 服务端工具状态或普通调用被跳过的说明 */
  serverState?: 'started' | 'completed' | 'failed' | 'unknown' | 'skipped-local'
  /** 服务端工具结果或跳过说明 */
  result?: string
  /** 服务端工具关联的外部来源/引用链接 */
  sources?: Array<{ url: string; title?: string; snippet?: string; refer?: string }>
}

export interface ChunkMessage {
  kind: 'chunk'
  type: 'stream' | 'staged'
  requestId: string
  chatId?: string
  runId?: string
  seq?: number
  eventSeq?: number
  subscriptionId?: string
  rootChatId?: string
  rootEventSeq?: number
  sourceEventSeq?: number
  transient?: boolean
  data?: StreamChunkData | StagedChunkData
}

export interface NotificationMessage {
  kind: 'notification'
  type: string
  requestId?: string
  chatId?: string
  runId?: string
  seq?: number
  eventSeq?: number
  subscriptionId?: string
  rootChatId?: string
  rootEventSeq?: number
  sourceEventSeq?: number
  transient?: boolean
  data?: unknown
}
