/**
 * Ghost 跟随队列（从 usePetWorld.ts 提纯）。
 *
 * ghost 是已完成子 Agent 的发光跟随点：全部 ghost 持续 seek 所属 tribe 主 Agent 的
 * 移动轨迹（trail）上按队列序号取的弧长点，形成跟随队形。本 composable 只持有 trail
 * 数据 + 目标计算 + 每帧首领轨迹采样；ghost 的弹簧物理仍归 usePetWorld.tickPet。
 * 零行为变更。
 */
import { pushTrail, pointAtArc, ghostTrailDistance, type GhostTrail } from '@/domain/pets/motion/movement'
import { findMaster } from '@/domain/pets/motion/targeting'
import type { PetInstance } from '@/domain/pets/types'

export function useGhostQueue(pets: readonly PetInstance[]) {
  // ghost 队列 trail：key=tribe，value=主 Agent 移动轨迹（newest-first）。
  const ghostTrails = new Map<string, GhostTrail>()

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
  function getTarget(pet: PetInstance): { x: number; y: number } | null {
    if (!pet.isGhost) return null
    const idx = ghostQueueIndex(pet)
    if (idx < 0) return null
    const leader = findMaster(pet, pets)
    if (!leader) return null
    const trail = ghostTrails.get(pet.tribe)
    if (!trail || trail.pts.length < 2) return { x: leader.x, y: leader.y }
    return pointAtArc(trail, ghostTrailDistance(idx))
  }

  /** 每帧以主 Agent 为队首采样轨迹（主 Agent 拖拽时也持续记录）。 */
  function sampleLeaders(): void {
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

  return { getTarget, sampleLeaders }
}
