/**
 * agents store 数据契约类型。
 * 从 stores/agents.ts 抽离（重构）：协议类型与 store 实现分离。
 * - 外部消费（4 .vue + stores/index.ts re-export）：SenseCallRecord / HistoryItem / ApprovalState / StreamState
 * - store 内部协议：StreamChunkData / StagedChunkData / ChunkMessage / NotificationMessage
 */

import type { RuntimeSelection } from "@/services/agentApi";

/** 消息内嵌媒体引用（从 content/result 解析 `/api/media/` URL）。 */
export interface MediaAssetRef {
  /** 媒体文件名（如 `uuid.mp4`），对应 `/api/media/<filename>` */
  filename: string;
  /** 媒体类型 */
  kind: "image" | "video" | "audio";
  /** MIME 类型（如 `video/mp4`） */
  mimeType: string;
}

/** 历史 sense 调用记录（累积到 assistant HistoryItem）。staged 回放一律 done；running/error 留给实时流 CP。 */
export interface SenseCallRecord {
  /** sense message 主键（与后端 LLMResponse.id 对齐）；旧 staged 缺省。 */
  id?: string;
  name: string;
  args?: unknown;
  result?: unknown;
  status: "running" | "done" | "error";
  /** sense 执行结果内嵌的媒体资产（从 result 字符串解析） */
  mediaAssets?: MediaAssetRef[];
}

/** 运行中工具（sense_started push；accept 按 id 移除；done/error 清空）。id=sense 调用 id。 */
export interface RunningTool {
  id: string;
  name: string;
}

/**
 * 历史消息项（chat.get staged 回放累积 + getHistory 合并子 chat）。
 * - role=user：真人发言（主 chat DB 原始 user 行）
 * - role=assistant：主 agent 回复（含 thinking + content + senseCalls）
 * - role=role（旧历史为 subagent）：角色（子 pet）回复。两来源：(a) getHistory 合并子 chat 的 assistant→role（携带 subPetChatId）；
 *   (b) 主 chat 的角色回传（无 subPetChatId）。两者内容相同仅在主历史 UI 层合并，不改变协议。
 * - role=master：主 agent 发给角色的消息（getHistory 合并子 chat 的 user→master；主 pet prompt 注入子 chat）
 * petName：role(b) 注入式 = agentType；其余 UI 按 subPetChatId 从 pets 查真实 face/name。
 */
export interface HistoryItem {
  role: "user" | "assistant" | "role" | "subagent" | "master";
  content: string;
  thinking?: string;
  senseCalls?: SenseCallRecord[];
  /** 消息内嵌媒体资产（从 content 中的 `/api/media/<filename>` URL 解析） */
  mediaAssets?: MediaAssetRef[];
  /** 标注消息归属的 pet name（role(b)注入式=agentType；其余=pet.name 由 UI 查 pets） */
  petName?: string;
  /** master/role(合并式) 关联的子 pet chatId；UI 据此从 pets 查真实 face.calm + name。注入式 role(b) 无此字段。 */
  subPetChatId?: string;
  /**
   * master/role 合并式 caller 信息（上层 sub pet chatId；undefined 视为 master）。
   * 多级 spawn 时，B 被 A 唤起 → B 的 role 回复 callerSubPetChatId = A.chatId。
   * UI 据此从 pets 查 caller face/name → MessageBubble 徽章显示上级 sub pet（不再是主 pet）。
   */
  callerSubPetChatId?: string;
  /**
   * 标记该 HistoryItem 是合并产物（HistoryDrawer.mergeChildToMaster 写入，渲染层据此切分支）。
   * 仅 layout=group 时触发；direct 视图无此标记。
   */
  mergedView?: "child-to-master";
  /**
   * spawn sense call id（role_reply notification 可携带；前端跳到触发该角色的工具调用用）。
   * role_reply notification 注入时也会带此字段。
   */
  spawnSenseCallId?: string;
  /** 该消息的 runtime（user=发送时配置，assistant=前一条 user runtime 后端关联）；hover 详情面板用。缺失显「—」。 */
  runtime?: RuntimeSelection;
  /** 消息创建时间戳（ms），用于合并多 chat 历史时按时间排序 */
  createdAt?: number;
  /**
   * 消息主键 msgId（= 后端 messages.id）。
   * 用途：getHistory 合流时防止同一物理消息重复加入。旧历史或缺失 staged 字段时可省略。
   */
  msgId?: string;
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
 * CP5 approval：interrupt/accept/rejected 驱动 ApprovalCard；approvalQueue 保存被用户关闭但未处理的审批供重新唤起。
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
  /** 当前 pending 审批（无则 undefined）。被用户 Accept/Reject/✕ 关闭时移到 approvalQueue 或清空。 */
  approval?: ApprovalState;
  /**
   * 已隐藏但未处理的审批队列（CP5 扩展）：用户点 ✕ 关闭、新轮 sendMessage 触发、服务端并发 interrupt 等场景下保留审批不丢失。
   * - 渲染为 PetIcons 右侧 approval 列的闪烁 icon（频率=剩余时间）
   * - 点击 icon → 移到 `approval` 重新唤起气泡
   * - 自动推进：Accept/Reject 后从 queue head pop 下一个进 `approval`
   * - 服务端 accept/rejected notification 到达时按 approvalId 在 `approval` + `approvalQueue` 中查找移除
   */
  approvalQueue: ApprovalState[];
  /** 运行中工具（sense_started push；accept 按 id 移除；done/error 清空）。供 pet bar 右侧 RunningTools 显 icon。 */
  runningTools: RunningTool[];
  /**
   * 流式错误（P3 新增）。三个写入路径：
   * - sendMessage/resumeAgent 捕获 done Promise：final Response.success:false 时写入 res.error?.message
   * - routeNotification error 分支：error notification 到达时写入（流中即时）
   * - 网络中断：done.catch(e) 写入 "连接中断: ..."
   * PetSprite 据 v-if 显 error-bubble（红边浅红底）。sendMessage 入口清空（确保新轮不残留）。
   */
  error?: string;
}

/** stream chunk 携带的 data（实时增量）。 */
export interface StreamChunkData {
  thinking?: string;
  content?: string;
}

/** staged chunk 携带的 data（历史回放，对齐后端 StagedChunkData）。 */
export interface StagedChunkData {
  type: "thinking_end" | "content_end" | "sense_end" | "reverse";
  role?: "user" | "assistant" | "system" | "sense" | "role" | "subagent"; // role=新（子 pet 回复）；subagent 仅旧历史兼容
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
  /**
   * 消息主键 msgId（= 后端 messages.id 主键）。
   * 用途：合流主+子 chat 历史时按 msgId 去重（如 main chat 的 role:role 行 vs child chat 的 assistant→role 改写行 msgId 重复）。
   * 历史 DB 写入早于后端 E 改动时为 undefined，前端按现有行为兼容。
   */
  msgId?: string;
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
