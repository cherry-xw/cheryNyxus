import type { PetInstance, StageBounds } from '../types/types'

/**
 * pet 运动学算法（纯函数，不依赖 reactive）。
 *
 * 与 usePetWorld 的策略/状态机分离：usePetWorld 选 target（retarget）+ 状态机
 * （sleep/hover/chatting 不进入移动），petMovement 负责"给定 target + 近邻，算
 * 这一帧的物理移动"。
 *
 * 力积分模型：加速度（seek 朝 target）+ 部落间力（同/异部落 × 引力/斥力）→ 速度
 * （damping + maxSpeed）→ 位置。靠近时斥力随距离线性渐增，速度渐变方向 → 平滑
 * 远离（非位置硬修正瞬移）。vx/vy 持久积分（有惯性），非每帧覆盖。
 */

export const PET_WIDTH = 72
export const PET_HEIGHT = 96
export const GHOST_QUEUE_SPACING = 32

export function ghostTrailDistance(index: number): number {
  return (Math.max(0, index) + 1) * GHOST_QUEUE_SPACING
}

// 移动
const MAX_SPEED = 10 // 移动速度上限 px/s
const ACCELERATION = 80 // 加速度 px/s²（seek 朝 target 的驱动力）
// 部落力（按 tribe 同异分施）
const TRIBE_ATTRACT = 50 // 同部落引力（环带内拉拢，斥力边界处衰减为0，不冲入斥力区）
const TRIBE_REPEL = 300 // 同部落斥力（REPEL_RADIUS 内线性渐增；峰值下调避免近距速度饱和弹射）
const OTHER_ATTRACT = 0 // 异部落引力（0 = 不吸引异部落）
const OTHER_REPEL = 450 // 异部落斥力（ATTRACT_RADIUS 内分离；峰值下调避免弹射）
// 作用半径
const REPEL_RADIUS = 120 // 同部落斥力半径（近距不重叠）
const ATTRACT_RADIUS = 200 // 引力半径（同部落聚拢 / 异部落分离范围）
// 积分（机械常量）
const DAMPING = 0.9 // 每帧（60fps 基准）速度衰减，dt 归一化
const ARRIVE_RADIUS = 12 // 到达 target → idle
const DIRECTION_THRESHOLD = 8 // |vx| > 此才翻朝向，避免抖动
// 初始位排斥采样
const MIN_SPAWN_GAP = 100 // 生成时最小中心距（> REPEL_RADIUS，出生即不斥力）
const SPAWN_SEARCH_RADIUS = 140 // 落点附近搜索半径
const SPAWN_ATTEMPTS = 14

