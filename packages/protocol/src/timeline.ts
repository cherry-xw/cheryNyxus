/**
 * 执行时间线（Root Timeline）wire 事实类型 —— 前后端单一事实源。
 *
 * 这组类型描述跨进程投递的执行图事实：节点、边、活动运行、待处理输入、
 * 代际索引、分支摘要与树控状态。后端（src/service/message/types.ts）与前端
 * （web/src/services/agentApi.ts）均以 `export type X = ProtocolX` 别名引用，
 * 不再各自声明（TerminationFact 先例）。
 *
 * 设计约定：
 * - 只放纯 wire 事实，不依赖后端运行时类型（zod 除外）。
 * - 可选性取两侧消费的宽松方向（如 createdAt / mcpServers 可省略），
 *   旧数据兼容由字段可选表达。
 * - 安全判定（TimelineSecurityFact）是 wire 镜像：后端域类型 ToolAuthorization
 *   携带 config 派生依赖（CommandRiskCategory），结构兼容本镜像但不共用定义。
 */

import type { TerminationFact } from './chat'

/** 思考等级档位（与 LLM adapter 的运行时档位同形；档位字符串可扩展）。 */
export type ThinkingLevel = 'off' | 'on' | 'low' | 'medium' | 'high' | 'xhigh' | (string & {})

/** 每轮可切换的 runtime 选择（wire 侧宽松版；域侧校验类型由前后端各自持有）。 */
export interface RuntimeProvenance {
  brain: string
  senseGroup: string
  /** 启用的 MCP server 名；旧快照可能缺省。 */
  mcpServers?: string[]
  /** 思考等级临时覆盖；缺省用大脑配置默认档位。 */
  thinking?: ThinkingLevel
  /** 消息发送时 brain 的 model/provider 快照（快照语义：事后改配置不影响溯源）。 */
  brainModel?: string
  brainProvider?: string
}

export type TimelineActor =
  | { kind: 'user'; actorId: 'human'; displayName?: string }
  | { kind: 'agent'; chatId: string; roleType?: string; avatarKey?: string }
  | { kind: 'tool'; toolName: string }
  | { kind: 'system' }

export type TimelineDirection =
  'user-to-agent' | 'agent-to-user' | 'parent-to-child' | 'child-to-parent' | 'internal'

export interface TodoPlanRef {
  planId: string
  itemId?: string
  index?: number
}

export interface TodoPlanItem {
  itemId: string
  index: number
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm?: string
}

export interface TodoPlanSnapshot {
  planId: string
  items: TodoPlanItem[]
  currentItemId?: string
}

/** 工具调用的安全授权判定（wire 镜像；后端域类型 ToolAuthorization / 前端 ToolAuthorizationDto 均结构兼容）。 */
export interface TimelineSecurityFinding {
  code: string
  category: string
  severity: 'low' | 'medium' | 'high' | 'unknown'
  message: string
  fragment?: string
  start?: number
  end?: number
}

export interface TimelineSecurityFact {
  decision: 'allow' | 'ask' | 'deny'
  roleType: string
  policyHash: string
  requiredSandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access'
  findings: TimelineSecurityFinding[]
  assessmentHash: string
}

export interface GraphToolCall {
  callId: string
  index: number
  name: string
  arguments: string
  result?: string
  status: 'pending' | 'accepted' | 'rejected' | 'completed' | 'error'
  childChatId?: string
  targetChatId?: string
  /** update_todo 及其所属任务项的稳定归属；旧历史缺省。 */
  todoPlan?: TodoPlanRef
  /** 工具调用的安全授权判定；按 callId 独立保存，旧节点可省略。 */
  security?: TimelineSecurityFact
}

export type ConversationBranchKind = 'original' | 'continuation' | 'detail'

export interface ConversationBranchSummary {
  branchId: string
  taskId: string
  chatId: string
  kind: ConversationBranchKind
  sourceBranchId?: string
  anchorRootChatId?: string
  anchorNodeId?: string
  /** First user message in this branch, used as the history selector label. */
  title?: string
  createdAt: number
}

export type ExecutionEdgeKind =
  | 'sequence'
  | 'spawn'
  | 'continue'
  | 'dispatch'
  | 'return'
  | 'return-continuation'
  | 'fork-continuation'
  | 'fork-detail'

export interface ExecutionEdgeFact {
  id: string
  rootChatId: string
  fromNodeId: string
  toNodeId: string
  kind: ExecutionEdgeKind
  orderKey: number
  sourceChatId: string
  targetChatId: string
  callId?: string
  taskId?: string
  branchId?: string
}

export interface ActiveRunFact {
  rootChatId: string
  chatId: string
  runId: string
  status: 'running' | 'waiting' | 'paused' | 'completed' | 'failed'
  turnId?: string
  nodeId?: string
  batchId?: string
}

