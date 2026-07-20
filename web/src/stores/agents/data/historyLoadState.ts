import type { PetInstance } from '@/features/pets/types/types'
import type { StreamState } from '../types'

/**
 * 历史回放与实时运行共用同一个 StreamState。
 * 只要 stream 或 pet 任一侧仍标记为工作中，就不能让 chat.get 初始化清掉实时气泡/工作态。
 */
export function hasActiveChatRun(
  stream: Pick<StreamState, 'isWorking'>,
  pet: Pick<PetInstance, 'isWorking'> | undefined,
): boolean {
  return stream.isWorking || pet?.isWorking === true
}
