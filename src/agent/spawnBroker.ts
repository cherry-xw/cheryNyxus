/**
 * Spawn Broker（主从 Agent 桌宠系统 CP3 / wait=true 唤醒链）
 *
 * 职责（2026-07-09 重构：废除阻塞心跳，改 yield turn + 子完成唤醒，见 docs/agent-pet.md §5.4）：
 * 1. 唤醒链 `waitedChildren`（childChatId → {parentChatId, type}）：spawn 时注册（覆盖 wait=true/false），
 *    子完成/出错/超时由 service 层 wakeParent 消费并 clearWaitedChild。递归天然支持（任何 agent 的 spawn 子都在此 Map）。
 * 2. `asyncWatchdogs`：每 wait-子 5min 看门狗；超时触发 service 注入的 asyncWakeHandler（wakeParent 超时 content + abortChatRuntime）。
 * 3. broadcaster：service 层注入 ws 推送实现，spawn sense 经 emitRoleCreated 推 role_created notification。
 *
 * 选型（不复用 approvalRegistry）：approvalRegistry.resolve 签名 (id, action, reason)→ApprovalDecision，
 * 语义为「审批决策」；spawn 唤醒需回传任意 content + 递归（子也可唤子），语义错位。故专用 broker。
 *
 * notification.requestId：用 parentChatId（spawn sense 在 senseMiddleware await 执行，无法取 WS requestId；前端按 chatId 路由）。
 *
 * 分层：本模块（agent 层）只持有唤醒态数据 + 看门狗定时器；DB 读取 + wakeParent 注入 + abortChatRuntime
 * 均在 service 层（wake.ts）。超时动作经 setAsyncWakeHandler 注入（类 setSpawnBroadcaster），避免 agent→service 反向依赖。
 */

import config from '@/utils/config.js'

/**
 * 唤醒策略（取代旧 wait:boolean，见 docs/agent-pet.md §5.4 唤醒策略调度器）。
 * - immediate：子完成立即唤主（聚合所有已完成子结果）
 * - deferred：子完成静默暂存（落主 DB 不唤主）；全 deferred 集最后一个完成隐式唤主（兜底）
 * - barrier：声明栅栏，主 chat 进入 all 模式 → 所有未完成子完成才唤主（期间 immediate 子也暂存）
 */
export type WakePolicy = 'immediate' | 'deferred' | 'barrier'

// ============ broadcaster（role_created/destroyed notification 推送）============

/** role_created notification data（推送契约，前端依赖） */
export interface RoleCreatedData {
  /** 持久任务 id；前端以 chat.startSpawn 原子领取，重放不会重复执行。 */
  taskId: string
  /** 子 chat id（前端据此驱动子 chat） */
  chatId: string
  /** 主 chat id（前端溯源 pet 树） */
  parentChatId: string
  /** 角色类型（config.roles / preset.roles 键名） */
  type: string
  /** 角色头像（显式配置或按 type 稳定生成）。 */
  avatar: string
  /** 交付角色的任务 prompt */
  prompt: string
  /** 角色用的 brain 名 */
  brain: string
  /** 角色启用的感官组（单组） */
  senseGroup: string
  /** 唤醒策略（immediate/deferred/barrier，信息性：前端均驱动子跑，唤主时机由后端 wakeScheduler 决定） */
  wake: WakePolicy
  /**
   * 触发本次 spawn 的 sense call id（= 主 chat sense message.id）。
   * 前端收 role_created/role_reply 时据此前往主 chat 对应 sense 调用框（scroll-to）。
   * 旧 chat 无此字段时 undefined（前端兜底）。
   */
  spawnSenseCallId?: string
}

/** role_destroyed notification data（推送契约，前端 Agent A 依赖） */
export interface RoleDestroyedData {
  /** 被销毁的子 chat id（前端据此移除子 pet） */
  chatId: string
}

/** 角色生命周期事件判别（service installer 据此选 notification.type） */
export type RoleEventKind = 'created' | 'destroyed'

/**
 * Broadcaster：把角色生命周期事件送到主 chat 所属连接的 ws。
 * service 层启动时注入（service/websocket 持 connectionManager + transport，
 * 反查 chatId→connectionId→ws 后 ws.send(transport.encode(notification))）。
 */
export type SpawnBroadcaster = (
  parentChatId: string,
  kind: RoleEventKind,
  data: RoleCreatedData | RoleDestroyedData,
) => void

/** broadcaster（service 层启动时注入；未注入时 emit 静默丢弃 + warn 日志） */
let broadcaster: SpawnBroadcaster | null = null

