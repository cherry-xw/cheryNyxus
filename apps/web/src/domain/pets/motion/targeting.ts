/**
 * Pet 目标选取纯函数（从 usePetWorld.ts 提纯，对齐 motion/ 放纯函数约定）。
 *
 * retarget/findMaster 原为 usePetWorld 闭包（隐式读 pets/bounds）；
 * 提纯为显式入参后，usePetWorld 与 useGhostQueue 共享同一套部落/聚拢逻辑。
 * 零行为变更。
 */
import type { PetInstance, StageBounds } from '../types'
import { clamp, rand, randomTarget } from '../factory'

/** 子 pet retarget 偏向本主的半径。 */
export const TRIBE_CLUSTER_RADIUS = 70

/** 找 pet 所属部落的主 pet（主 pet 返回自身）。 */
export function findMaster(
  pet: PetInstance,
  pets: readonly PetInstance[],
): PetInstance | undefined {
  if (pet.isMaster) return pet
  return pets.find((p) => p.instanceId === pet.tribe && p.isMaster)
}

/**
 * 重选目标点：子 pet 聚拢本主（部落扎堆）；主 pet / 孤儿子自由游走。
 */
export function retarget(
  pet: PetInstance,
  pets: readonly PetInstance[],
  bounds: StageBounds,
): void {
  const master = pet.isMaster ? undefined : findMaster(pet, pets)
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
