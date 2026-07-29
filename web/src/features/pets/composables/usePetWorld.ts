import { onMounted, onUnmounted, reactive, ref, type Ref } from 'vue'
import {
  PET_WIDTH,
  PET_HEIGHT,
  arrivedAtTarget,
  keepInBounds,
  stepMovement,
  pushTrail,
  pointAtArc,
  ghostTrailDistance,
} from '../motion/petMovement'
import type { GhostTrail } from '../motion/petMovement'
import {
  adjustEmotion,
  adjustFatigue,
  restMood,
  resolveStatus,
  shouldSleep,
  shouldWake,
  stepVitals,
} from '../motion/petStatus'
import type { PetAction, PetInstance, PetMood, PetPreset, StageBounds } from '../types/types'

const TRIBE_CLUSTER_RADIUS = 70 // 子 pet retarget 偏向本主的半径
const RAPID_CLICK_WINDOW = 1200
const RAPID_CLICK_THRESHOLD = 3
const PANIC_MOVEMENT = 32
const GHOST_SPRING_K = 10 // 跟随者弹簧刚度（加速度/距离）：临界阻尼 k≈λ²/4（damping λ=-ln0.9×60≈6.34）→ 平滑收敛无振荡
const GHOST_SPRING_MAX = 500 // 弹簧力封顶（远距避免加速度过载，maxSpeed 已限速）

// 状态数值算法 + 可调配置（速率/阈值/增量）抽到 petStatus.ts；status 为默认配置注入
const status = resolveStatus()

// 主 pet 独立物理（更慢更稳）：比默认（petMovement）更低速度/加速度/斥力/半径
const MASTER_ACCELERATION = 50 // 默认 80 → 更缓启停
const MASTER_TRIBE_REPEL = 200 // 默认 300 → 同部落近距更不弹
const MASTER_OTHER_REPEL = 320 // 默认 450 → 异部落分离更柔
const MASTER_REPEL_RADIUS = 100 // 默认 120
const MASTER_ATTRACT_RADIUS = 180 // 默认 200

/** hover 离开 pet 后 280ms 静止缓冲（闭包 Map，不污染 PetInstance 类型）。 */
const hoverCooldownUntil = new Map<string, number>()

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

