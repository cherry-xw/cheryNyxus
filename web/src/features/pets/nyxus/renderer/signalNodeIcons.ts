import type { Graphics } from 'pixi.js'
import type { SignalNodeVisualKind } from '../graph/executionPresentation'

/**
 * Signal 节点类型徽记矩阵（2026-09-02 二轮返工）。
 *
 * 零文本原则：类型辨识 100% 靠几何徽记——每个 SignalNodeVisualKind 一个独特
 * canvas 图形（预设 Graphics path，设计心智同 SVG icon，落地为 canvas path）。
 * 全直角红线：所有徽记仅由直角折线/矩形构成，无圆角、无斜线圆弧（播放/箭头
 * 一律用直角 chevron 表达）。
 *
 * 底板（56×40 统一直角矩形 + 左右端口）与状态色覆盖由 `drawSignalNode` 统一
 * 绘制；本库只负责框内徽记本身。
 */

/** 徽记绘制上下文：cx/cy 为节点中心，accent 为主色（类型色或状态覆盖色）。 */
export interface SignalIconContext {
  cx: number
  cy: number
  halfW: number
  halfH: number
  accent: number
  alpha: number
  /** fold 徽记密度格数量（由 foldCount 派生，其余类型忽略）。 */
  density?: number
}

export type SignalNodeIconPainter = (g: Graphics, ctx: SignalIconContext) => void

/** 折线段（可含多个 moveTo 开头的子路径：传入负号坐标标记断笔？——不，多子路径直接多次调用）。 */
function line(g: Graphics, ctx: SignalIconContext, points: number[], width = 1.4, alphaScale = 1): void {
  for (let i = 0; i < points.length; i += 2) {
    const x = points[i]!
    const y = points[i + 1]!
    if (i === 0) g.moveTo(x, y)
    else g.lineTo(x, y)
  }
  g.stroke({ color: ctx.accent, width, alpha: alphaScale * ctx.alpha })
}

/** accent 实心直角块。 */
function block(g: Graphics, ctx: SignalIconContext, x: number, y: number, w: number, h: number, alphaScale = 1): void {
  g.rect(x, y, w, h).fill({ color: ctx.accent, alpha: alphaScale * ctx.alpha })
}

/** accent 描边直角框。 */
function frame(g: Graphics, ctx: SignalIconContext, x: number, y: number, w: number, h: number, width = 1.4, alphaScale = 1): void {
  g.rect(x, y, w, h).stroke({ color: ctx.accent, width, alpha: alphaScale * ctx.alpha })
}

/** 直角 chevron（右向）。 */
function chevron(g: Graphics, ctx: SignalIconContext, x: number, y: number, half: number, width = 1.6, alphaScale = 1): void {
  line(g, ctx, [x, y - half, x + half, y, x, y + half], width, alphaScale)
}

/**
 * 统一底板内的徽记矩阵。绘制区域约 42×30（底板 56×40 内缩 7/5）。
 * 每个类型的造型语义见 docs/web/pet/rendering.md「Signal Grid 渲染分支」矩阵全表。
 */
