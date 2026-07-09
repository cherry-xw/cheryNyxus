/**
 * agentApi：基于 wsClient.rpc / rpcTrack 的高层 RPC 封装。
 * CP1 骨架：方法签名定好，错误抛出由调用方（agents store）处理。
 * 流式方法（sendMessage/getHistory）暴露 requestId 供 chunk 路由。
 *
 * 协议见 docs/protocol.md。方法：chat.* / runtime.set / sense.approval / brain.list。
 */
import { wsClient } from "./ws";
import type { RpcResponse } from "./ws";

/** chat.list 返回的单条 chat 摘要（对齐后端 listAllChats）。brain/senseGroups 在 metadata.runtime 不暴露于 list。 */
export interface ChatSummary {
  chatId: string;
  /** ms 时间戳（后端 created_at） */
  createdAt?: number;
  /** ms 时间戳（后端 updated_at）= 最后运行时间，stage top-5 排序 + 会话列表 last-run 用 */
  updatedAt?: number;
  messageCount?: number;
  /** 子 chat 关联主 chat；主 chat 为 null。后端 parent_chat_id 列。 */
  parentChatId?: string | null;
  /** 仅 includePreview=true 返：首条 user 消息截断（≤40），会话列表辨识用。CP8 */
  preview?: string;
  /** 仅 includePreview=true 返：user 消息数 = 会话轮次。CP8 */
  turnCount?: number;
  /** 子 agent 是否已完成（后端 metadata.finished）。前端据 finished===true 重建子 pet 为 ghost。主 chat 恒 undefined。 */
  finished?: boolean;
  /** chat 当前是否正在运行（后端 chatRuntimes.get(chatId)?.builder.isRunning()）。前端据此判断子 agent 是否还活着、主 chat 是否卡死。 */
  running?: boolean;
}

/** chat.create 参数。主 agent：brain + senseGroups（+ mcpServers?）；子 agent：额外 parentChatId。 */
export interface CreateAgentOptions {
  brain: string;
  senseGroups: string[];
  mcpServers?: string[];
  /** 可选，未给则后端生成 */
  chatId?: string;
  /** 子 agent 关联主 chat（CP3 子 agent 用） */
  parentChatId?: string;
}

/** runtime.set 选择（每轮可换 brain + 工具组）。 */
export interface RuntimeSelection {
  brain: string;
  senseGroups: string[];
  mcpServers?: string[];
}

export type ApprovalAction = "accept" | "reject";

/**
 * brain.list 单条 brain 信息（对齐后端 Agent 1 契约）。
 * contextLimit 用于 ContextBar 计算（CP7 接 tokenizer）。
 */
export interface BrainInfo {
  name: string;
  contextLimit: number;
  /** 是否为 config.default.brain（AgentDialog 无 runtime 时预选） */
  default?: boolean;
  [k: string]: unknown;
}

/** brain.list 响应形状。 */
export interface BrainListResponse {
  brains: BrainInfo[];
  mcpServers: string[];
}

/** sense.tools 响应单项：内置工具元信息（name=原名/key，label=中文名/显示，description=解释/tooltip）。 */
export interface SenseToolInfo {
  name: string;
  label: string;
  description: string;
}

/** /api/config 返回形状（FAB default + AgentDialog senseGroups 全名单 + default 标记，后端 Agent B 暴露）。 */
export interface SenseGroupOption {
  name: string;
  /** 是否在 config.default.senseGroups 内（AgentDialog 无 runtime 时预选） */
  default: boolean;
}

export interface ConfigDefault {
  default?: RuntimeSelection;
  /** 可用 senseGroups 全名单 + default 标记（AgentDialog 单选选项 + 预选默认项；缺省回退 [{name:"default", default:true}]） */
  senseGroups?: SenseGroupOption[];
}

/** config.get 响应 / config.save 入参：.chery/config.yaml 原文（除 server 段）。对齐后端 ConfigRaw。 */
export interface BrainConfigDto {
  url?: string;
  model: string;
  key?: string;
  thinking?: boolean;
  provider: string;
  rpm?: number;
  mock?: { enabled?: boolean; file: string };
  contextLimit?: number;
}

