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
  /** 情绪值 0-100：交互驱动，随时间缓降。低值 → sad/angry 基础 mood。 */
  emotion: number;
  /**
   * 疲劳值 0-100：认知/上下文负担。当前由移动/拖拽/聊天累积，≥80 自动休息。
   * 未来 pet 作为 agent 显示层时，由真实 token 上下文量驱动（上下文越长越累）。
   */
  fatigue: number;
  dragOffsetX: number;
  dragOffsetY: number;
  draggingPointerId: number | null;
  pairCooldowns: Record<string, number>;
  rapidClicks: number;
  lastClickAt: number;
}

export interface StageBounds {
  width: number;
  height: number;
}

export type ToolHandler = (pet: PetInstance) => void;
