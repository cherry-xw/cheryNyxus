/**
 * Spawn Broker（主从 Agent 桌宠系统 CP3 / CP6）
 *
 * 职责：
 * 1. 维护 wait=true 挂起的 spawn Promise（按 childChatId 索引），等前端 subagent.result 回传唤醒。
 * 2. 暴露 broadcaster 注入接口：service 层启动时注入 ws 推送实现，agent 层 sense handler
 *    通过 emitSubagentCreated / emitSubagentDestroyed 触发 notification 推送，不直接依赖 service/ws（保持分层）。
 *
 * 选型理由（不复用 approvalRegistry）：
 *   approvalRegistry 的 resolve 签名是 (id, action:"accept"|"reject", reason?) → ApprovalDecision，
 *   语义为「审批决策」；spawn wait=true 需回传任意 content 字符串（子 agent 最终结果），
 *   塞 reason 字段语义错位、且需改造 approvalRegistry 接口。故新建专用 spawnBroker：
 *   逻辑同 approvalRegistry（集中 Map + resolve/reject + 无超时），接口契合 spawn 场景。
 *
 * notification.requestId：用 parentChatId（spawn_subagent / destroy_subagent sense 在 senseMiddleware
 *   内 await 执行，无法取主 agent 当前 WS 请求的 requestId；前端按 chatId 路由 notification 即可）。
 *
 * CP6 broadcaster 复用决策（不新建 destroyBroadcaster）：
 *   spawn/destroy 共享同一「向主 chat 所属连接推 notification」机制（findWsByChatId + transport.encode），
 *   仅 notification.type 与 data 不同。新建并行 destroyBroadcaster 会复制 install/warn/readyState 检查
 *   逻辑（规则 2 反例）。统一通道 + kind 显式判别（避结构类型 hack），最小扩展耦合 service 层一处分支。
 */

/** subagent_created notification data（推送契约，前端 Agent 2 依赖） */
export interface SubagentCreatedData {
  /** 子 chat id（前端据此驱动子 chat） */
  chatId: string;
  /** 主 chat id（前端溯源 pet 树） */
  parentChatId: string;
  /** 子 agent 类型（config.subagents 键名） */
  type: string;
  /** 交付子 agent 的任务 prompt */
  prompt: string;
  /** 子 agent 用的 brain 名 */
  brain: string;
  /** 子 agent 启用的感官组 */
  senseGroups: string[];
  /** 是否等待子 agent 结果（true: 前端跑完须调 subagent.result 回传） */
  wait: boolean;
}

/** subagent_destroyed notification data（推送契约，前端 Agent A 依赖） */
export interface SubagentDestroyedData {
  /** 被销毁的子 chat id（前端据此移除子 pet） */
  chatId: string;
}

/** subagent 生命周期事件判别（service installer 据此选 notification.type） */
export type SubagentEventKind = "created" | "destroyed";

/**
 * Broadcaster：把 subagent 生命周期事件送到主 chat 所属连接的 ws。
 * service 层启动时注入（service/websocket 持 connectionManager + transport，
 * 反查 chatId→connectionId→ws 后 ws.send(transport.encode(notification))）。
 *
 * 第 1 参 parentChatId：主 chat id（也是 notification.requestId）；
 * 第 2 参 kind：事件类型（created/destroyed → subagent_created/subagent_destroyed）；
 * 第 3 参 data：推送内容（SubagentCreatedData | SubagentDestroyedData）。
 */
export type SpawnBroadcaster = (
  parentChatId: string,
  kind: SubagentEventKind,
  data: SubagentCreatedData | SubagentDestroyedData,
) => void;

interface PendingSpawn {
  resolve: (content: string) => void;
  reject: (error: Error) => void;
}

/** 心跳状态类型 */
export type HeartbeatStatus = "running" | "finished" | "error";

/** 心跳消息结构(子 agent → 主 agent) */
export interface Heartbeat {
  /** 子 chat id */
  childChatId: string;
  /** 心跳状态 */
  status: HeartbeatStatus;
  /** finished 时带子 agent 最终结果 */
  result?: string;
  /** error 时带错误信息 */
  error?: string;
  /** 时间戳(ms) */
  timestamp: number;
}

