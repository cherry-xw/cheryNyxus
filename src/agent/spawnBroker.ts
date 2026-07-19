/**
 * Spawn Broker（主从 Agent 桌宠系统 CP3 / wait=true 唤醒链）
 *
 * 职责（2026-07-09 重构：废除阻塞心跳，改 yield turn + 子完成唤醒，见 docs/agent-pet.md §5.4）：
 * 1. wait=true 唤醒链 `waitedChildren`（childChatId → {parentChatId, type}）：spawn 时注册，
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

// ============ broadcaster（role_created/destroyed notification 推送）============

/** role_created notification data（推送契约，前端依赖） */
export interface RoleCreatedData {
  /** 持久任务 id；前端以 chat.startSpawn 原子领取，重放不会重复执行。 */
  taskId: string;
  /** 子 chat id（前端据此驱动子 chat） */
  chatId: string;
  /** 主 chat id（前端溯源 pet 树） */
  parentChatId: string;
  /** 角色类型（config.roles / preset.roles 键名） */
  type: string;
  /** 角色头像（显式配置或按 type 稳定生成）。 */
  avatar: string;
  /** 交付角色的任务 prompt */
  prompt: string;
  /** 角色用的 brain 名 */
  brain: string;
  /** 角色启用的感官组（单组） */
  senseGroup: string;
  /** wait 标记（2026-07-09 后为信息性：wait=true/false 创建路径一致，前端均跑子；wait=true 子完成由 role_reply 唤主） */
  wait: boolean;
  /**
   * 触发本次 spawn 的 sense call id（= 主 chat sense message.id）。
   * 前端收 role_created/role_reply 时据此前往主 chat 对应 sense 调用框（scroll-to）。
   * 旧 chat 无此字段时 undefined（前端兜底）。
   */
  spawnSenseCallId?: string;
}

/** role_destroyed notification data（推送契约，前端 Agent A 依赖） */
export interface RoleDestroyedData {
  /** 被销毁的子 chat id（前端据此移除子 pet） */
  chatId: string;
}

/** 角色生命周期事件判别（service installer 据此选 notification.type） */
export type RoleEventKind = "created" | "destroyed";

/**
 * Broadcaster：把角色生命周期事件送到主 chat 所属连接的 ws。
 * service 层启动时注入（service/websocket 持 connectionManager + transport，
 * 反查 chatId→connectionId→ws 后 ws.send(transport.encode(notification))）。
 */
export type SpawnBroadcaster = (
  parentChatId: string,
  kind: RoleEventKind,
  data: RoleCreatedData | RoleDestroyedData,
) => void;

/** broadcaster（service 层启动时注入；未注入时 emit 静默丢弃 + warn 日志） */
let broadcaster: SpawnBroadcaster | null = null;

/**
 * 注入 ws 推送实现（service/index.ts 启动期调用）。
 */
export function setSpawnBroadcaster(fn: SpawnBroadcaster): void {
  broadcaster = fn;
}

/**
 * 推送 role_created notification 给主 chat 所属连接。
 * spawn_role sense 执行时调用。broadcaster 未注入：warn + 不阻塞。
 */
export function emitRoleCreated(data: RoleCreatedData): void {
  if (broadcaster) {
    broadcaster(data.parentChatId, "created", data);
  } else {
    console.warn(
      `[spawnBroker] broadcaster 未注入，role_created 通知未推送（parentChatId=${data.parentChatId}, childChatId=${data.chatId}）`,
    );
  }
}

/**
 * 推送 role_destroyed notification 给主 chat 所属连接。
 * broadcaster 未注入：warn + 不阻塞。
 */
export function emitRoleDestroyed(parentChatId: string, data: RoleDestroyedData): void {
  if (broadcaster) {
    broadcaster(parentChatId, "destroyed", data);
  } else {
    console.warn(
      `[spawnBroker] broadcaster 未注入，role_destroyed 通知未推送（parentChatId=${parentChatId}, chatId=${data.chatId}）`,
    );
  }
}