export const SIGNAL_NODE_ICONS: Record<SignalNodeVisualKind, SignalNodeIconPainter> = {
  // 任务起点：左缘立柱 + 双右向 chevron（引导流出发）。
  start(g, ctx) {
    const { cx, cy } = ctx
    block(g, ctx, cx - 21, cy - 9, 2.5, 18, 0.9)
    chevron(g, ctx, cx - 8, cy, 7, 1.6)
    chevron(g, ctx, cx + 2, cy, 7, 1.6, 0.55)
  },

  // 我的指令：左侧粗立柱 + 单条指令行横杠。
  input(g, ctx) {
    const { cx, cy } = ctx
    block(g, ctx, cx - 21, cy - 9, 3.5, 18, 0.95)
    block(g, ctx, cx - 13, cy - 2, 20, 3, 0.85)
    block(g, ctx, cx - 13, cy + 5, 12, 2, 0.4)
  },

  // 回复：双横杠（消息行）+ 右缘 chevron（输出发出）。
  reply(g, ctx) {
    const { cx, cy } = ctx
    block(g, ctx, cx - 21, cy - 7, 16, 2.5, 0.85)
    block(g, ctx, cx - 21, cy - 1, 12, 2.5, 0.5)
    chevron(g, ctx, cx + 3, cy + 4, 6, 1.6)
  },

  // 错误：四段式断续边框 + 内部 X 刻痕（配色由状态覆盖为红）。
  error(g, ctx) {
    const { cx, cy } = ctx
    const x0 = cx - 19
    const x1 = cx + 19
    const y0 = cy - 12
    const y1 = cy + 12
    const arm = 7
    line(g, ctx, [x0, y0 + arm, x0, y0, x0 + arm, y0], 1.6)
    line(g, ctx, [x1 - arm, y0, x1, y0, x1, y0 + arm], 1.6)
    line(g, ctx, [x1, y1 - arm, x1, y1, x1 - arm, y1], 1.6)
    line(g, ctx, [x0 + arm, y1, x0, y1, x0, y1 - arm], 1.6)
    line(g, ctx, [cx - 6, cy - 5, cx + 6, cy + 5], 1.5)
    line(g, ctx, [cx + 6, cy - 5, cx - 6, cy + 5], 1.5)
  },

  // 过程组：三片层叠背板 + 底部密度格（N 个 2px 方块，无数字）。
  fold(g, ctx) {
    const { cx, cy, density } = ctx
    frame(g, ctx, cx - 17, cy - 10, 26, 14, 1.3, 0.35)
    frame(g, ctx, cx - 15, cy - 12, 26, 14, 1.3, 0.6)
    frame(g, ctx, cx - 13, cy - 14, 26, 14, 1.4)
    const count = Math.max(3, Math.min(8, density ?? 3))
    for (let tick = 0; tick < count; tick += 1) {
      block(g, ctx, cx - 13 + tick * 4, cy + 7, 2, 5, 0.45 + tick / count / 2)
    }
  },

  // 协作过程：窄条徽记（单框 + 中心竖杠）。
  process(g, ctx) {
    const { cx, cy } = ctx
    frame(g, ctx, cx - 18, cy - 7, 10, 14, 1.4)
    block(g, ctx, cx + 2, cy - 9, 2, 18, 0.85)
  },

  // 任务委派：一分二直角枝杈。
  dispatch(g, ctx) {
    const { cx, cy } = ctx
    const forkX = cx - 10
    const tipX = cx + 17
    line(g, ctx, [cx - 21, cy, forkX, cy], 1.6)
    line(g, ctx, [forkX, cy, forkX, cy - 8, tipX, cy - 8], 1.4)
    line(g, ctx, [forkX, cy, forkX, cy + 8, tipX, cy + 8], 1.4)
    block(g, ctx, tipX, cy - 11, 2.5, 6, 0.9)
    block(g, ctx, tipX, cy + 5, 2.5, 6, 0.9)
  },

  // 结果返回：二合一直角收束。
  return(g, ctx) {
    const { cx, cy } = ctx
    const tipX = cx + 21
    line(g, ctx, [cx - 21, cy - 8, cx - 10, cy - 8, cx - 10, cy], 1.4)
    line(g, ctx, [cx - 21, cy + 8, cx - 10, cy + 8, cx - 10, cy], 1.4)
    line(g, ctx, [cx - 10, cy, tipX, cy], 1.6)
    chevron(g, ctx, tipX - 5, cy, 4.5, 1.5)
  },

  // 系统事件：方框内栅格刻线。
  system(g, ctx) {
    const { cx, cy } = ctx
    const x0 = cx - 12
    const y0 = cy - 9
    frame(g, ctx, x0, y0, 24, 18, 1.4)
    line(g, ctx, [x0 + 8, y0, x0 + 8, y0 + 18], 1, 0.55)
    line(g, ctx, [x0 + 16, y0, x0 + 16, y0 + 18], 1, 0.55)
    line(g, ctx, [x0, cy, x0 + 24, cy], 1, 0.55)
  },

  // 终端：`>` 形刻痕 + 底线。
  'tool-command'(g, ctx) {
    const { cx, cy } = ctx
    line(g, ctx, [cx - 12, cy - 7, cx - 4, cy, cx - 12, cy + 7], 1.7)
    line(g, ctx, [cx + 0, cy + 7, cx + 14, cy + 7], 1.5)
  },

  // 读取：文件框 + 文本行横杠 + 外向读取 chevron。
  'tool-read'(g, ctx) {
    const { cx, cy } = ctx
    frame(g, ctx, cx - 16, cy - 9, 18, 18, 1.4)
    block(g, ctx, cx - 13, cy - 4, 12, 2, 0.6)
    block(g, ctx, cx - 13, cy + 1, 12, 2, 0.6)
    chevron(g, ctx, cx + 5, cy, 5, 1.5, 0.8)
  },

  // 写入：文件框 + 对角落笔刻线 + 笔尖方块。
  'tool-write'(g, ctx) {
    const { cx, cy } = ctx
    frame(g, ctx, cx - 16, cy - 9, 18, 18, 1.4)
    line(g, ctx, [cx - 13, cy + 6, cx - 1, cy - 6], 1.5)
    block(g, ctx, cx - 1, cy - 9, 4, 4, 0.9)
  },

  // 搜索：四角取景框 + 中心方块。
  'tool-search'(g, ctx) {
    const { cx, cy } = ctx
    const x0 = cx - 16
    const x1 = cx + 16
    const y0 = cy - 9
    const y1 = cy + 9
    const arm = 6
    line(g, ctx, [x0, y0 + arm, x0, y0, x0 + arm, y0], 1.5)
    line(g, ctx, [x1 - arm, y0, x1, y0, x1, y0 + arm], 1.5)
    line(g, ctx, [x1, y1 - arm, x1, y1, x1 - arm, y1], 1.5)
    line(g, ctx, [x0 + arm, y1, x0, y1, x0, y1 - arm], 1.5)
    block(g, ctx, cx - 2, cy - 2, 4, 4, 0.95)
  },

  // 技能：三段上升阶梯纹。
  'tool-skill'(g, ctx) {
    const { cx, cy } = ctx
    line(
      g,
      ctx,
      [cx - 16, cy + 8, cx - 9, cy + 8, cx - 9, cy + 1, cx - 2, cy + 1, cx - 2, cy - 6, cx + 5, cy - 6],
      1.5,
    )
    block(g, ctx, cx + 8, cy - 8, 3, 3, 0.9)
  },

  // 派生协作：芯点分形（大方框内小方框）。
  'tool-spawn'(g, ctx) {
    const { cx, cy } = ctx
    frame(g, ctx, cx - 14, cy - 10, 24, 20, 1.4)
    block(g, ctx, cx - 3, cy - 4, 7, 8, 0.85)
  },

  // 媒体：播放框 + 直角快进 chevron。
  'tool-media'(g, ctx) {
    const { cx, cy } = ctx
    frame(g, ctx, cx - 15, cy - 9, 30, 18, 1.4)
    chevron(g, ctx, cx - 5, cy, 5, 1.5, 0.85)
    chevron(g, ctx, cx + 3, cy, 5, 1.5, 0.85)
  },

  // 问询：右侧开槽方框 + 问号杆点。
  'tool-question'(g, ctx) {
    const { cx, cy } = ctx
    const x0 = cx - 13
    const y0 = cy - 9
    line(g, ctx, [x0 + 12, y0, x0, y0, x0, y0 + 18, x0 + 12, y0 + 18], 1.4)
    line(g, ctx, [x0 + 20, y0, x0 + 24, y0, x0 + 24, y0 + 18, x0 + 20, y0 + 18], 1.4, 0.5)
    block(g, ctx, cx - 1, cy - 6, 2, 7, 0.9)
    block(g, ctx, cx - 1, cy + 4, 2, 2, 0.9)
  },

  // 计划：勾选格阵（首格带直角勾）。
  'tool-todo'(g, ctx) {
    const { cx, cy } = ctx
    frame(g, ctx, cx - 16, cy - 9, 7, 7, 1.3)
    frame(g, ctx, cx - 5, cy - 9, 7, 7, 1.3, 0.5)
    frame(g, ctx, cx - 16, cy + 1, 7, 7, 1.3, 0.5)
    frame(g, ctx, cx - 5, cy + 1, 7, 7, 1.3, 0.5)
    line(g, ctx, [cx - 15, cy - 5, cx - 13, cy - 3, cx - 10, cy - 8], 1.4)
  },

  // 通用工具：芯片 + 四边引脚。
  'tool-generic'(g, ctx) {
    const { cx, cy } = ctx
    frame(g, ctx, cx - 6, cy - 6, 12, 12, 1.4)
    for (const offset of [-3, 0, 3]) {
      line(g, ctx, [cx - 13, cy + offset, cx - 6, cy + offset], 1, 0.7)
      line(g, ctx, [cx + 6, cy + offset, cx + 13, cy + offset], 1, 0.7)
      line(g, ctx, [cx + offset, cy - 11, cx + offset, cy - 6], 1, 0.7)
      line(g, ctx, [cx + offset, cy + 6, cx + offset, cy + 11], 1, 0.7)
    }
  },
}
