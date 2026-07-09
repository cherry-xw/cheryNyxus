/**
 * agents store 数据契约类型。
 * 从 stores/agents.ts 抽离（重构）：协议类型与 store 实现分离。
 * - 外部消费（4 .vue + stores/index.ts re-export）：SenseCallRecord / HistoryItem / ApprovalState / StreamState
 * - store 内部协议：StreamChunkData / StagedChunkData / ChunkMessage / NotificationMessage
 */

import type { RuntimeSelection } from "@/services/agentApi";

/** 历史 sense 调用记录（累积到 assistant HistoryItem）。staged 回放一律 done；running/error 留给实时流 CP。 */
export interface SenseCallRecord {
  name: string;
  args?: unknown;
  result?: unknown;
  status: "running" | "done" | "error";
}

/**
 * 历史消息项（chat.get staged 回放累积 + getHistory 合并子 chat）。
 * - role=user：真人发言（主 chat DB 原始 user 行）
 * - role=assistant：主 agent 回复（含 thinking + content + senseCalls）
 * - role=subagent：子 agent 回复。两来源：(a) getHistory 合并子 chat 的 assistant→subagent（携带 subPetChatId）；
 *   (b) streamAccumulator 检测主 chat `[子agent <type>]` 注入前缀（petName=type，无 subPetChatId）
 * - role=master：主 agent 发给子 agent 的消息（getHistory 合并子 chat 的 user→master；主 pet prompt 注入子 chat）
 * petName：subagent(b) 注入式 = agentType；其余 UI 按 subPetChatId 从 pets 查真实 face/name。
 */
export interface HistoryItem {
  role: "user" | "assistant" | "subagent" | "master";
  content: string;
  thinking?: string;
  senseCalls?: SenseCallRecord[];
  /** 标注消息归属的 pet name（subagent(b)注入式=agentType；其余=pet.name 由 UI 查 pets） */
  petName?: string;
  /** master/subagent(合并式) 关联的子 pet chatId；UI 据此从 pets 查真实 face.calm + name。注入式 subagent(b) 无此字段。 */
  subPetChatId?: string;
  /** 该消息的 runtime（user=发送时配置，assistant=前一条 user runtime 后端关联）；hover 详情面板用。缺失显「—」。 */
  runtime?: RuntimeSelection;
  /** 消息创建时间戳（ms），用于合并多 chat 历史时按时间排序 */
  createdAt?: number;
}

/** 当前 chat 的待审批（interrupt 写入；accept/rejected/超时/新轮清空；submit 后 dismissApproval 立即清）。 */
export interface ApprovalState {
  approvalId: string;
  senseName: string;
  args?: unknown;
  /** 审批等待时长（ms，来自 interrupt.waitTime = global.approval_timeout）。0=不超时不显倒计时。 */
  waitTime: number;
  /** 审批发起时间戳（ms，来自 interrupt.createdAt）。倒计时 = waitTime - (now - createdAt)。 */
  createdAt: number;
}

/**
 * 单条 chat 的流式累积状态。
 * CP1 骨架：thinking/content 累积字符串 + isWorking。
 * CP2 细化双气泡（thinking 阶段全空间显 thinking；thinking 结束主气泡 content + 左侧小气泡 thinking）。
 * CP4 history：chat.get staged 回放累积（与实时 stream 累积分流）。
 * CP5 approval：interrupt/accept/rejected 驱动 ApprovalCard。
 */
export interface StreamState {
  thinking: string;
  content: string;
  isWorking: boolean;
  /** 历史消息（chat.get staged 累积；实时流不影响此处）。loaded=true 表示 staged 回放完成。 */
  history: HistoryItem[];
  historyLoaded: boolean;
  /** done 后 content/thinking 气泡保留到期时间戳（ms）。过期隐藏；新消息/abort 清除；hover 期间保持。 */
  retainUntil?: number;
  /** 当前 pending 审批（无则 undefined）。 */
  approval?: ApprovalState;
}

/** stream chunk 携带的 data（实时增量）。 */
export interface StreamChunkData {
  thinking?: string;
  content?: string;
}

/** staged chunk 携带的 data（历史回放，对齐后端 StagedChunkData）。 */
export interface StagedChunkData {
  type: "thinking_end" | "content_end" | "sense_end" | "reverse";
  role?: "user" | "assistant" | "system" | "sense";
  thinking?: string;
  content?: string;
  senseName?: string;
  /** 注意：后端契约是 JSON 字符串（非对象）。 */
  arguments?: string;
  /** sense 调用 id（= sense message.id），用于 content_end role=sense 的结果关联。 */
  id?: string;
  /** content_end 携带：user=发送时配置，assistant=前一条 user runtime（后端关联）。 */
  runtime?: RuntimeSelection;
  /** 消息创建时间戳（ms），用于合并多 chat 历史时按时间排序 */
  createdAt?: number;
}

export interface ChunkMessage {
  kind: "chunk";
  type: "stream" | "staged";
  requestId: string;
  data?: StreamChunkData | StagedChunkData;
}

export interface NotificationMessage {
  kind: "notification";
  type: string;
  requestId: string;
  data?: unknown;
}