// ============ wait=true 唤醒链 + 看门狗 ============

/** 被 wait 的子 agent 记录（spawn wait=true 注册，子完成/出错/超时消费） */
export interface WaitedChild {
  parentChatId: string;
  type: string;
}

/** 看门狗超时回调（service 注入：wakeParent 超时 content + abortChatRuntime(child)） */
export type AsyncWakeHandler = (child: {
  childChatId: string;
  parentChatId: string;
  type: string;
}) => void;

/** 看门狗超时阈值（5min；仅覆盖子永不发完成/错误信号的挂死场景，规则12 fail loud 兜底） */
const WATCHDOG_TIMEOUT_MS = 5 * 60 * 1000;

/** wait=true 唤醒链：childChatId → {parentChatId, type} */
const waitedChildren = new Map<string, WaitedChild>();

/** 看门狗定时器：childChatId → timer */
const asyncWatchdogs = new Map<string, ReturnType<typeof setTimeout>>();

let asyncWakeHandler: AsyncWakeHandler | null = null;

/** service 层启动期注入看门狗超时回调（wakeParent 超时 + abortChatRuntime）。 */
export function setAsyncWakeHandler(fn: AsyncWakeHandler): void {
  asyncWakeHandler = fn;
}

/**
 * 注册 wait=true 唤醒链 + 启动看门狗（spawn_role wait=true 调）。
 * 子完成 → service wakeParent 消费并 clearWaitedChild；5min 无信号 → 看门狗超时唤主。
 * 同 childChatId 重复注册视为错误（防泄漏，规则12 fail loud）。
 */
export function registerWaitedChild(
  childChatId: string,
  parentChatId: string,
  type: string,
): void {
  if (waitedChildren.has(childChatId)) {
    throw new Error(
      `waitedChild 已存在（childChatId=${childChatId}），疑似重复 spawn 同 chatId`,
    );
  }
  waitedChildren.set(childChatId, { parentChatId, type });
  const timer = setTimeout(() => {
    const entry = waitedChildren.get(childChatId);
    if (!entry) return; // 已被正常消费清除（clearWaitedChild）
    console.warn(
      `[spawnBroker] 看门狗超时 ${WATCHDOG_TIMEOUT_MS / 1000}s（childChatId=${childChatId}），唤主 + abort 子`,
    );
    asyncWakeHandler?.({ childChatId, parentChatId: entry.parentChatId, type: entry.type });
  }, WATCHDOG_TIMEOUT_MS);
  asyncWatchdogs.set(childChatId, timer);
}

/**
 * 查 wait-子记录。
 * 子 loop 结束（决定是否 yield child_done）/ observer catch（出错唤主）/ service rebuild 据此判定。
 */
export function getWaitedParent(childChatId: string): WaitedChild | undefined {
  return waitedChildren.get(childChatId);
}

/**
 * 清除 wait-子 + 看门狗（wakeParent 成功 / chat.abort 调；幂等）。
 */
export function clearWaitedChild(childChatId: string): void {
  waitedChildren.delete(childChatId);
  const timer = asyncWatchdogs.get(childChatId);
  if (timer) {
    clearTimeout(timer);
    asyncWatchdogs.delete(childChatId);
  }
}

/**
 * 按主 chatId 清除其所有 wait-子 + 看门狗（主 chat.abort 调）。
 * 主被 abort 时其 wait-子完成不再唤主（用户主动停，防子完成反唤醒已停的主）。子 chat 本身不动（前端继续或转 ghost）。
 */
export function clearWaitedChildrenByParent(parentChatId: string): void {
  for (const [childChatId, entry] of waitedChildren) {
    if (entry.parentChatId === parentChatId) {
      waitedChildren.delete(childChatId);
      const timer = asyncWatchdogs.get(childChatId);
      if (timer) {
        clearTimeout(timer);
        asyncWatchdogs.delete(childChatId);
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
    clearTimeout(timer);
    asyncWatchdogs.delete(childChatId);
  }
  waitedChildren.clear();
}