/** 心跳监听器(主 agent wait=true 注册) */
interface HeartbeatListener {
  resolve: (content: string) => void;
  reject: (error: Error) => void;
  /** 30s 超时计时器 */
  timer: ReturnType<typeof setTimeout>;
}

/** 挂起的 spawn wait=true Promise（childChatId → resolver） */
const pendingSpawns = new Map<string, PendingSpawn>();

/** 心跳监听器(childChatId → listener;主 agent wait=true 注册,子 agent 心跳到达时触发) */
const heartbeatListeners = new Map<string, HeartbeatListener>();

/** 心跳超时阈值(30s,与阶段0确认一致) */
const HEARTBEAT_TIMEOUT_MS = 30000;

/** broadcaster（service 层启动时注入；未注入时 emit 静默丢弃 + warn 日志） */
let broadcaster: SpawnBroadcaster | null = null;

/**
 * 注入 ws 推送实现（service/index.ts 启动期调用）。
 */
export function setSpawnBroadcaster(fn: SpawnBroadcaster): void {
  broadcaster = fn;
}

/**
 * 推送 subagent_created notification 给主 chat 所属连接。
 * spawn_subagent sense 执行时调用。
 *
 * broadcaster 未注入（如测试场景）：打印 warn，不阻塞 spawn 流程
 * （sense 仍返回，前端通过其他途径或下次 chat.get 重建状态）。
 */
export function emitSubagentCreated(data: SubagentCreatedData): void {
  if (broadcaster) {
    broadcaster(data.parentChatId, "created", data);
  } else {
    // 规则12 fail loud：未注入 broadcaster 是配置错误，但 spawn 流程不应阻塞主 agent，
    // 此处 warn + 继续（前端通过 chat.list 也能重建子 pet）。
    console.warn(
      `[spawnBroker] broadcaster 未注入，subagent_created 通知未推送（parentChatId=${data.parentChatId}, childChatId=${data.chatId}）`,
    );
  }
}

/**
 * 推送 subagent_destroyed notification 给主 chat 所属连接。
 * destroy_subagent sense 执行时调用。
 *
 * data 不携带 parentChatId（线上契约仅 {chatId}），故 parentChatId 单独传入用于路由。
 * broadcaster 未注入：warn + 不阻塞（chat.delete 已生效，前端 chat.list 也能感知子 chat 消失）。
 */
export function emitSubagentDestroyed(parentChatId: string, data: SubagentDestroyedData): void {
  if (broadcaster) {
    broadcaster(parentChatId, "destroyed", data);
  } else {
    console.warn(
      `[spawnBroker] broadcaster 未注入，subagent_destroyed 通知未推送（parentChatId=${parentChatId}, chatId=${data.chatId}）`,
    );
  }
}

/**
 * 创建 wait=true 挂起的 spawn Promise（无超时，不限时可一直等，与 plan/agent-pet.md 决策一致）。
 *
 * 前端跑完子 agent → 调 subagent.result(childChatId, content) → resolveSpawnResult 唤醒。
 * 同 childChatId 重复注册视为错误（防泄漏，规则12 fail loud）。
 */
export function createSpawnWait(childChatId: string): Promise<string> {
  if (pendingSpawns.has(childChatId)) {
    throw new Error(
      `spawn wait 已存在（childChatId=${childChatId}），疑似前端重复 spawn 同 chatId`,
    );
  }
  return new Promise<string>((resolve, reject) => {
    pendingSpawns.set(childChatId, { resolve, reject });
  });
}

/**
 * wait=true 结果回传（subagent.result RPC handler 调用）。
 * @returns 命中 true；未挂起（误调或 wait=false）false（规则12：调用方应上报 NOT_FOUND）
 */
export function resolveSpawnResult(childChatId: string, content: string): boolean {
  const entry = pendingSpawns.get(childChatId);
  if (!entry) return false;
  entry.resolve(content);
  pendingSpawns.delete(childChatId);
  return true;
}

/**
 * 中止挂起的 spawn（chat.abort 跨连接重连等场景调，解除 await 使主 agent 流正常结束）。
 * 与 approvalRegistry.rejectApproval 同模式：throw AgentAbortError 由调用方传入。
 */
