import { AgentBuilder } from "@/agent/builder.js";
import type { RuntimeSelection } from "@/agent/runtimeResolver.js";
import { getMessages, parseMessageRow, getChatRuntimeSelection, updateChatMetadata } from "@/db/chat.js";
import type { LLMResponse } from "@/core/message/adapter";

/**
 * Chat 运行时缓存：chatId → builder + runtime 选择（单 chat 绑定，跨轮不重建）
 * （P2-1 从 send.ts 拆出）
 *
 * 每个 chatId 独享一个 AgentBuilder 实例（不再全局单例），与 Middleware 一同随 chat 生命周期存在。
 * runtime selection 由 chat.create/runtime.set 原子注入。
 * 实例不重建，messages 天然保留，无需迁移。
 */
interface ChatRuntime {
  builder: AgentBuilder;
  selection?: RuntimeSelection;
}

const chatRuntimes = new Map<string, ChatRuntime>();

/**
 * 取 chat 对应的完整运行时。
 * ensureChat 后必定存在，缺失则视为内部错误。
 */
async function ensureRuntime(chatId: string): Promise<ChatRuntime> {
  await ensureChat(chatId);
  const runtime = chatRuntimes.get(chatId);
  if (!runtime) {
    throw new Error(`Chat runtime not initialized: ${chatId}`);
  }
  return runtime;
}

/**
 * 原子解析并注入完整 runtime。
 */
function configureRuntime(
  runtime: ChatRuntime,
  chatId: string,
  selection: RuntimeSelection,
): void {
  runtime.selection = selection;
  runtime.builder.configureRuntime(selection);
  // 持久化 selection 到 metadata.runtime，服务重启后 ensureChat 自动恢复
  updateChatMetadata(chatId, { runtime: selection });
}

/**
 * 从 DB 加载历史消息，交给 builder.init 注入 middleware 内存。
 * 仅 ensureChat 创建时调用一次，send/resume 不再重复加载。
 */
function loadHistory(chatId: string): LLMResponse[] | undefined {
  const rows = getMessages(chatId);
  if (rows.length === 0) {
    return undefined;
  }
  return rows.map((row) => {
    const parsed = parseMessageRow(row);
    return {
      id: row.id,
      role: parsed.role,
      content: parsed.content ?? "",
      thinking: parsed.thinking,
      senseCalls: parsed.senseCall,
      hash: parsed.hash,
      replace: parsed.replace,
      originalContent: parsed.originalContent,
      revoked: parsed.revoked,
      createdAt: row.created_at,
      updateAt: row.created_at,
    };
  });
}

/**
 * 获取或创建 chat 对应的 AgentBuilder 实例（单 chat 绑定，跨轮不重建）。
 *
 * 创建时完成：原子配置 runtime（如传入）→ 加载历史。
 * 幂等：已存在直接返回，不重新配置。send/resume 不带 brain/senseGroups，
 * 依赖 create 时已配置的 runtime；服务端重启内存丢失后须重新 create。
 *
 * @param selection 可选，chat.create/runtime.set 携带时参与原子 runtime 配置
 */
export async function ensureChat(
  chatId: string,
  selection?: RuntimeSelection,
): Promise<AgentBuilder> {
  const existing = chatRuntimes.get(chatId);
  if (existing) {
    if (selection) {
      configureRuntime(existing, chatId, selection);
    } else {
      // P1-6：registry 变更（mcp.reload/重编译）后，存量 chat 的 senseTable 快照过期。
      // send/resume 入口（无 selection）用持久化 selection 重建 senseTable，拾取新增/移除感官。
      // 重建在 loop 启动前，ctx.runtime 引用替换安全（generator 尚未运行）。
      const sel = existing.selection;
      if (sel && existing.builder.isSenseTableStale()) {
        configureRuntime(existing, chatId, sel);
      }
    }
    return existing.builder;
  }

  // 每个 chat 独享一个 AgentBuilder 实例（不再全局单例）
  const builder = new AgentBuilder().build();

  const runtime: ChatRuntime = { builder };
  chatRuntimes.set(chatId, runtime);
  try {
    // 原子配置 runtime selection：
    //   1. 显式传入（chat.create/runtime.set）
    //   2. 否则从持久化 metadata.runtime 恢复（服务重启后内存丢失，自动恢复）
    const resolvedSelection = selection ?? getChatRuntimeSelection(chatId);
    if (resolvedSelection) {
      configureRuntime(runtime, chatId, resolvedSelection);
    }

    // 一次性加载历史到内存
    builder.init(chatId, loadHistory(chatId));
  } catch (err) {
    // 半初始化清理：configureRuntime 深校验或 init 抛错时，移除刚 set 的 map 项，
    // 避免留半配置 runtime（无 brain/sense）被后续 send 误用。DB 行由调用方清理。
    chatRuntimes.delete(chatId);
    throw err;
  }

  return builder;
}

/**
 * 原子设置 runtime selection。
 * 由 runtime.set handler 调用。
 */
export async function setRuntime(
  chatId: string,
  selection: RuntimeSelection,
): Promise<void> {
  const runtime = await ensureRuntime(chatId);
  configureRuntime(runtime, chatId, selection);
}

/**
 * 将 chatId 从运行时缓存移除（删除 chat 时调用）
 */
export function clearChatRuntime(chatId: string): void {
  chatRuntimes.delete(chatId);
}

/**
 * 中止 chat 运行中 generator（chat.abort 场景）。
 * 转发 builder.abort → compose.abort 注入错误退出 generator。
 */
export function abortChatRuntime(chatId: string): void {
  chatRuntimes.get(chatId)?.builder.abort();
}