export interface MovementOptions {
  /** 速度上限（px/s），调用方按 mood/个体差异传入。 */
  maxSpeed?: number
  /** 加速度 px/s²（seek 朝 target 的驱动力）。 */
  acceleration?: number
  /** 同部落引力（环带内拉拢聚拢）。 */
  tribeAttract?: number
  /** 同部落斥力（repelRadius 内线性渐增）。 */
  tribeRepel?: number
  /** 异部落引力（0 = 不吸引异部落）。 */
  otherAttract?: number
  /** 异部落斥力（attractRadius 内分离）。 */
  otherRepel?: number
  /** 同部落斥力半径（近距不重叠）。 */
  repelRadius?: number
  /** 引力半径（同部落聚拢 / 异部落分离范围）。 */
  attractRadius?: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

/** 边界约束（y 下界 42 留舞台顶部 UI 空间）。drag 亦复用。 */
export function keepInBounds(pet: PetInstance, bounds: StageBounds): void {
  pet.x = clamp(pet.x, 0, Math.max(0, bounds.width - pet.width))
  pet.y = clamp(pet.y, 42, Math.max(42, bounds.height - pet.height))
}

/**
 * 一帧运动学积分：seek + repulsion → 速度 → 位置 → 边界 → 朝向。
 * 调用方负责状态机（sleep/hover/chatting/dragging 不调用本函数）与到达判定。
 * neighbors 含全部 pet；本函数跳过自身与 chatting 中的 other（聊天对不被推开）。
 */
export function stepMovement(
  pet: PetInstance,
  neighbors: readonly PetInstance[],
  bounds: StageBounds,
  dt: number,
  opts: MovementOptions = {},
): void {
  const maxSpeed = opts.maxSpeed ?? MAX_SPEED
  const acceleration = opts.acceleration ?? ACCELERATION
  const tribeAttract = opts.tribeAttract ?? TRIBE_ATTRACT
  const tribeRepel = opts.tribeRepel ?? TRIBE_REPEL
  const otherAttract = opts.otherAttract ?? OTHER_ATTRACT
  const otherRepel = opts.otherRepel ?? OTHER_REPEL
  const repelRadius = opts.repelRadius ?? REPEL_RADIUS
  const attractRadius = opts.attractRadius ?? ATTRACT_RADIUS

  let ax = 0
  let ay = 0

  // seek：朝 target（加速度驱动）
  const sdx = pet.targetX - pet.x
  const sdy = pet.targetY - pet.y
  const sdist = Math.hypot(sdx, sdy)
  if (sdist > 0.001) {
    ax += (sdx / sdist) * acceleration
    ay += (sdy / sdist) * acceleration
  }

  // 部落力：按 tribe 同异分施引力/斥力
  const cx = pet.x + pet.width / 2
  const cy = pet.y + pet.height / 2
  for (const other of neighbors) {
    if (other.instanceId === pet.instanceId) continue
    if (other.action === 'chatting') continue
    // ghost 是纯装饰长尾（弹簧跟随首领 trail），不参与任何部落力——
    // 否则 master 会被自己身后的 ghost 推斥跑、ghost 又追 master trail → 永久追逐。
    if (other.isGhost) continue
    const dx = cx - (other.x + other.width / 2)
    const dy = cy - (other.y + other.height / 2)
    const d = Math.hypot(dx, dy)
    if (d < 0.001) continue
    const sameTribe = pet.tribe === other.tribe
    const attract = sameTribe ? tribeAttract : otherAttract
    const repel = sameTribe ? tribeRepel : otherRepel
    // 斥力半径：同部落 repelRadius（近距不重叠）+ 双方 bubbleRepelExtra（Req 8: 有气泡时增大间距）
    const repelR = sameTribe
      ? repelRadius + pet.bubbleRepelExtra + other.bubbleRepelExtra
      : attractRadius
    const ux = dx / d // 远离方向
    const uy = dy / d
    if (d < repelR) {
      // 斥力：随距离线性渐增，近距推开
      const f = (1 - d / repelR) * repel
      ax += ux * f
      ay += uy * f
    } else if (d < attractRadius && attract > 0) {
      // 引力：环带内朝对方拉拢，斥力边界处衰减为0（pet 减速靠近、停在斥力区外，不冲入过冲）
      const t = (d - repelR) / (attractRadius - repelR)
      const f = attract * t
      ax -= ux * f
      ay -= uy * f
    }
  }

  // 积分
  pet.vx += ax * dt
  pet.vy += ay * dt

  // damping（帧率无关：按 60fps 基准归一化）
  const damp = Math.pow(DAMPING, dt * 60)
  pet.vx *= damp
  pet.vy *= damp

  // 限速
  const sp = Math.hypot(pet.vx, pet.vy)
  if (sp > maxSpeed && sp > 0.001) {
    pet.vx = (pet.vx / sp) * maxSpeed
    pet.vy = (pet.vy / sp) * maxSpeed
  }

  // 位置
  pet.x += pet.vx * dt
  pet.y += pet.vy * dt

  // 朝向（滞回，避免低速频繁翻向抖动）
  if (Math.abs(pet.vx) > DIRECTION_THRESHOLD) {
    pet.direction = pet.vx >= 0 ? 1 : -1
  }

  keepInBounds(pet, bounds)
}

/** 到达 target 判定（调用方用于切 idle 并清零速度）。 */
export function arrivedAtTarget(pet: PetInstance): boolean {
  const dx = pet.targetX - pet.x
  const dy = pet.targetY - pet.y
  return Math.hypot(dx, dy) < ARRIVE_RADIUS
}

/**
 * 初始位排斥采样：在 center 附近找距所有现有 pet 中心 ≥ MIN_SPAWN_GAP 的点。
 * 找到即返回；找不到退化为"最远点"。避免生成时就重叠（初始太近根因）。
 */
export function findSpawnPosition(
  center: { x: number; y: number },
  pets: readonly PetInstance[],
  bounds: StageBounds,
): { x: number; y: number } {
  const minX = 0
  const maxX = Math.max(minX, bounds.width - PET_WIDTH)
  const minY = 42
  const maxY = Math.max(minY, bounds.height - PET_HEIGHT)

  const fallback = {
    x: clamp(center.x, minX, maxX),
    y: clamp(center.y, minY, maxY),
  }
  let best = fallback
  let bestMin = -Infinity

  for (let i = 0; i < SPAWN_ATTEMPTS; i += 1) {
    const cand = {
      x: clamp(center.x + rand(-SPAWN_SEARCH_RADIUS, SPAWN_SEARCH_RADIUS), minX, maxX),
      y: clamp(center.y + rand(-SPAWN_SEARCH_RADIUS, SPAWN_SEARCH_RADIUS), minY, maxY),
    }
    const ccx = cand.x + PET_WIDTH / 2
    const ccy = cand.y + PET_HEIGHT / 2
    let minD = Infinity
    for (const p of pets) {
      const d = Math.hypot(ccx - (p.x + p.width / 2), ccy - (p.y + p.height / 2))
      if (d < minD) minD = d
    }
    if (minD === Infinity) return cand // 无其他 pet
    if (minD >= MIN_SPAWN_GAP) return cand
    if (minD > bestMin) {
      best = cand
      bestMin = minD
    }
  }
  return best
}

// ===== ghost 队列路径拟合 trail（主 Agent 带队） =====
// 纯函数：主 Agent 移动轨迹采样 + 弧长取点。状态由 usePetWorld 闭包 Map<tribe, GhostTrail> 持有。

export interface GhostTrail {
  /** newest-first：pts[0] = 主 Agent 当前位，末尾 = 最旧。 */
  pts: { x: number; y: number }[]
}
const TRAIL_SAMPLE_GAP = 6 // 距离阈值采样：移动 >6px 才记新点（保持 trail 稀疏，弧长有意义）
const TRAIL_MAX_PTS = 80 // 点数上限（足够 ~10 跟随者 × 80px 间距 + 余量）

/**
 * 首领位移喂入 trail（距离阈值采样 + 点数上限截断）。
 * 移动不足阈值 → 不记点（避免静止时堆积同位点）；超上限 → 丢最旧。
 */
export function pushTrail(trail: GhostTrail, p: { x: number; y: number }): void {
  const head = trail.pts[0]
  if (head && Math.hypot(p.x - head.x, p.y - head.y) < TRAIL_SAMPLE_GAP) return
  trail.pts.unshift({ x: p.x, y: p.y })
  if (trail.pts.length > TRAIL_MAX_PTS) trail.pts.pop()
}

/**
 * trail 上距首领当前位弧长 distance 处的点（线性插值）。
 * trail 不足（总弧长 < distance）→ 返回最旧点（跟随者堆叠收敛，待 trail 增长展开）。
 */
export function pointAtArc(trail: GhostTrail, distance: number): { x: number; y: number } {
  const pts = trail.pts
  if (pts.length === 0) return { x: 0, y: 0 }
  if (pts.length === 1) {
    const only = pts[0]!
    return { x: only.x, y: only.y }
  }
  let acc = 0
  for (let i = 1; i < pts.length; i++) {
    const point = pts[i]!
    const previous = pts[i - 1]!
    const dx = point.x - previous.x
    const dy = point.y - previous.y
    const seg = Math.hypot(dx, dy)
    if (acc + seg >= distance) {
      const t = seg > 0.001 ? (distance - acc) / seg : 0
      return { x: previous.x + dx * t, y: previous.y + dy * t }
    }
    acc += seg
  }
  const last = pts[pts.length - 1]!
  return { x: last.x, y: last.y }
}