/**
 * 注入 ws 推送实现（service/index.ts 启动期调用）。
 */
export function setSpawnBroadcaster(fn: SpawnBroadcaster): void {
  broadcaster = fn
}

/**
 * 推送 role_created notification 给主 chat 所属连接。
 * spawn_role sense 执行时调用。broadcaster 未注入：warn + 不阻塞。
 */
export function emitRoleCreated(data: RoleCreatedData): void {
  if (broadcaster) {
    broadcaster(data.parentChatId, 'created', data)
  } else {
    console.warn(
      `[spawnBroker] broadcaster 未注入，role_created 通知未推送（parentChatId=${data.parentChatId}, childChatId=${data.chatId}）`,
    )
  }
}

/**
 * 推送 role_destroyed notification 给主 chat 所属连接。
 * broadcaster 未注入：warn + 不阻塞。
 */
export function emitRoleDestroyed(parentChatId: string, data: RoleDestroyedData): void {
  if (broadcaster) {
    broadcaster(parentChatId, 'destroyed', data)
  } else {
    console.warn(
      `[spawnBroker] broadcaster 未注入，role_destroyed 通知未推送（parentChatId=${parentChatId}, chatId=${data.chatId}）`,
    )
  }
}

// ============ eager 子 agent 启动（spawn_role sense 内部触发，不依赖前端 RPC）============

/**
 * eager 子 agent 启动器：service 层注入。spawn_role sense 完成时 fire-and-forget 调用，
 *   在后台跑出子 chat 的实际 LLM stream（路径与 chat.send / chat.startSpawn 完全相同：
 *   handleChatSend → bindChatConnection → streamAgentChunks → WS）。
 *   前端只通过 ws 订阅观察，不用调 chat.startSpawn RPC（chat.startSpawn 退化为 recovery）。
 *
 * 设计动机：原 chat.startSpawn 「前端驱动」模型违背用户「子 agent 走同一条 API」原意——一旦
 *   前端 startSpawn 调用失败（requestMap 时序 / chatId 错配 / 网络抖动 / 页面关闭），子 agent
 *   就不会跑出 stream。把启动收敛到 sense 内部后端，彻底消除该失败路径。
 *
 * 参数：
 * - taskId: spawn_tasks.taskId（createSpawnTask 返回）
 * - parentChatId: 主 chatId，用于反查主 chat 所属 ws（child stream chunks 推到该 ws）
 */
export type EagerSpawnStarter = (taskId: string, parentChatId: string) => void

/** 注入实现（service 层启动期调，未注入则 startChildEager 仅 warn + 不阻塞） */
let eagerSpawnStarter: EagerSpawnStarter | null = null

/** service 层启动期注入 eager 启动实现。 */
export function setEagerSpawnStarter(fn: EagerSpawnStarter): void {
  eagerSpawnStarter = fn
}

/**
 * spawn_role sense 内 fire-and-forget 触发子 chat 后台启动。
 * 端到端：spawn_role 完成 → 此调用 setImmediate 触发 runChildTaskInBackground →
 *   handleChatStartSpawn claimSpawnTask firstStart 跑子 chat send → handleChatSend 绑子 chatId
 *   → streamAgentChunks 推 chunk/notification 到 parent ws。
 * 未注入实现 → 仅 warn，主流程不阻塞（保留 chat.startSpawn recovery RPC 兜底）。
 */
export function startChildEager(taskId: string, parentChatId: string): void {
  if (eagerSpawnStarter) {
    eagerSpawnStarter(taskId, parentChatId)
  } else {
    console.warn(
      `[spawnBroker] eagerSpawnStarter 未注入，task ${taskId} 未由 spawn_role sense 后台启动（fallback to chat.startSpawn RPC）`,
    )
  }
}

// ============ 唤醒链 + feed-dog 看门狗 ============

/** 被注册唤醒的子 agent 记录（spawn 时注册；子完成/出错/超时消费） */
export interface WaitedChild {
  parentChatId: string
  type: string
  /** 唤醒策略（spawn 时声明，wakeScheduler.onChildDone 据此决定 silent 暂存 / resume 唤主） */
  wakePolicy: WakePolicy
}

/** 看门狗超时回调（service 注入：按 config.wake_on_timeout 决定唤主或仅 abort 子） */
export type AsyncWakeHandler = (child: {
  childChatId: string
  parentChatId: string
  type: string
}) => void

/** 看门狗超时阈值：读 config.global.watchdog.timeout_ms（默认 5min；feed-dog 每条 chunk 重置） */
function getWatchdogTimeoutMs(): number {
  return config.global.watchdog?.timeout_ms ?? 5 * 60 * 1000
}