export interface McpServerConfigDto {
  transport: "stdio" | "streamable-http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  supervision?: "auto" | "confirm" | "manual";
}

export interface GlobalConfigDto {
  thinking: boolean;
  supervision: "auto" | "confirm" | "manual";
  stream: boolean;
  sense_execute_timeout?: number;
  approval_timeout?: number;
  maxLoopCount?: number;
  bash_log_retention_hours?: number;
  file_compression?: {
    truncate_threshold?: number;
    truncate_preview_lines?: number;
    log_file_extensions?: string[];
    drain_preview_count?: number;
  };
  logger?: {
    level?: "debug" | "info" | "warn" | "error" | "silent";
    output?: ("console" | "file")[];
    timestamp?: boolean;
    location?: boolean;
    format?: "plain" | "json";
  };
}

export interface ConfigDto {
  global: GlobalConfigDto;
  llm: { brain: Record<string, BrainConfigDto> };
  sense_groups?: Record<string, string[]>;
  mcp_servers?: Record<string, McpServerConfigDto>;
  default?: { brain: string; senseGroups: string[]; mcpServers?: string[] };
  subagents?: Record<string, { brain: string; senseGroups: string[] }>;
}

function fail(method: string, res: RpcResponse): Error {
  return new Error(res.error?.message ?? `${method} failed`);
}

/** 非流式 RPC：返回 success 时解包 data，否则 throw。 */
async function call<T>(method: string, params: unknown): Promise<T> {
  const res = await wsClient.rpc(method, params);
  if (!res.success) throw fail(method, res);
  return res.data as T;
}

/**
 * 流式 RPC：返回 requestId（供 routeChunk 映射 chatId）+ 完成承诺。
 * response 在流式结束（done notification）后 resolve；调用方按需 await。
 */
function callStream(
  method: string,
  params: unknown,
): { requestId: string; done: Promise<RpcResponse> } {
  const { requestId, response } = wsClient.rpcTrack(method, params);
  return { requestId, done: response };
}