function pick<T>(items: readonly T[]): T {
  const item = items[Math.floor(Math.random() * items.length)]
  if (item === undefined) {
    throw new Error('Cannot pick from an empty list')
  }
  return item
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function randomTarget(bounds: StageBounds): { x: number; y: number } {
  return {
    x: rand(16, Math.max(16, bounds.width - PET_WIDTH - 16)),
    y: rand(56, Math.max(56, bounds.height - PET_HEIGHT - 16)),
  }
}

function moodForAction(action: PetAction): PetMood {
  if (action === 'dragging') return 'surprised'
  if (action === 'clicked') return 'happy'
  if (action === 'chatting') return pick(['happy', 'nagging', 'curious'] as const)
  if (action === 'dropped') return 'sad'
  if (action === 'sleep') return 'sleepy'
  return 'calm'
}

function actionTalk(pet: PetInstance, action: PetAction): string {
  return pick(pet.behaviors?.[action]?.talks ?? pet.talks)
}

/**
 * 从 preset 构建 PetInstance（含 agent 绑定字段）。
 * 位置随机；子 pet 落点由调用方用 findSpawnPosition 覆盖（挂主附近）。
 * 导出供 agents store 的 initFromChats / createMasterPet 复用，避免重复创建逻辑。
 */
export function createPetInstance(
  preset: PetPreset,
  bounds: StageBounds,
  isMaster: boolean,
  masterId: string | undefined,
  agent: { chatId: string; parentChatId?: string; agentType?: string; finished?: boolean },
): PetInstance {
  const now = performance.now()
  const instanceId = `${preset.id}-${agent.chatId}`
  const start = randomTarget(bounds)
  const target = randomTarget(bounds)

  return {
    ...preset,
    instanceId,
    visualKind: 'default',
    isMaster,
    tribe: isMaster ? instanceId : (masterId ?? instanceId),
    tools: preset.tools,
    x: start.x,
    y: start.y,
    vx: 0,
    vy: 0,
    targetX: target.x,
    targetY: target.y,
    width: PET_WIDTH,
    height: PET_HEIGHT,
    direction: 1,
    mood: isMaster ? 'serious' : 'calm',
    action: 'walk',
    speech: '',
    speechUntil: 0,
    moodUntil: 0,
    interactionUntil: 0,
    lastInteractionAt: now,
    emotion: status.emotionInit,
    fatigue: 0,
    dragOffsetX: 0,
    dragOffsetY: 0,
    draggingPointerId: null,
    pairCooldowns: {},
    rapidClicks: 0,
    lastClickAt: 0,
    chatId: agent.chatId,
    parentChatId: agent.parentChatId,
    agentType: agent.agentType,
    isWorking: false,
    contextUsage: 0,
    contextUsed: 0,
    contextTotal: 0,
    isGhost: !!agent.finished,
    ghostFace: undefined,
    bubbleRepelExtra: 0,
  }
}

/**
 * pet 世界 composable：RAF 运动循环 + 拖拽/hover/click 交互。
 * CP1 起 pets 数据源由调用方注入（agents store 单一数据源）；未注入时回退本地 reactive（独立可用）。
 * 装饰交互（invokeTool/randomEmotion/addPet/summonSub/maybeTriggerChats/triggerChat/faceEachOther/masterTools）已移除。
 */
export function usePetWorld(
  stageRef: Ref<HTMLElement | null>,
  petsSource?: PetInstance[],
) {
  const pets = petsSource ?? reactive<PetInstance[]>([])
  const isPaused = ref(false)
  const bounds = reactive<StageBounds>({ width: 960, height: 640 })
  let raf = 0
  let lastTime = 0
  // ghost 队列 trail：key=tribe，value=主 Agent 移动轨迹（newest-first）。
  const ghostTrails = new Map<string, GhostTrail>()

  function readBounds(): StageBounds {
    const rect = stageRef.value?.getBoundingClientRect()
    bounds.width = rect?.width ?? window.innerWidth
    bounds.height = rect?.height ?? window.innerHeight
    return bounds
  }

  function retarget(pet: PetInstance): void {
    // 子 pet：聚拢本主（部落扎堆）；主 pet / 孤儿子：自由游走
    const master = pet.isMaster ? undefined : findMaster(pet)
    if (master) {
      pet.targetX = clamp(
        master.x + rand(-TRIBE_CLUSTER_RADIUS, TRIBE_CLUSTER_RADIUS),
        0,
        Math.max(0, bounds.width - pet.width),
      )
      pet.targetY = clamp(
        master.y + rand(-TRIBE_CLUSTER_RADIUS, TRIBE_CLUSTER_RADIUS),
        42,
        Math.max(42, bounds.height - pet.height),
      )
      return
    }
    const target = randomTarget(bounds)
    pet.targetX = target.x
    pet.targetY = target.y
  }

  function showSpeech(pet: PetInstance, text: string, duration = 1800): void {
    const now = performance.now()
    pet.speech = text
    pet.speechUntil = now + duration
  }

  function setTemporaryAction(
    pet: PetInstance,
    action: PetAction,
    duration = 1200,
    speech?: string,
  ): void {
    const now = performance.now()
    pet.action = action
    pet.mood = moodForAction(action)
    pet.moodUntil = now + duration
    pet.lastInteractionAt = now
    if (speech) showSpeech(pet, speech, duration)
  }

  function fallAsleep(pet: PetInstance): void {
    pet.action = 'sleep'
    pet.mood = 'sleepy'
    pet.moodUntil = 0
    pet.speech = ''
    pet.speechUntil = 0
  }

  function wakeUp(pet: PetInstance): void {
    const now = performance.now()
    pet.action = 'walk'
    pet.mood = restMood(pet, status)
    pet.moodUntil = 0
    pet.lastInteractionAt = now
    retarget(pet)
    showSpeech(pet, pick(['醒了', '嗯?', 'zZ...']), 800)
  }

  function findMaster(pet: PetInstance): PetInstance | undefined {
    if (pet.isMaster) return pet
    return pets.find((p) => p.instanceId === pet.tribe && p.isMaster)
  }

  /** 同 tribe ghost 按 ghostCreatedAt 排序（首领 idx 0）。 */
  function sortedTribeGhosts(tribe: string): PetInstance[] {
    return pets
      .filter((p) => p.isGhost && p.tribe === tribe)
      .sort((a, b) => (a.ghostCreatedAt ?? 0) - (b.ghostCreatedAt ?? 0))
  }

  /** ghost 在本 tribe 队列中的序号（0=主 Agent 后第一颗点）；非 ghost 返回 -1。 */
  function ghostQueueIndex(pet: PetInstance): number {
    return pet.isGhost ? sortedTribeGhosts(pet.tribe).indexOf(pet) : -1
  }

  /**
   * ghost 队列路径拟合：主 Agent 是队首，全部 ghost 都是跟随者。
   * 第 idx 个 ghost 取主 Agent trail 上弧长 (idx+1)*SPACING 处的点。
   */
  function getGhostQueueTarget(pet: PetInstance): { x: number; y: number } | null {
    if (!pet.isGhost) return null
    const idx = ghostQueueIndex(pet)
    if (idx < 0) return null
    const leader = findMaster(pet)
    if (!leader) return null
    const trail = ghostTrails.get(pet.tribe)
    if (!trail || trail.pts.length < 2) return { x: leader.x, y: leader.y }
    return pointAtArc(trail, ghostTrailDistance(idx))
  }

  function tickPet(pet: PetInstance, now: number, dt: number): void {
    if (pet.draggingPointerId !== null) {
      return
    }

    // Ghost 是纯运动点，不进入睡眠、悬浮、工作气泡或疲劳状态机。
    if (pet.isGhost) {
      pet.action = 'walk'
      pet.fatigue = 0
      pet.speech = ''
      pet.speechUntil = 0
    }

    // hover 离场后 280ms 静止缓冲（避免 .pet-icons 边缘抖动立刻 retarget）
    const cooldown = hoverCooldownUntil.get(pet.instanceId) ?? 0
    if (cooldown > now) return
    if (cooldown > 0) hoverCooldownUntil.delete(pet.instanceId)

    // 休息中：速度 0，fatigue↓ emotion↑（stepVitals sleep 分支），自然醒
    if (pet.action === 'sleep') {
      stepVitals(pet, dt, status)
      if (shouldWake(pet, status)) {
        wakeUp(pet)
      }
      return
    }

    // 悬浮：停止移动，保持当前表情（不切 mood、不衰减、不回退）
    if (pet.action === 'hover') return

    // emotion 缓降（stepVitals active 分支）
    stepVitals(pet, dt, status)

    // 疲劳达阈值 → 自动休息
    if (shouldSleep(pet, status)) {
      fallAsleep(pet)
      return
    }

    if (pet.speech && pet.speechUntil < now) {
      pet.speech = ''
    }

    if (pet.action === 'chatting') {
      // agent 工作态复用 chatting action（CP2 由 isWorking 触发）；到期回落 walk
      if (pet.interactionUntil && pet.interactionUntil < now) {
        pet.action = 'walk'
        pet.mood = restMood(pet, status)
        pet.bubbleRepelExtra = 0 // Req 8: 冻结结束，斥力增量清零
        retarget(pet)
      }
      return
    }

    if (pet.moodUntil && pet.moodUntil < now) {
      pet.action = 'walk'
      pet.mood = restMood(pet, status)
      pet.moodUntil = 0
    }

    // ghost 队列：全部 ghost 持续 seek 主 Agent trail 点
    let ghostFollower = false
    if (pet.isGhost) {
      const queueTarget = getGhostQueueTarget(pet)
      if (queueTarget) {
        // 跟随者：持续朝首领 trail 弧长点移动
        ghostFollower = true
        pet.targetX = clamp(queueTarget.x, 0, Math.max(0, bounds.width - pet.width))
        pet.targetY = clamp(queueTarget.y, 42, Math.max(42, bounds.height - pet.height))
        pet.action = 'walk'
      } else {
        // 孤儿 ghost（主 Agent 暂不可见）退化为近原 tribe 自由移动。
        if (arrivedAtTarget(pet)) {
          retarget(pet)
          pet.action = 'idle'
          pet.mood = restMood(pet, status)
          pet.moodUntil = now + rand(800, 1800)
          pet.vx = 0
          pet.vy = 0
          return
        }
      }
    } else if (arrivedAtTarget(pet)) {
      retarget(pet)
      pet.action = 'idle'
      pet.mood = restMood(pet, status)
      pet.moodUntil = now + rand(800, 1800)
      pet.vx = 0
      pet.vy = 0
      return
    }

    pet.action = 'walk'
    adjustFatigue(pet, status.fatigueWalkRate * dt)
    const baseMax = pet.mood === 'sleepy' ? 55 : 115
    const maxSpeed = baseMax * (1 + (pet.id.length % 3) * 0.15)
    if (pet.isMaster) {
      // 主 pet 独立物理：更慢更稳（更低速度/加速度/斥力/半径）。
      // tribeAttract=0：主 pet 不受同部落引力。子 pet 聚拢本主(retarget ±70) + 同部落引力双向拉拢，
      // 否则主 pet 被钉在子 pet 堆中心，被子 pet 围到屏幕边缘后斥力顶住边界无法离开 → 全部堆积边缘。
      // 只保留斥力（近距防重叠，不重叠即无力）→ 主 pet 凭 seek 全屏自由游走。
      stepMovement(pet, pets, bounds, dt, {
        maxSpeed: maxSpeed * 0.6,
        acceleration: MASTER_ACCELERATION,
        tribeAttract: 0,
        tribeRepel: MASTER_TRIBE_REPEL,
        otherRepel: MASTER_OTHER_REPEL,
        repelRadius: MASTER_REPEL_RADIUS,
        attractRadius: MASTER_ATTRACT_RADIUS,
      })
    } else if (pet.isGhost) {
      if (ghostFollower) {
        // 跟随者：弹簧追首领 trail 点（加速度 ∝ 距 trail 点距离），恒定 maxSpeed×1.25 + damping 临界阻尼
        // -> 平滑收敛，速度连续无突变。零力（无邻居抖动；近本主/远他主由首领路径继承）。
        // 弹簧 vs arrive/死区：arrive 降 maxSpeed 到 0 或死区清零 = 到点硬停（速度突变），trail 点随首领移
        // 偏移后高加速又冲 -> “停-冲-停-冲”一抖一抖；弹簧到点加速度->0、速度靠 damping 连续衰减 -> 流畅贴边。
        const fdx = pet.targetX - pet.x
        const fdy = pet.targetY - pet.y
        const fd = Math.hypot(fdx, fdy)
        stepMovement(pet, pets, bounds, dt, {
          maxSpeed: maxSpeed * 1.25,
          acceleration: Math.min(GHOST_SPRING_MAX, GHOST_SPRING_K * fd),
          tribeAttract: 0,
          tribeRepel: 0,
          otherAttract: 0,
          otherRepel: 0,
        })
      } else {
        // 孤儿 ghost 退化路径。
        stepMovement(pet, pets, bounds, dt, {
          maxSpeed,
          tribeAttract: 0,
          tribeRepel: 0,
        })
      }
    } else {
      stepMovement(pet, pets, bounds, dt, { maxSpeed })
    }
  }

  function loop(now: number): void {
    const currentBounds = readBounds()
    const dt = Math.min(0.04, Math.max(0, (now - lastTime) / 1000 || 0))
    lastTime = now

    if (!isPaused.value && currentBounds.width > 0 && currentBounds.height > 0) {
      // 装饰 chatting（maybeTriggerChats）已移除；agent 工作态 chatting 由 store 触发（CP2）
      for (const pet of pets) {
        tickPet(pet, now, dt)
      }
      // 每个 tribe 以主 Agent 为队首并采样轨迹；主 Agent 拖拽时也持续记录。
      const leaderByTribe = new Map<string, PetInstance>()
      for (const pet of pets) {
        if (pet.isMaster) leaderByTribe.set(pet.tribe, pet)
      }
      for (const pet of leaderByTribe.values()) {
        let trail = ghostTrails.get(pet.tribe)
        if (!trail) {
          trail = { pts: [] }
          ghostTrails.set(pet.tribe, trail)
        }
        pushTrail(trail, { x: pet.x, y: pet.y })
      }
    }

    raf = requestAnimationFrame(loop)
  }

  function pointerPosition(event: PointerEvent): { x: number; y: number } {
    const rect = stageRef.value?.getBoundingClientRect()
    return {
      x: event.clientX - (rect?.left ?? 0),
      y: event.clientY - (rect?.top ?? 0),
    }
  }

  function startDrag(pet: PetInstance, event: PointerEvent): void {
    const wasSleeping = pet.action === 'sleep'
    const point = pointerPosition(event)
    pet.draggingPointerId = event.pointerId
    pet.dragOffsetX = point.x - pet.x
    pet.dragOffsetY = point.y - pet.y
    pet.action = 'dragging'
    pet.mood = 'surprised'
    pet.moodUntil = 0
    pet.lastInteractionAt = performance.now()
    if (wasSleeping) {
      adjustEmotion(pet, status.emoteDisturb)
    }
    adjustEmotion(pet, status.emoteDrag)
    showSpeech(pet, actionTalk(pet, 'dragging'), 900)
  }

  function dragPet(pet: PetInstance, event: PointerEvent): void {
    if (pet.draggingPointerId !== event.pointerId) return
    const point = pointerPosition(event)
    pet.x = point.x - pet.dragOffsetX
    pet.y = point.y - pet.dragOffsetY
    // direction 滞回：忽略微小 movementX 噪声，避免 scaleX 频繁翻转抖动
    if (Math.abs(event.movementX) > 2) {
      pet.direction = event.movementX > 0 ? 1 : -1
    }
    // fatigue 按位移累积
    const moved = Math.hypot(event.movementX, event.movementY)
    if (moved > 0) adjustFatigue(pet, moved * 0.05)
    // mood 不每帧切：仅持续快移切 panicked，保底保持 400ms 避免闪烁
    const now = performance.now()
    if (moved > PANIC_MOVEMENT && pet.mood !== 'panicked') {
      pet.mood = 'panicked'
      pet.moodUntil = now + 400
    } else if (pet.mood === 'panicked' && pet.moodUntil && pet.moodUntil < now) {
      pet.mood = 'surprised'
    }
    keepInBounds(pet, bounds)
  }

  function endDrag(pet: PetInstance, event: PointerEvent): void {
    if (pet.draggingPointerId !== event.pointerId) return
    pet.draggingPointerId = null
    pet.dragOffsetX = 0
    pet.dragOffsetY = 0
    keepInBounds(pet, bounds)
    setTemporaryAction(pet, 'dropped', 900, actionTalk(pet, 'dropped'))
    retarget(pet)
  }

  function hoverPet(pet: PetInstance, hovering: boolean): void {
    if (pet.draggingPointerId !== null) return
    const now = performance.now()
    if (hovering) {
      if (pet.action === 'sleep') {
        wakeUp(pet)
        adjustEmotion(pet, status.emoteDisturb)
        return
      }
      if (pet.action === 'chatting') return
      pet.action = 'hover'
      pet.vx = 0
      pet.vy = 0
      pet.lastInteractionAt = now
      adjustEmotion(pet, status.emoteHover)
    } else if (pet.action === 'hover') {
      pet.action = 'walk'
      pet.vx = 0
      pet.vy = 0
      hoverCooldownUntil.set(pet.instanceId, now + 280)
      pet.mood = restMood(pet, status)
    }
  }

  function clickPet(pet: PetInstance): void {
    if (pet.draggingPointerId !== null) return
    const now = performance.now()
    if (pet.action === 'sleep') {
      wakeUp(pet)
      adjustEmotion(pet, status.emoteDisturb)
      return
    }
    pet.rapidClicks = now - pet.lastClickAt < RAPID_CLICK_WINDOW ? pet.rapidClicks + 1 : 1
    pet.lastClickAt = now
    if (pet.rapidClicks >= RAPID_CLICK_THRESHOLD) {
      pet.mood = 'angry'
      pet.action = 'clicked'
      pet.moodUntil = now + 1400
      pet.lastInteractionAt = now
      adjustEmotion(pet, status.emoteRapid)
      showSpeech(pet, pick(['够了!', '别戳!', '哼!']), 1300)
      return
    }
    adjustEmotion(pet, status.emoteClick)
    setTemporaryAction(pet, 'clicked', 1300, actionTalk(pet, 'clicked'))
  }

  // agent 显示层注入钩子：未来由真实 token 上下文 / agent 状态注入
  function setFatigue(pet: PetInstance, value: number): void {
    pet.fatigue = clamp(value, 0, 100)
  }

  function setEmotion(pet: PetInstance, value: number): void {
    pet.emotion = clamp(value, 0, 100)
  }

  onMounted(() => {
    readBounds()
    // 不再自动 resetPets：pets 由 agents store initFromChats 驱动（调用方注入或外部填充）
    lastTime = performance.now()
    raf = requestAnimationFrame(loop)
    window.addEventListener('resize', readBounds)
  })

  onUnmounted(() => {
    cancelAnimationFrame(raf)
    window.removeEventListener('resize', readBounds)
  })

  return {
    pets,
    isPaused,
    setFatigue,
    setEmotion,
    startDrag,
    dragPet,
    endDrag,
    hoverPet,
    clickPet,
  }
}
