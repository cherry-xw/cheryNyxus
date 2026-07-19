import { AgentBuilder } from "@/agent/builder.js";
import type { RuntimeSelection } from "@/agent/runtimeResolver.js";
import { getMessages, parseMessageRow, getChatRuntimeSelection, getChatPromptOverride, getChatWorkspace, getChatSkillFilter, updateChatMetadata, getChat } from "@/db/chat.js";
import type { LLMResponse } from "@/core/message/adapter";
import { extractSummaryBlock } from "@/core/middleware/messageJournal.js";
import { notifyRestartActivityChanged } from "@/service/restartCoordinator.js";

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
  /** 当前活跃 chat.send/chat.resume 的协议运行标识。 */
  activeRunId?: string;
}

const chatRuntimes = new Map<string, ChatRuntime>();
/** 会话级临时角色编制；进程重启即失效，刻意不写数据库。 */
const sessionRoleRuntimes = new Map<string, { primary: RuntimeSelection; roles: Record<string, RuntimeSelection> }>();
/** 子 chat 的临时运行时：用于 role 覆盖，优先于数据库默认值且不落盘。 */
const ephemeralChatRuntimes = new Map<string, RuntimeSelection>();

/**
 * 读 chat 当前 runtime selection（内存 chatRuntimes）。
 * observer 入库 user 消息时记 messages.runtime 用(消息级 runtime 溯源,见 agent-pet.md §5.7)。
 */
export function getChatSelection(chatId: string): RuntimeSelection | undefined {
  return chatRuntimes.get(chatId)?.selection;
}

/**
 * 查 chat 当前是否正在运行(有活跃 generator)。
 * chat.list 暴露 running 字段用(前端据此判断子 agent 是否还活着、主 chat 是否卡死)。
 */
export function isChatRunning(chatId: string): boolean {
  return chatRuntimes.get(chatId)?.builder.isRunning() ?? false;
}

/** 守护进程待重启时，用于判定所有 chat 是否已安全空闲。 */
export function hasRunningChats(): boolean {
  return [...chatRuntimes.values()].some((runtime) => runtime.builder.isRunning());
}

/** 获取当前活跃运行，用于 queued send 回包与带条件的 chat.abort。 */
export function getActiveChatRunId(chatId: string): string | undefined {
  return chatRuntimes.get(chatId)?.activeRunId;
}

/** 在启动 send/resume 前登记运行；同一 chat 同时至多一个活跃运行。 */
export function activateChatRun(chatId: string, runId: string): void {
  const runtime = chatRuntimes.get(chatId);
  if (!runtime) {
    throw new Error(`Chat runtime not initialized: ${chatId}`);
  }
  runtime.activeRunId = runId;
}

/** 仅清除自己启动的运行，防止旧 generator 的 finally 清掉新运行。 */
export function releaseChatRun(chatId: string, runId: string): void {
  const runtime = chatRuntimes.get(chatId);
  if (runtime?.activeRunId === runId) {
    runtime.activeRunId = undefined;
  }
  notifyRestartActivityChanged();
}

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
 * 主 agent（parent_chat_id 为空）硬编码注入 memory_manage；子 agent 排除。
 */
function configureRuntime(
  runtime: ChatRuntime,
  chatId: string,
  selection: RuntimeSelection,
): void {
  runtime.selection = selection;
  const isMainAgent = !getChat(chatId)?.parent_chat_id;
  runtime.builder.configureRuntime(selection, isMainAgent);
  // 持久化 selection 到 metadata.runtime，服务重启后 ensureChat 自动恢复
  updateChatMetadata(chatId, { runtime: selection });
}

/** 设置主会话的临时角色编制，并立即切换主角色运行时，不更新 metadata.runtime。（主 agent，注入 memory_manage） */
export async function setSessionRoleRuntimes(
  chatId: string,
  primary: RuntimeSelection,
  roles: Record<string, RuntimeSelection>,
): Promise<void> {
  const runtime = await ensureRuntime(chatId);
  runtime.selection = primary;
  runtime.builder.configureRuntime(primary, true);
  sessionRoleRuntimes.set(chatId, { primary, roles });
}

