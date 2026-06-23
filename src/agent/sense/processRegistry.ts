import type { ChildProcess } from "child_process";
import type { SenseSharedData } from "@/core/sense/senseCreator.js";
import { logger } from "@/utils/logger/index.js";

/**
 * Bash 子进程注册表（execute_command sense 生命周期管理）。
 *
 * 三条规则：
 *   - 运行结束 → 清除：进程 close/error 时 unregister（bash.ts 的 close handler 调用）
 *   - 挂起 → 保留：超时不杀，注册项留在表中待手动管理（符合 bash.ts 超时转挂起语义）
 *   - 杀死 → 清除：bash.kill RPC 触发 killBashProcess → 进程退出 → close handler 统一 unregister
 *
 * 按 chatId 组织：每个 chat 独立 pid→entry 映射，支持按会话查询 / 显式杀（bash.list / bash.kill RPC）。
 *
 * 进程组 kill：spawn 时 detached:true（bash.ts），本表 kill 用 process.kill(-pid, SIGTERM) 终止整个
 *   进程组，避免 shell（sh -c）的孙子进程泄漏——用户显式「杀死」应彻底。
 *
 * 范式参考 core/sense/approvalRegistry.ts（模块级 Map + 函数式 API，core/agent 层注册、service 层触发）。
 *
 * chatId 来源：sense executor 签名固定为 (args, senseSharedData)，无 chatId 参数；改全局签名成本过高
 *   且仅 bash 需要。改由 tool.ts doExecuteSense 调 execute 前把 chatId 注入 sharedData 的保留 namespace，
 *   bash executor 读取——不影响其他 sense / 外部编译 sense。
 */

/** 保留 namespace：执行上下文元数据（chatId 等），sense 间共享数据不应占用。 */
const SENSE_CTX_NAMESPACE = "__ctx__";
const CTX_KEY_CHAT_ID = "chatId";

/**
 * 注入 chatId 到 sharedData（tool.ts doExecuteSense 调 execute 前调用）。
 */
export function setSenseCtxChatId(sharedData: SenseSharedData, chatId: string): void {
  let ctx = sharedData.get(SENSE_CTX_NAMESPACE);
  if (!ctx) {
    ctx = new Map();
    sharedData.set(SENSE_CTX_NAMESPACE, ctx);
  }
  ctx.set(CTX_KEY_CHAT_ID, chatId);
}

/**
 * 读取 sharedData 中的 chatId（bash executor 调用）。测试场景（空 Map）返回 undefined。
 */
export function getSenseCtxChatId(sharedData: SenseSharedData | undefined): string | undefined {
  return sharedData?.get(SENSE_CTX_NAMESPACE)?.get(CTX_KEY_CHAT_ID) as string | undefined;
}

/** 对外暴露的进程条目（不含 ChildProcess 句柄，供 bash.list RPC 返回）。 */
export interface BashProcessEntry {
  pid: number;
  command: string;
  description: string;
  startedAt: number;
  /** 是否已被显式 kill（区分自然结束，前端展示用）。 */
  killed: boolean;
}

/** 内部记录（持有 ChildProcess 句柄供 kill）。 */
interface BashProcessRecord extends BashProcessEntry {
  proc: ChildProcess;
}

/** chatId → (pid → record)。 */
const registry = new Map<string, Map<number, BashProcessRecord>>();

function getChatMap(chatId: string): Map<number, BashProcessRecord> {
  let m = registry.get(chatId);
  if (!m) {
    m = new Map();
    registry.set(chatId, m);
  }
  return m;
}

/**
 * spawn 后注册（挂起保留）。
 * chatId 为空（测试 / 未注入）或无 pid 时不注册，bash 执行不受影响。
 */
export function registerBashProcess(
  chatId: string | undefined,
  proc: ChildProcess,
  meta: { command: string; description: string; startedAt: number },
): void {
  if (!chatId || proc.pid === undefined) return;
  const record: BashProcessRecord = {
    pid: proc.pid,
    proc,
    command: meta.command,
    description: meta.description,
    startedAt: meta.startedAt,
    killed: false,
  };
  getChatMap(chatId).set(proc.pid, record);
  logger.info(`[BASH PROC] 注册 chat=${chatId} pid=${proc.pid} cmd=${meta.command}`);
}

/**
 * 进程结束（close/error）后清除。「运行结束清除」「杀死后清除」均走此入口：
 * kill → 进程退出 → bash.ts close handler 调本函数，统一注销。
 */
export function unregisterBashProcess(chatId: string | undefined, pid: number): void {
  if (!chatId) return;
  const m = registry.get(chatId);
  if (!m) return;
  if (m.delete(pid)) {
    logger.info(`[BASH PROC] 清除 chat=${chatId} pid=${pid}`);
  }
  if (m.size === 0) {
    registry.delete(chatId);
  }
}

/**
 * 显式杀死整个进程组（bash.kill RPC 调用）。
 * 标记 killed=true 供 close handler / 前端区分；返回是否命中。
 * 注：不在此 unregister——kill → 进程退出 → close handler 统一 unregister（杀死后清除）。
 *    SIGTERM 通常足够；顽固进程可后续 escalate SIGKILL（当前实现未加，保持简单）。
 */
export function killBashProcess(chatId: string, pid: number): boolean {
  const m = registry.get(chatId);
  const entry = m?.get(pid);
  if (!entry) return false;

  entry.killed = true;
  try {
    // -pid 杀整个进程组（spawn detached:true 使子进程为组长）
    process.kill(-pid, "SIGTERM");
  } catch {
    // 进程组已不存在（进程退出/非组长）：兜底直接 kill 单进程
    try {
      entry.proc.kill("SIGTERM");
    } catch {
      // 进程已退出，忽略
    }
  }
  logger.info(`[BASH PROC] 杀死 chat=${chatId} pid=${pid}`);
  return true;
}

/**
 * 列出某 chat 挂起的进程（bash.list RPC 调用）。
 * 返回条目不含 ChildProcess 句柄。
 */
export function listBashProcesses(chatId: string): BashProcessEntry[] {
  const m = registry.get(chatId);
  if (!m) return [];
  return Array.from(m.values()).map(({ proc: _proc, ...rest }) => rest);
}
