import type {
  PetAction,
  PetBehavior,
  PetForm,
  PetHands,
  PetMood,
  PetPreset,
  PetTool,
} from './types'
import {
  COLOR_PARTS,
  EMOJI_FACES,
  HAND_PAIRS,
  KAOMOJI_FACES,
  MASTER_NAME_POOL,
  NAME_POOL,
  TALK_PARTS,
  TOOL,
} from './presetData'

/** 主 pet 池（kaomoji face 部件）。 */
export const masterFacePool: Record<PetMood, string>[] = KAOMOJI_FACES
/** 子 pet 池（emoji face 部件）。 */
export const subFacePool: Record<PetMood, string>[] = EMOJI_FACES

/**
 * 灵魂态 face 池（ghost pet 用，子 agent done 后转灵魂态的 emoji）。
 * 与 EMOJI_FACES 里的 ghostFace（普通子 pet 表情，calm 态 👻）语义不同——
 * 此处是「已完成灵魂遗迹」标识，ghost 专属。pickGhostFace 按 tribe 内创建序号顺序取（N % 池长），非随机、不跨实例去重。
 */
export const GHOST_FACES: string[] = [
  '🎏',
  '🚶',
  '🏃',
  '👨‍🦯',
  '👨‍🦼',
  '👨‍🦽',
  '👼',
  '💀',
  '☠️',
  '👻',
  '🧟',
  '🧞',
  '🧛',
]

const normalTools: PetTool[] = [TOOL.pet, TOOL.feed, TOOL.sleep, TOOL.dismiss]

// ===== behaviors（per-action 台词默认） =====

const DEFAULT_BEHAVIORS: Partial<Record<PetAction, PetBehavior>> = {
  dragging: { talks: ['!', '?!', '嘿!'] },
  dropped: { talks: ['oof', '唉', '呜'] },
  clicked: { talks: ['hi!', '♪', 'nice', '嘿', 'yo'] },
}

function withBehaviors(
  override?: Partial<Record<PetAction, PetBehavior>>,
): Partial<Record<PetAction, PetBehavior>> {
  return { ...DEFAULT_BEHAVIORS, ...(override ?? {}) }
}

// ===== 生成器 =====

function pick<T>(items: readonly T[]): T {
  const item = items[Math.floor(Math.random() * items.length)]
  if (item === undefined) {
    throw new Error('Cannot pick from an empty list')
  }
  return item
}

/** 字符串 → 稳定 uint32（DJB2 变体）。主 pet name 按 chatId 确定性取池索引用。
 *  独立于 usePetStyles.hashHue：避 petPresets→usePetStyles→@/stores→petLifecycle→petPresets 循环依赖，
 *  且 hashHue 的 %360 色相截断对任意池长取模有分布偏差。 */
function hashStr(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 33) ^ s.charCodeAt(i)
  }
  return h >>> 0
}

const MOODS = Object.keys(HAND_PAIRS) as PetMood[]

/** 每 mood 从 HAND_PAIRS 独立抽一对,拼成完整 hands 映射(跨 mood 混搭,单 mood L/R 协调)。 */
function buildHands(): Record<PetMood, PetHands> {
  const hands = {} as Record<PetMood, PetHands>
  for (const m of MOODS) {
    hands[m] = pick(HAND_PAIRS[m])
  }
  return hands
}

/** 从 face 池抽取一套，排除 exclude 中已用 face（按对象引用相等）；池耗尽则回退全池（允许重复）。 */
function pickFace(
  pool: readonly Record<PetMood, string>[],
  exclude?: ReadonlySet<Record<PetMood, string>>,
): Record<PetMood, string> {
  const available = exclude ? pool.filter((f) => !exclude.has(f)) : pool
  return pick(available.length > 0 ? available : pool)
}

let genCounter = 0

/**
 * 程序化生成 pet preset:face+hands+color+talks 随机组合。
 * @param form 'kaomoji'=主池(颜文字 face) / 'emoji'=子池(emoji face) / 'random'=按池容量比例纯随机
 * @param excludeFaces 已占用 face 集合（按对象引用相等去重）；传同类已用 face 可避免撞脸。两池不相交，传混合集合亦安全。池耗尽回退全池。
 */
export function generatePet(
  form: PetForm,
  excludeFaces?: ReadonlySet<Record<PetMood, string>>,
  chatId?: string,
): PetPreset {
  const emojiRatio = EMOJI_FACES.length / (KAOMOJI_FACES.length + EMOJI_FACES.length)
  const useEmoji = form === 'emoji' || (form === 'random' && Math.random() < emojiRatio)
  const pool = useEmoji ? EMOJI_FACES : KAOMOJI_FACES
  const face = pickFace(pool, excludeFaces)
  const { color, accent } = pick(COLOR_PARTS)
  const talks = pick(TALK_PARTS)
  let name: string
  if (form === 'kaomoji') {
    // 主 pet：按 chatId 确定性取 MASTER_NAME_POOL，刷新稳定、不同主 pet 大概率异名。
    if (!chatId) throw new Error('generatePet: 主 pet(kaomoji) 必须传 chatId 以确定性取 name')
    name = MASTER_NAME_POOL[hashStr(chatId) % MASTER_NAME_POOL.length]!
  } else {
    // 子 pet：维持 NAME_POOL 随机。
    name = pick(NAME_POOL)
  }
  genCounter += 1
  return {
    id: `${name}-${genCounter}`,
    name,
    color,
    accent,
    faceType: useEmoji ? 'emoji' : 'kaomoji',
    face,
    hands: buildHands(),
    talks,
    tools: normalTools,
    behaviors: withBehaviors(),
  }
}

/** 将角色配置头像应用到子 pet；所有 mood 使用同一字形，保留手势、配色和行为。 */
export function applyRoleAvatar(preset: PetPreset, avatar?: string): PetPreset {
  const glyph = avatar?.trim()
  if (!glyph) return preset
  const face = {} as Record<PetMood, string>
  for (const mood of MOODS) face[mood] = glyph
  return { ...preset, faceType: 'emoji', face }
}