/** 返回祖先主会话的某角色临时编制，供 spawn_role 使用。 */
export function getSessionRoleRuntime(chatId: string, role: string): RuntimeSelection | undefined {
  let current = chatId;
  // parent 链理论上无环；上限防脏数据无限循环。
  for (let depth = 0; depth < 32; depth += 1) {
    const session = sessionRoleRuntimes.get(current);
    if (session) return session.roles[role];
    const row = getChat(current);
    if (!row?.parent_chat_id) return undefined;
    current = row.parent_chat_id;
  }
  return undefined;
}

/** 注册刚派发子角色的临时编制；在该 child 首次 ensureChat 时消费。（子 agent，排除 memory_manage） */
export function setEphemeralChatRuntime(chatId: string, selection: RuntimeSelection): void {
  ephemeralChatRuntimes.set(chatId, selection);
  const runtime = chatRuntimes.get(chatId);
  // 已初始化但尚未运行的复用子角色也切到临时编制；运行中的请求保持其启动时配置。
  if (runtime && !runtime.builder.isRunning()) {
    runtime.selection = selection;
    runtime.builder.configureRuntime(selection, false);
  }
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
  const parsedRows = rows.map((row) => {
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
      contextCompaction: parsed.contextCompaction,
      contextCompactionTokens: parsed.contextCompactionTokens,
      createdAt: row.created_at,
      updateAt: row.created_at,
    };
  });
  // 取最后一条 compact 摘要作为重建起点；其后的全部后续对话一并加载。
  // 与 compactToLatestSummary 内存裁剪语义对齐——冷重建不得丢失压缩点之后已持久化的消息
  // （否则重启/切 chat 回来，summary 之后的几轮对话"DB 在、模型看不见"）。
  let summaryIdx = -1;
  for (let i = parsedRows.length - 1; i >= 0; i--) {
    if (parsedRows[i]!.contextCompaction) {
      summaryIdx = i;
      break;
    }
  }
  if (summaryIdx === -1) return parsedRows;
  const latestSummary = parsedRows[summaryIdx]!;
  return [
    {
      ...latestSummary,
      role: "system",
      content: `以下是此前对话压缩后的上下文摘要。将其视为后续工作的唯一历史上下文：\n\n${extractSummaryBlock(latestSummary.content)}`,
    },
    ...parsedRows.slice(summaryIdx + 1),
  ];
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
    const resolvedSelection = selection ?? ephemeralChatRuntimes.get(chatId) ?? getChatRuntimeSelection(chatId);
    if (resolvedSelection) {
      configureRuntime(runtime, chatId, resolvedSelection);
    }

    // 一次性加载历史到内存 + 注入 system prompt（chat metadata.promptPathOverride 覆盖；
    // 来源：spawn 写子 agent / chat.create 写预设主 agent；缺省 → undefined → 全局）
    // skillFilter：per-role 技能组/插件组过滤（metadata.skillFilter），仅 <skills> 块按角色裁剪。
    builder.init(chatId, loadHistory(chatId), getChatPromptOverride(chatId), getChatWorkspace(chatId), getChatSkillFilter(chatId));
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
  sessionRoleRuntimes.delete(chatId);
  ephemeralChatRuntimes.delete(chatId);
}

/**
 * 解析 chat 当前生效的 runtime selection（含 ephemeral 子角色覆盖），解析顺序与 ensureRuntime 对齐：
 * ephemeral 临时编制（子 agent role 覆盖）优先于数据库默认值。
 * 供 autoCompact 等热路径使用——使 compact 可用性按当次发送的实际 brain 判定。
 */
export function resolveChatRuntimeSelection(chatId: string): RuntimeSelection | undefined {
  return ephemeralChatRuntimes.get(chatId) ?? getChatRuntimeSelection(chatId);
}

/**
 * 中止 chat 运行中 generator（chat.abort 场景）。
 * 转发 builder.abort → compose.abort 注入错误退出 generator。
 */
export function abortChatRuntime(chatId: string): void {
  chatRuntimes.get(chatId)?.builder.abort();
}