/** 唤醒链：childChatId → {parentChatId, type, wakePolicy} */
const waitedChildren = new Map<string, WaitedChild>()

/** 看门狗定时器：childChatId → timer */
const asyncWatchdogs = new Map<string, ReturnType<typeof setTimeout>>()

let asyncWakeHandler: AsyncWakeHandler | null = null

/** service 层启动期注入看门狗超时回调。 */
export function setAsyncWakeHandler(fn: AsyncWakeHandler): void {
  asyncWakeHandler = fn
}

/**
 * 启动/重启看门狗（registerWaitedChild 与 feedWatchdog 共用）。
 * timeout_ms 内无 feed（chunk）/完成/清除 → 触发 asyncWakeHandler。
 */
function startWatchdog(childChatId: string): void {
  const timeoutMs = getWatchdogTimeoutMs()
  const timer = setTimeout(() => {
    const entry = waitedChildren.get(childChatId)
    if (!entry) return // 已被正常消费清除（clearWaitedChild）
    console.warn(
      `[spawnBroker] 看门狗超时 ${timeoutMs / 1000}s（childChatId=${childChatId}），触发 asyncWakeHandler`,
    )
    asyncWakeHandler?.({ childChatId, parentChatId: entry.parentChatId, type: entry.type })
  }, timeoutMs)
  asyncWatchdogs.set(childChatId, timer)
}

/**
 * 注册唤醒链 + 启动看门狗（spawn_role 调）。
 * 子完成 → service wakeScheduler 消费并 clearWaitedChild；timeout_ms 无 feed → 看门狗超时。
 * 同 childChatId 重复注册视为错误（防泄漏，规则12 fail loud）。
 */
export function registerWaitedChild(
  childChatId: string,
  parentChatId: string,
  type: string,
  wakePolicy: WakePolicy,
): void {
  if (waitedChildren.has(childChatId)) {
    throw new Error(`waitedChild 已存在（childChatId=${childChatId}），疑似重复 spawn 同 chatId`)
  }
  waitedChildren.set(childChatId, { parentChatId, type, wakePolicy })
  startWatchdog(childChatId)
}

/**
 * feed-dog：子 agent observer for-await 每条 chunk 调，重置看门狗计时。
 * 子仍在产出 chunk = generator 活着 = 未卡死；每次 feed 重新计时（取代旧的固定 5min 一次性超时）。
 * 非子 chat / 已清除 → 忽略（幂等）。
 */
export function feedWatchdog(childChatId: string): void {
  if (!waitedChildren.has(childChatId)) return
  const existing = asyncWatchdogs.get(childChatId)
  if (existing) clearTimeout(existing)
  startWatchdog(childChatId)
}

/**
 * 查 wait-子记录。
 * 子 loop 结束（决定是否 yield child_done）/ observer catch（出错唤主）/ service rebuild 据此判定。
 */
export function getWaitedParent(childChatId: string): WaitedChild | undefined {
  return waitedChildren.get(childChatId)
}

/**
 * 清除 wait-子 + 看门狗（wakeParent 成功 / chat.abort 调；幂等）。
 */
export function clearWaitedChild(childChatId: string): void {
  waitedChildren.delete(childChatId)
  const timer = asyncWatchdogs.get(childChatId)
  if (timer) {
    clearTimeout(timer)
    asyncWatchdogs.delete(childChatId)
  }
}

/**
 * 按主 chatId 清除其所有 wait-子 + 看门狗（主 chat.abort 调）。
 * 主被 abort 时其 wait-子完成不再唤主（用户主动停，防子完成反唤醒已停的主）。子 chat 本身不动（前端继续或转 ghost）。
 */
export function clearWaitedChildrenByParent(parentChatId: string): void {
  for (const [childChatId, entry] of waitedChildren) {
    if (entry.parentChatId === parentChatId) {
      waitedChildren.delete(childChatId)
      const timer = asyncWatchdogs.get(childChatId)
      if (timer) {
        clearTimeout(timer)
        asyncWatchdogs.delete(childChatId)
      }
    }
  }
}

/**
 * 清理所有 wait-子 + 看门狗（应用关闭时调用）。
 * 清除所有看门狗定时器 + 清空唤醒链映射，避免进程挂起。
 */
export function clearAllWaitedChildren(): void {
  for (const [childChatId, timer] of asyncWatchdogs) {
    clearTimeout(timer)
    asyncWatchdogs.delete(childChatId)
  }
  waitedChildren.clear()
}
