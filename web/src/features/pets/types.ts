import type { RuntimeSelection, ContextBreakdown, CommandConfigDataDto } from "@/services/agentApi";

export type PetMood =
  | "calm"
  | "serious"
  | "happy"
  | "surprised"
  | "sad"
  | "panicked"
  | "angry"
  | "nagging"
  | "curious"
  | "sleepy";

export type PetAction =
  | "walk"
  | "idle"
  | "hover"
  | "dragging"
  | "dropped"
  | "clicked"
  | "chatting"
  | "sleep";

/**
 * 生成器形态参数：'kaomoji' 主池（颜文字 face）/ 'emoji' 子池（emoji face）/ 'random' 其他纯随机（按池容量比例抽）。
 */
export type PetForm = "kaomoji" | "emoji" | "random";

export interface PetHands {
  left: string;
  right: string;
}

export interface PetTool {
  id: string;
  icon: string;
  label: string;
  core?: boolean;
}

export interface PetBehavior {
  talks?: string[];
}

/**
 * 睡觉休息 UI 配置（per-pet 覆盖）。休息(action=sleep)时显示 zzz 浮字 +
 * face=sleepy。默认 zzz="zZ"；角色可覆盖（如 robot⚡充电、byte0xZ）。
 */
export interface PetSleepConfig {
  zzz?: string;
}

export interface PetPreset {
  id: string;
  name: string;
  color: string;
  accent: string;
  /** face 类型：'emoji' 整脸 emoji / 'kaomoji' 颜文字部件。主 pet 刷 kaomoji，子 pet 刷 emoji。 */
  faceType: 'emoji' | 'kaomoji';
  face: Record<PetMood, string>;
  hands: Record<PetMood, PetHands>;
  talks: string[];
  tools: PetTool[];
  behaviors?: Partial<Record<PetAction, PetBehavior>>;
  sleep?: PetSleepConfig;
}

export interface PetInstance extends PetPreset {
  instanceId: string;
  /** 主 pet 标记：主 = 全尺寸 + 持有 summon + 基础 mood serious；子 = 体型缩小（--pet-scale）。 */
  isMaster: boolean;
  /** 部落 id = 本主 pet 的 instanceId。主 pet = 自身 instanceId；子 pet = 其主 instanceId。同 tribe 聚拢、异 tribe 避让。 */
  tribe: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  targetX: number;
  targetY: number;
  width: number;
  height: number;
  direction: 1 | -1;
  mood: PetMood;
  action: PetAction;
  speech: string;
  speechUntil: number;
  moodUntil: number;
  interactionUntil: number;
  lastInteractionAt: number;
  /** 情绪值 0-100：交互驱动，随时间缓降。低值 → sad/angry 基础 mood。CP1 保留为内部 mood 驱动（移除交互增量）。 */
  emotion: number;
  /**
   * 疲劳值 0-100：认知/上下文负担。当前由移动/拖拽累积，≥80 自动休息。
   * 语义逐步让位给 contextUsage（真实 token 上下文）；CP1 两者并存，contextUsage 默认 0。
   */
  fatigue: number;
  dragOffsetX: number;
  dragOffsetY: number;
  draggingPointerId: number | null;
  pairCooldowns: Record<string, number>;
  rapidClicks: number;
  lastClickAt: number;
  // ===== agent 绑定（CP1 新增） =====
  /** 绑定的 chat id（agent 会话实体）。主 pet = 主 agent chat；子 pet = 子 agent chat。 */
  chatId: string;
  /** 子 pet 关联主 pet 的 chatId（主 pet 为 undefined）。 */
  parentChatId?: string;
  /** 角色类型（roles 模块名，主 pet 为 undefined）。 */
  agentType?: string;
  /** 工作状态（流式中）。true 时 pet 视觉显工作态（CP2 双气泡）。 */
  isWorking: boolean;
  /** 上下文用量 0-1（token / brain.contextLimit）。CP1 默认 0 不计算，CP7 接 tokenizer。 */
  contextUsage: number;
  /** 已用 token 数（估算值，字符数/4）。配合 contextTotal 显示 "used/total" 详情。 */
  contextUsed: number;
  /** 上下文上限 token 数（= brain.contextLimit，单位 token）。 */
  contextTotal: number;
  /** 上下文用量 6 段分解（系统/用户系统/记忆/技能/工具定义/用户对话）。undefined = 未就绪/未拉取。 */
  contextBreakdown?: ContextBreakdown;
  /**
   * command 系统配置投影（CommandConfigDataDto）。
   * - enabled / minContextLimit：「不可用」门槛——contextTotal < minContextLimit 或 enabled=false → compact 不可用。
   * - warn：前端视觉提示阈值（contextUsage ≥ warn → 提示态）；不参与后端触发。
   * - auto：自动触发阈值（contextUsage ≥ auto → 强提示，后端会自动压缩）。
   * undefined = 配置未拉取（前容错，按「不限」对待）。
   */
  commandConfig?: CommandConfigDataDto;
  /** 灵魂态（子 agent done 后转 ghost）。true 时 PetSprite 渲染 ghost 形态（缩小+无手+灵魂emoji+微浮+半透明+隐藏status）。刷新据 ChatSummary.finished 重建。 */
  isGhost: boolean;
  /** 灵魂 emoji（转 ghost 时按 tribe 内创建序号顺序取 GHOST_FACES[N % 池长]，非随机去重）。undefined 时 faceGlyph 兜底 👻。 */
  ghostFace?: string;
  /** ghost 创建时间戳（performance.now()）。用于同 tribe ghost 队列排序（老鹰捉小鸡跟随）。 */
  ghostCreatedAt?: number;
  /** agent 运行时配置（brain+senseGroup+mcpServers）。主 pet createMasterPet 设、子 pet role_created 设、AgentDialog runtime.set 后同步；hide 移除 pet / 刷新 initFromChats 不恢复 → undefined。 */
  runtime?: RuntimeSelection;
  /** 预设名（T6）：主 pet 经预设创建时记。AgentDialog 据此显预设名只读 + 切 brain-only（编制锁定）。非预设 pet 为 undefined。 */
  preset?: string;
  /** 末条非 revoked 消息为未完成周期（sense/user/role/subagent）；主 pet idle 时工具栏显"继续"按钮。后端 chat.list canResume 字段。 */
  canResume?: boolean;
  /** Req 8: 气泡斥力增量。isWorking 时 =80，stepMovement 同部落斥力半径 += pet.bubbleRepelExtra + other.bubbleRepelExtra。tickPet chatting 到期清零。 */
  bubbleRepelExtra: number;
}

export interface StageBounds {
  width: number;
  height: number;
}

export type ToolHandler = (pet: PetInstance) => void;