/**
 * 长会话代际索引条目：第 k 次 compact（手动 /compact 与 autoCompact 统一）= 第 k 代定稿。
 * 代际区间为 (fromOrderKey, boundaryOrderKey]；由 computeGenerations 从持久事实推导，无独立表。
 */
export interface GenerationEntry {
  /** 1-based 代序号 */
  index: number
  /** 摘要 assistant 消息 id（打包锚点） */
  boundaryMessageId: string
  /** 对应 execution node id（= 消息 id；消息未成节点时回退区间内最后一个节点） */
  boundaryNodeId: string
  /** 该代最后一个 orderKey */
  boundaryOrderKey: number
  /** 该代起始 orderKey（上一代 boundaryOrderKey，首代 0） */
  fromOrderKey: number
  /** extractSummaryBlock(摘要 assistant content)；空则回退截断 500 字符 */
  summary: string
  /** 区间内 execution node 数 */
  nodeCount: number
  createdAt: number
  /** auto 由 send 侧内存标记 best-effort 回填；重启后重算一律 manual（装饰性字段） */
  trigger: 'manual' | 'auto'
  /** Epoch that owns the compact boundary message. */
  epochId?: string
  /** Owning branch root when several conversation roots are combined into one task tree. */
  sourceRootChatId?: string
  /** Owning conversation branch in a combined task tree. */
  branchId?: string
}

export interface TimelineNode {
  id: string
  rootChatId: string
  sourceChatId: string
  sourceMessageId?: string
  kind: 'message' | 'tool-batch' | 'return' | 'dispatch' | 'system' | 'tool-group' | 'spawn'
  actor: TimelineActor
  target?: TimelineActor
  direction: TimelineDirection
  visibility: 'conversation' | 'detail' | 'internal'
  content: string
  thinking?: string
  /** 消息执行时的 runtime；assistant 继承同 chat 前一条 user 消息的快照。 */
  runtime?: RuntimeProvenance
  toolCalls?: GraphToolCall[]
  /** 该节点发生时该 Agent 生效的完整任务计划；旧历史缺省。 */
  todoPlan?: TodoPlanSnapshot
  /** 提问类工具（ask_user_question）的回答时间；仅已答/已取消的提问批次存在。
   *  真实等待 = answeredAt − createdAt（工具执行本身是占位秒回）。 */
  answeredAt?: number
  batchId?: string
  orderKey: number
  termination?: TerminationFact
  /** Legacy read compatibility only. CP2 writers do not populate these fields. */
  parentNodeId?: string
  causationId?: string
  createdAt: number
  updatedAt: number
  status: 'committed' | 'revoked'
  /** Immutable configuration epoch that owned this fact. Missing only on legacy facts. */
  epochId?: string
  taskId?: string
  branchId?: string
  branchKind?: ConversationBranchKind
  forkAnchor?: boolean
}

/** 树控（暂停/恢复）操作状态。 */
export type TreeControlOperationStatus =
  'pausing' | 'paused' | 'resuming' | 'partial' | 'completed' | 'superseded'

export type TreeControlTargetStatus =
  'paused' | 'resuming' | 'resumed' | 'delegated' | 'skipped' | 'failed'

export interface TreeControlTarget {
  chatId: string
  pausedRunId: string
  status: TreeControlTargetStatus
  resumeRunId?: string
  detail?: string
}

export interface TreeControlState {
  pauseId: string
  rootChatId: string
  status: TreeControlOperationStatus
  createdAt: number
  updatedAt: number
  targets: TreeControlTarget[]
}

/** 待处理输入快照（乐观 UI 与服务端快照共用；createdAt 旧快照可缺省）。 */
export interface PendingInputSnapshot {
  /** Present for root snapshots so the client can preserve source identity. */
  chatId?: string
  inputId: string
  clientMessageId?: string
  messageId?: string
  content: string
  createdAt?: number
  state: 'accepted' | 'started' | 'queued' | 'consumed' | 'cancelled' | 'rejected'
  queueSequence?: number
  acceptedAt?: number
  /** rejected 时的人读原因（通知侧携带）。 */
  reason?: string
}

export interface RootTimelineSnapshot {
  rootChatId: string
  taskId?: string
  activeBranchId?: string
  branches?: ConversationBranchSummary[]
  view: 'conversation' | 'tree' | 'audit'
  revision: number
  /** 代际窗口内节点（当前代 + 上一代；orderKey > windowFloor），持久层仍全量 */
  nodes: TimelineNode[]
  edges: ExecutionEdgeFact[]
  activeRuns: ActiveRunFact[]
  pendingInputs: PendingInputSnapshot[]
  /** L0 代际索引（无 compact 时为 []）；更早代经 chat.timeline.generation.get 按需拉取 */
  generations: GenerationEntry[]
  controlState?: TreeControlState
  nextCursor?: string
  capturedEventSeq: number
}