export function rejectSpawn(childChatId: string, error: Error): void {
  const entry = pendingSpawns.get(childChatId);
  if (entry) {
    entry.reject(error);
    pendingSpawns.delete(childChatId);
  }
}

/**
 * 调试/状态查询：当前挂起的 spawn 数。
 */
export function pendingSpawnCount(): number {
  return pendingSpawns.size;
}

/**
 * 注册心跳监听器（主 agent wait=true 调用）。
 *
 * 返回 Promise<string>:
 * - 收到 finished 心跳(resolve,内容为子 agent 结果)
 * - 收到 error 心跳(reject,错误信息)
 * - 30s 未收到任何心跳(reject,超时)
 *
 * 同 childChatId 重复注册视为错误(防泄漏,规则12 fail loud)。
 */
export function registerHeartbeatListener(childChatId: string): Promise<string> {
  if (heartbeatListeners.has(childChatId)) {
    throw new Error(`心跳监听已存在（childChatId=${childChatId}），疑似重复注册`);
  }

  return new Promise<string>((resolve, reject) => {
    // 启动 30s 超时计时器
    const timer = setTimeout(() => {
      heartbeatListeners.delete(childChatId);
      reject(new Error(`子 agent 心跳超时 ${HEARTBEAT_TIMEOUT_MS / 1000}s（childChatId=${childChatId}）`));
    }, HEARTBEAT_TIMEOUT_MS);

    heartbeatListeners.set(childChatId, { resolve, reject, timer });
  });
}

/**
 * 查询是否存在心跳监听器。
 *
 * 子 agent heartbeat middleware 据此判断是否发 running 心跳:仅被 wait 的子 chat
 * 才发(有 listener),过滤主 agent 无消费者心跳(主也跑同 middleware 链,但其 chatId 无
 * listener),避免 notifyHeartbeat 每 5s 触发 "no listener" warn 噪音。
 */
export function hasHeartbeatListener(childChatId: string): boolean {
  return heartbeatListeners.has(childChatId);
}

/**
 * 通知心跳到达（子 agent observer 检测到心跳 chunk 时调用）。
 *
 * @param childChatId 子 chat id
 * @param status 心跳状态(running/finished/error)
 * @param result finished 时子 agent 最终结果
 * @param error error 时错误信息
 * @returns 命中 true;未监听 false(可能未注册或已清理)
 */
export function notifyHeartbeat(
  childChatId: string,
  status: HeartbeatStatus,
  result?: string,
  error?: string,
): boolean {
  const listener = heartbeatListeners.get(childChatId);
  if (!listener) {
    console.warn("[spawnBroker] notifyHeartbeat: no listener for", { childChatId, status });
    return false;
  }

  console.log("[spawnBroker] notifyHeartbeat:", { childChatId, status, hasResult: !!result, resultLen: result?.length ?? 0 });

  if (status === "running") {
    // running:重置 30s 超时计时器,继续等
    clearTimeout(listener.timer);
    listener.timer = setTimeout(() => {
      heartbeatListeners.delete(childChatId);
      listener.reject(new Error(`子 agent 心跳超时 ${HEARTBEAT_TIMEOUT_MS / 1000}s（childChatId=${childChatId}）`));
    }, HEARTBEAT_TIMEOUT_MS);
    return true;
  }

  if (status === "finished") {
    // finished:resolve 结果,清理
    clearTimeout(listener.timer);
    heartbeatListeners.delete(childChatId);
    console.log("[spawnBroker] notifyHeartbeat: resolve finished", { childChatId, resultLen: result?.length ?? 0 });
    listener.resolve(result ?? "");
    return true;
  }

  if (status === "error") {
    // error:reject,清理
    clearTimeout(listener.timer);
    heartbeatListeners.delete(childChatId);
    console.log("[spawnBroker] notifyHeartbeat: reject error", { childChatId, error });
    listener.reject(new Error(error ?? "子 agent 执行出错"));
    return true;
  }

  return false;
}

/**
 * 清理心跳监听器(abort/错误场景调用,释放资源)。
 */
export function clearHeartbeatListener(childChatId: string, error: Error): void {
  const listener = heartbeatListeners.get(childChatId);
  if (listener) {
    clearTimeout(listener.timer);
    heartbeatListeners.delete(childChatId);
    listener.reject(error);
  }
}