export const agentApi = {
  /** chat.list：列出所有 chat（主 chat → 主 pet；子 chat 按 parentChatId 挂主附近）。CP8：includePreview=true 增返 preview/turnCount（会话列表用）。 */
  async listChats(includePreview = false): Promise<ChatSummary[]> {
    const data = await call<{ chats?: ChatSummary[] }>("chat.list", { includePreview });
    return data?.chats ?? [];
  },

  /** chat.create：创建 chat。返回新建 chatId。 */
  async createAgent(opts: CreateAgentOptions): Promise<string> {
    const data = await call<{ chatId?: string }>("chat.create", {
      brain: opts.brain,
      senseGroups: opts.senseGroups,
      mcpServers: opts.mcpServers ?? [],
      chatId: opts.chatId,
      parentChatId: opts.parentChatId,
    });
    if (!data?.chatId) throw new Error("chat.create: missing chatId in response");
    return data.chatId;
  },

  /**
   * chat.send：流式发消息。返回 requestId（agents store 记录 requestId→chatId 供 routeChunk）。
   * done 在流式结束 resolve；CP1 可不 await（chunk 路由独立）。
   */
  sendMessage(chatId: string, text: string): { requestId: string; done: Promise<RpcResponse> } {
    return callStream("chat.send", { chatId, prompt: text });
  },

  /** runtime.set：原子设置 chat 的 brain + 工具组 + mcpServers。 */
  async setRuntime(chatId: string, selection: RuntimeSelection): Promise<void> {
    await call("runtime.set", {
      chatId,
      brain: selection.brain,
      senseGroups: selection.senseGroups,
      mcpServers: selection.mcpServers ?? [],
    });
  },

  /** chat.abort：中止当前流（清内存运行时 + 释放连接，不删 DB）。 */
  async abortAgent(chatId: string): Promise<void> {
    await call("chat.abort", { chatId });
  },

  /** chat.delete：真删 chat（CP8 仅会话列表 ✕ deleteSession 调用；主 chat 后端级联删子 chat）。stage 隐藏走 store.hide，不调本方法。 */
  async destroyAgent(chatId: string): Promise<void> {
    await call("chat.delete", { chatId });
  },

  /**
   * chat.get：流式载入历史。返回 requestId；历史块（staged chunks, role=user/assistant/...）
   * 经 routeChunk 路由到对应 StreamState。CP1 骨架仅返回 requestId，CP4 接 HistoryDrawer 渲染。
   */
  getHistory(chatId: string): { requestId: string; done: Promise<RpcResponse> } {
    return callStream("chat.get", { chatId });
  },

  /** sense.approval：审批（accept/reject）。approvalId 来自 interrupt notification。 */
  async approval(approvalId: string, action: ApprovalAction): Promise<void> {
    await call("sense.approval", { approvalId, action });
  },

  /**
   * subagent.result：wait=true 时子 agent done 后回传结果，唤醒主 agent 挂起的 spawn_subagent sense。
   * 参数 {chatId(子), content}。后端返回 matched（false = 无挂起 spawn，非异常，前端幂等可调）。
   */
  async subagentResult(chatId: string, content: string): Promise<void> {
    await call("subagent.result", { chatId, content });
  },

  /**
   * brain.list：列出可用 brain + 当前已连 MCP server（AgentDialog 用）。
   * 后端 Agent 1 契约保证 brains[].contextLimit。返回形状容错（缺字段 → 空数组）。
   */
  async listBrains(): Promise<BrainListResponse> {
    const data = await call<Partial<BrainListResponse>>("brain.list", {});
    return {
      brains: Array.isArray(data?.brains) ? data.brains : [],
      mcpServers: Array.isArray(data?.mcpServers) ? data.mcpServers : [],
    };
  },

  /** config.get：读 .chery/config.yaml 原文（除 server 段），供设置面板编辑。supervision 为字符串、key 仍为 $ENV 占位符。 */
  async getConfig(): Promise<ConfigDto> {
    return call<ConfigDto>("config.get", {});
  },

  /**
   * config.save：校验（brain 引用/supervision 合法/`:level` 合法/必填）+ 写回（保留 server 段、无注释）。
   * 不碰内存单例，重启生效。校验失败 throw（error.message 含全部错误，设置面板红框展示）。
   */
  async saveConfig(payload: ConfigDto): Promise<{ needRestart: true }> {
    return call<{ needRestart: true }>("config.save", payload);
  },

  /**
   * sense.tools：列出代码维护的全部内置工具（name/label/description），供设置面板感官分组下拉建议。
   * 仅内置；自定义/外部/MCP 工具不在内，靠组合框自由输入。返回形状容错（缺字段 -> 空数组）。
   */
  async listSenseTools(): Promise<SenseToolInfo[]> {
    const data = await call<Partial<{ tools: SenseToolInfo[] }>>("sense.tools", {});
    return Array.isArray(data?.tools) ? data.tools : [];
  },
};

/**
 * /api/config 全量配置缓存（default + senseGroups）。
 * 幂等：首次 fetch 后缓存；失败时清缓存置 null（下次仍 fetch 重试），错误显式抛出由调用方处理（规则 12）。
 * fetchDefaultRuntime（FAB default）+ AgentDialog（senseGroups）共享同一缓存，避免重复 fetch。
 */
let serverConfigCache: ConfigDefault | null | undefined;

export async function fetchServerConfig(): Promise<ConfigDefault> {
  if (serverConfigCache !== undefined) return serverConfigCache;
  try {
    const res = await fetch("/api/config");
    if (!res.ok) throw new Error(`/api/config ${res.status}`);
    serverConfigCache = (await res.json()) as ConfigDefault;
    return serverConfigCache;
  } catch (e) {
    // 失败置 null（区分"未 fetch"与"fetch 成功但无 default"），下次不再重试
    serverConfigCache = null;
    throw e;
  }
}

/**
 * /api/config default 缓存（FAB 创建主 pet 用）。委托 fetchServerConfig 复用同一缓存。
 * 后端若尚未合并 default 字段 → 返回 null（AgentFab 兜底）。
 */
export async function fetchDefaultRuntime(): Promise<RuntimeSelection | null> {
  const cfg = await fetchServerConfig();
  return cfg.default ?? null;
}
