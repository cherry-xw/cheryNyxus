/**
 * 钢琴键纯布局数据（无 Vue 依赖）。
 * 会话索引 → MIDI → 音名/频率/黑白键/绝对 left，供 NyxusPianoStrip 物理钢琴布局。
 *
 * 锚点：session 索引 0 = MIDI 60（C4）。会话按 createdAt 升序占连续半音键，
 * 故相邻会话落在相邻钢琴键，黑白键天然交替（符合「钢琴键规律」）。
 */

/** C 起步的 12 半音音名（含升号黑键）。 */
export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const

/** session 索引 0 对应的 MIDI（C4 = 中央 C）。 */
export const BASE_MIDI = 60

// 键尺寸常量（px）—— 接近真实钢琴比例（白键长/窄，黑键短/居上）。
export const WHITE_W = 32
export const WHITE_H = 112
export const BLACK_W = 19
export const BLACK_H = 72

/** Product rule: every Nyxus root history item owns exactly one piano key. */
export function sessionPianoKeyCount(historyCount: number): number {
  return Math.max(0, Math.floor(historyCount))
}

/**
 * 琴键只映射原生 root 会话：`!parentChatId`（剔 spawn 子角色）且
 * `branchKind` 缺省或 'original'（剔延续/解释分支）。分支会话（chat.branch.create
 * 产物）本身是无 parentChatId 的独立 root chat，仅靠 `!parentChatId` 过滤不掉，
 * 必须按 branchKind 显式剔除；被激活为主干的 continuation 也不占琴键
 * （约定见 docs/web/pet/rendering.md NyxusPianoStrip 章节）。
 */
export function isPianoRootSession(c: {
  parentChatId?: string | null
  branchKind?: 'original' | 'continuation' | 'detail'
}): boolean {
  return !c.parentChatId && (!c.branchKind || c.branchKind === 'original')
}

/** 每八度半音键数（12）。 */
export const OCTAVE_KEYS = 12
/** 每八度白键数（7）。 */
export const WHITE_PER_OCTAVE = 7
/** 键盘档位上下限（1/2/3 八度 = 小/中/大键盘）。 */
export const MIN_OCTAVES = 1
export const MAX_OCTAVES = 3

/**
 * 视口宽度 -> 整八度档位（1/2/3）。
 * 取视口能容纳的最大整八度（白键容量 / 7 向下取整），clamp 到 [1,3]；
 * 视口窄于 1 八度时取小档（1 八度，超出部分由调用方拖拽）。
 */
export function keyboardOctaveCount(viewportW: number): number {
  if (viewportW <= 0) return MIN_OCTAVES
  const whiteCapacity = Math.floor(viewportW / WHITE_W)
  return Math.max(MIN_OCTAVES, Math.min(MAX_OCTAVES, Math.floor(whiteCapacity / WHITE_PER_OCTAVE)))
}

/** 视口宽度 -> 档位键数（12/24/36 = 1/2/3 八度）。 */
export function keyboardKeyCount(viewportW: number): number {
  return keyboardOctaveCount(viewportW) * OCTAVE_KEYS
}

/** 半音音名（不含八度），如 "C"、"C#"。 */
export function noteShortName(midi: number): string {
  return NOTE_NAMES[((midi % 12) + 12) % 12]!
}

/** 音名 + 八度，如 "C4"、"A4"。MIDI 八度 = floor(midi/12) - 1。 */
export function noteName(midi: number): string {
  const octave = Math.floor(midi / 12) - 1
  return `${noteShortName(midi)}${octave}`
}

/** 等程频率：A4(69)=440Hz。 */
export function noteFrequency(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12)
}

/** 是否黑键（C#/D#/F#/G#/A# = 半音序 1/3/6/8/10）。 */
export function isBlackKey(midi: number): boolean {
  const s = ((midi % 12) + 12) % 12
  return s === 1 || s === 3 || s === 6 || s === 8 || s === 10
}

export interface PianoKeyGeom {
  /** 对应会话索引（0-based，按 createdAt 升序）。 */
  index: number
  midi: number
  /** 含八度音名，如 "C4"。 */
  name: string
  /** 不含八度，如 "C#"。 */
  shortName: string
  freq: number
  isBlack: boolean
  /** 相对轨左缘的绝对 left（px）。 */
  left: number
  width: number
  height: number
  /** 黑键叠在白键之上。 */
  z: number
}

/**
 * 计算前 count 条会话对应的钢琴键几何。
 * 白键从左累加；黑键落在相邻两白键边界（中心 = 下一白键左缘）。
 *
 * fillWidth>0（fit 模式）：白键按比例均分填满 fillWidth，末键右缘 = fillWidth，
 *   消除琴轨与视口宽不匹配的右侧空隙；黑键宽按白键宽同比例缩放。
 * fillWidth=0（默认/溢出）：固定 WHITE_W，轨宽 = 白键数 × WHITE_W，溢出由调用方拖拽。
 */
export function layoutPianoKeys(
  count: number,
  opts: { fillWidth?: number } = {},
): {
  keys: PianoKeyGeom[]
  trackWidth: number
} {
  const fill = opts.fillWidth ?? 0
  const fillMode = fill > 0
  // 白键总数：fit 模式均分分母。
  let whiteCount = 0
  for (let i = 0; i < count; i++) if (!isBlackKey(BASE_MIDI + i)) whiteCount++
  const whiteW = fillMode ? fill / whiteCount : WHITE_W
  const blackW = Math.round((whiteW * BLACK_W) / WHITE_W)
  // 第 w 个白键（0-based）左缘：fit 模式按比例取整（末键右缘 = fill，0 空隙）。
  const whiteLeftAt = (w: number): number =>
    fillMode ? Math.round((w * fill) / whiteCount) : w * WHITE_W

  const keys: PianoKeyGeom[] = []
  let whiteSeq = 0 // 已放置白键数 = 下一白键序号
  for (let i = 0; i < count; i++) {
    const midi = BASE_MIDI + i
    const black = isBlackKey(midi)
    if (black) {
      // 黑键中心 = 下一白键左缘（已放置白键数对应的左缘），骑在白-白边界上。
      const center = whiteLeftAt(whiteSeq)
      keys.push({
        index: i,
        midi,
        name: noteName(midi),
        shortName: noteShortName(midi),
        freq: noteFrequency(midi),
        isBlack: true,
        left: center - blackW / 2,
        width: blackW,
        height: BLACK_H,
        z: 2,
      })
    } else {
      const left = whiteLeftAt(whiteSeq)
      const right = whiteLeftAt(whiteSeq + 1)
      keys.push({
        index: i,
        midi,
        name: noteName(midi),
        shortName: noteShortName(midi),
        freq: noteFrequency(midi),
        isBlack: false,
        left,
        width: right - left,
        height: WHITE_H,
        z: 1,
      })
      whiteSeq++
    }
  }
  const trackWidth = fillMode ? fill : whiteCount * WHITE_W
  return { keys, trackWidth }
}
