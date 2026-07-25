import { findChatsByParent } from '@/db/chat.js'
import { getWaitedParent, type WakePolicy } from '@/agent/spawnBroker.js'
import { wakeParent } from './wake.js'
import { safeJsonParse } from '@/utils/json.js'
import { logger } from '@/utils/logger/index.js'

/**
 * 唤醒策略调度器（见 docs/agent-pet.md §5.4 唤醒策略调度器）。
 *
 * 介于 observer.child_done 与 wakeParent 之间：child_done 不再直调 wakeParent，
 * 而是经本调度器按子 wake_policy 决定 silent 暂存（deferred/barrier）/ resume 唤主（immediate 或策略满足）。
 *
 * 这是发布订阅模型的「调度层」：publisher=子 child_done 事件，subscriber=主 chat 经 wakeParent 唤醒，
 * 本层按策略路由（取代旧的硬编码「子完成即唤主」1:1 直连）。
 *
 * 策略判定（运行时推导，无持久 wake_mode，每次扫 findChatsByParent）：
 * - hasBarrier（主的子中存在 wake='barrier'）→ all 模式：所有子完成才唤主（immediate 也暂存到全完成）
 * - first 模式（无 barrier）：
 *   - immediate 子完成 → 立即唤主（聚合所有已完成子结果）
 *   - deferred 子完成 → 暂存；若碰巧 allChildrenFinished 则唤主（兜底，覆盖全 deferred 场景，见用户决策②）
 */

/**
 * 主的所有子是否都已 finished（无未完成子）。
 * observer 在调本调度器前已标当前子 finished=true，故此处扫描含刚完成的子。
 */
function allChildrenFinished(parentChatId: string): boolean {
  const children = findChatsByParent(parentChatId)
  if (children.length === 0) return true
  return children.every((c) => {
    if (!c.metadata) return true
    const meta = safeJsonParse(c.metadata, {}) as { finished?: boolean }
    return meta.finished === true
  })
}

/**
 * 主的子中是否存在 wake='barrier'（栅栏触发器）。
 * barrier 子存在 → 主进入 all 模式（所有未完成子完成才唤主）。
 */
function parentHasBarrier(parentChatId: string): boolean {
  return findChatsByParent(parentChatId).some((c) => {
    if (!c.metadata) return false
    const meta = safeJsonParse(c.metadata, {}) as { wake?: WakePolicy }
    return meta.wake === 'barrier'
  })
}

/**
 * 唤醒策略评估：当前子完成后是否应唤主。
 * @param parentChatId 主 chat
 * @param policy 当前完成子的 wake 策略（来自内存 waitedChildren，spawn 时注册）
 * @returns true=唤主（resume），false=暂存（silent）
 */
function evalWakePolicy(parentChatId: string, policy: WakePolicy): boolean {
  if (parentHasBarrier(parentChatId)) {
    // all 模式：所有子完成才唤主
    return allChildrenFinished(parentChatId)
  }
  if (policy === 'immediate') return true // first 模式 + immediate：立即唤主
  // first 模式 + deferred：暂存，但全部完成则唤主（兜底）
  return allChildrenFinished(parentChatId)
}

/**
 * child_done 入口（observer.child_done 分支调用，取代旧直调 wakeParent）。
 * observer 已在调用前标 finished=true + 校验 getWaitedParent 命中。
 * @param childChatId 完成的子 chat id
 * @param content 子末条 assistant content
 */
export async function onChildDone(childChatId: string, content: string): Promise<void> {
  const waited = getWaitedParent(childChatId)
  if (!waited) return // 非注册唤醒的子 chat（主 agent 自身），忽略
  const shouldWake = evalWakePolicy(waited.parentChatId, waited.wakePolicy)
  // silent=!shouldWake：deferred/barrier 暂存（wakeParent 仅注入+DB，不唤主）；
  // immediate 或策略满足 → 非 silent 完整唤主（注入+resumePending+notification+WS）
  await wakeParent(waited.parentChatId, childChatId, waited.type, content, {
    silent: !shouldWake,
  })
  logger.event('wake.scheduler', {
    parentChatId: waited.parentChatId,
    childChatId,
    policy: waited.wakePolicy,
    shouldWake,
  })
}
