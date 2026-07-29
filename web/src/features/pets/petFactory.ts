/**
 * Pet 实例工厂 + 纯辅助（从 usePetWorld.ts 提纯）。
 *
 * createPetInstance 供 agents store（petLifecycle / streamRouter）直接复用，
 * 切断 store → composables 的反向依赖（store 不再 import usePetWorld）。
 * rand/pick/clamp/randomTarget/moodForAction/actionTalk 为 usePetWorld 与本工厂共享的纯辅助。
 * 零行为变更。
 */
import { PET_WIDTH, PET_HEIGHT } from './motion/petMovement'
import { resolveStatus } from './motion/petStatus'
import type { PetAction, PetInstance, PetMood, PetPreset, StageBounds } from './types/types'

const status = resolveStatus()

export function rand(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

export function pick<T>(items: readonly T[]): T {
  const item = items[Math.floor(Math.random() * items.length)]
  if (item === undefined) {
    throw new Error('Cannot pick from an empty list')
  }
  return item
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

export function randomTarget(bounds: StageBounds): { x: number; y: number } {
  return {
    x: rand(16, Math.max(16, bounds.width - PET_WIDTH - 16)),
    y: rand(56, Math.max(56, bounds.height - PET_HEIGHT - 16)),
  }
}

export function moodForAction(action: PetAction): PetMood {
  if (action === 'dragging') return 'surprised'
  if (action === 'clicked') return 'happy'
  if (action === 'chatting') return pick(['happy', 'nagging', 'curious'] as const)
  if (action === 'dropped') return 'sad'
  if (action === 'sleep') return 'sleepy'
  return 'calm'
}

export function actionTalk(pet: PetInstance, action: PetAction): string {
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
