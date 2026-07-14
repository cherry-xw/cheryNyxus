/**
 * agentApi：基于 wsClient.rpc / rpcTrack 的高层 RPC 封装。
 * CP1 骨架：方法签名定好，错误抛出由调用方（agents store）处理。
 * 流式方法（sendMessage/getHistory）暴露 requestId 供 chunk 路由。
 *
 * 协议见 docs/protocol.md。方法：chat.* / runtime.set / sense.approval / brain.list。
 */
import { wsClient } from "./ws";
import type { RpcResponse } from "./ws";
import { httpUrl } from "./http";

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
  /** 仅 includePreview=true 返：上下文 token 用量比例（0-1）。SessionList 渲染用。 */
  contextUsage?: number;
  /** 仅 includePreview=true 返：已用 token 数（估算值）。配合 contextTotal 显示详情。 */
  contextUsed?: number;
  /** 仅 includePreview=true 返：上下文上限 token 数。 */
  contextTotal?: number;
  /** 子 agent 是否已完成（后端 metadata.finished）。前端据 finished===true 重建子 pet 为 ghost。主 chat 恒 undefined。 */
  finished?: boolean;
  /** chat 当前是否正在运行（后端 chatRuntimes.get(chatId)?.builder.isRunning()）。前端据此判断子 agent 是否还活着、主 chat 是否卡死。 */
  running?: boolean;
  /** 子 chat 是否被主 wait（后端 metadata.wait=true，T9.10）。前端重连识别 wait-子：续跑 interrupted 子 + 主含未处理 role-reply 时 resume。主 chat 恒 undefined。 */
  wait?: boolean;
  /** 主 chat 有已持久化但尚未恢复处理的角色回复；断线重连时应调用 chat.resume。 */
  resumePending?: boolean;
  /** 主 chat 末条非 revoked 消息为未完成周期（sense/user/role/subagent）；idle 时前端可自动 resume。覆盖 resumePending 丢失场景。 */
  canResume?: boolean;
  /** 主 chat 创建时所选预设；用于恢复小组角色临时配置面板。 */
  preset?: string;
}

/** chat.create 参数。预设路径（T6）：preset 给出则后端从预设解析编制，brain/senseGroup 可省；
 * 显式路径：主 agent brain + senseGroup（+ mcpServers?）；子 agent：额外 parentChatId。 */
export interface CreateAgentOptions {
  /** 预设名（T6）：给出则后端从 config.presets[preset].main 解析编制快照，忽略 brain/senseGroup */
  preset?: string;
  brain?: string;
  senseGroup?: string;
  mcpServers?: string[];
  /** 可选，未给则后端生成 */
  chatId?: string;
  /** 子 agent 关联主 chat（CP3 子 agent 用） */
  parentChatId?: string;
}

/** chat.create 响应：chatId + 实际生效的编制（预设路径由后端解析回填，供前端记 pet.runtime）。 */
export interface CreateAgentResult {
  chatId: string;
  brain: string;
  senseGroup: string;
  mcpServers: string[];
}

/** runtime.set 选择（每轮可换 brain + 单一工具组）。 */
export interface RuntimeSelection {
  brain: string;
  /** 无 Tool Call 模型使用空字符串。 */
  senseGroup: string;
  mcpServers?: string[];
}

/** 当前会话临时角色编制；服务重启后自动失效，不写入会话默认配置。 */
export interface SessionRuntimeSelection {
  primary: RuntimeSelection;
  roles: Record<string, RuntimeSelection>;
}

export type ApprovalAction = "accept" | "reject";

/**
 * brain.list 单条 brain 信息（对齐后端 Agent 1 契约）。
 * contextLimit（token）用于 ContextBar 显示用量。
 */
export interface BrainInfo {
  name: string;
  contextLimit: number;
  /** 是否为 config.default.brain（AgentDialog 无 runtime 时预选） */
  default?: boolean;
  capabilities?: BrainCapabilitiesDto;
  [k: string]: unknown;
}

export interface MediaCapabilitiesDto { image?: boolean; video?: boolean; audio?: boolean; }
export interface BrainCapabilitiesDto {
  toolCall?: boolean;
  input?: MediaCapabilitiesDto;
  generate?: MediaCapabilitiesDto;
}

/** brain.list 响应形状。 */
export interface BrainListResponse {
  brains: BrainInfo[];
  mcpServers: string[];
}

/** sense.tools 响应单项：内置工具元信息（name=原名/key，label=中文名/显示，description=解释/tooltip，icon=glyph/emoji 供 pet bar 运行中工具显示）。 */
export interface SenseToolInfo {
  name: string;
  label: string;
  description: string;
  icon: string;
}

/** /api/config 返回形状（FAB default + AgentDialog senseGroups 全名单 + default 标记，后端 Agent B 暴露）。 */
export interface SenseGroupOption {
  name: string;
  /** 是否在 config.default.senseGroups 内（AgentDialog 无 runtime 时预选） */
  default: boolean;
}

/** /api/config 暴露的预设项（T6，FAB 预设选择用）。 */
export interface PresetOption {
  name: string;
  /** 组长角色名（leader） */
  leader: string;
  /** leader 角色的 brain（默认 brain，每轮可覆盖） */
  brain: string;
  /** 角色类型键（能力体现） */
  roles: string[];
}

export interface ConfigDefault {
  /** 派生自「默认」预设 leader 角色（AgentDialog 无 runtime 时预选用；FAB 不再用） */
  default?: RuntimeSelection;
  /** 可用 senseGroups 全名单 + default 标记（= 是否在「默认」预设 main.senseGroups 内；缺省回退 [{name:"default", default:true}]） */
  senseGroups?: SenseGroupOption[];
  /** 可用预设名单（T6 FAB 预设选择用；缺省 = 无预设） */
  presets?: PresetOption[];
  sessionToken?: string;
}

export interface UploadedMediaAsset { id: string; kind: "image" | "video" | "audio"; mimeType: string; filename: string; size: number; url: string; }

/** P4：chat.send 结构化附件（与后端 ChatSendAttachment 对齐）。assetId=UploadedMediaAsset.id。 */
export interface ChatSendAttachment {
  assetId: string;
  kind: "image" | "video" | "audio";
  mimeType: string;
}

/** 思考强度档位（对齐后端 ThinkingLevel）：off=关闭，low/medium/high=强度递增。 */
export type ThinkingLevel = "off" | "low" | "medium" | "high";

/** config.get 响应 / config.save 入参：.chery/config.yaml 原文（除 server 段）。对齐后端 ConfigRaw。 */
export interface BrainConfigDto {
  url?: string;
  model: string;
  key?: string;
  thinking?: ThinkingLevel;
  provider: string;
  rpm?: number;
  mock?: { enabled?: boolean; file: string };
  contextLimit?: number;
  capabilities?: BrainCapabilitiesDto;
}

/** 编辑器信息（对齐后端 UtilsEditorsResponseData.editors[]） */
export interface EditorInfo {
  /** 显示名称（如 "Visual Studio Code"） */
  name: string;
  /** 启动命令（如 "code"、"notepad"、"gedit"） */
  command: string;
  /** 是否在系统 PATH 中可用 */
  available: boolean;
}

export interface McpServerConfigDto {
  transport: "stdio" | "streamable-http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  supervision?: "auto" | "confirm" | "manual";
}

export type MediaKindDto = "image" | "video" | "audio";
export interface MediaServiceConfigDto { type: MediaKindDto; url: string; model?: string; key?: string; enabled?: boolean; maxUploadMb?: number; }
export interface MediaConfigDto { [name: string]: MediaServiceConfigDto; }

export interface GlobalConfigDto {
  thinking: boolean;
  supervision: "auto" | "confirm" | "manual";
  stream: boolean;
  sense_execute_timeout?: number;
  approval_timeout?: number;
  maxLoopCount?: number;
  bash_log_retention_hours?: number;
  textEditor?: string; // 文本编辑器路径
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

/** 预设（对齐后端 PresetConfig）：选中的角色 type 列表（引用 config.roles 单一源）+ 指定组长 + 按类型媒体服务 */
export interface PresetDto {
  /** 组长角色 type 名（必填，主 pet 编制取 config.roles[leader]） */
  leader: string;
  /** 选中的角色 type 名 */
  roles?: string[];
  /** 按类型引用媒体服务名（引用 config.media 已定义的服务，类型须匹配） */
  mediaImage?: string;
  mediaVideo?: string;
  mediaAudio?: string;
}

export interface ConfigDto {
  global: GlobalConfigDto;
  llm: { brain: Record<string, BrainConfigDto> };
  media?: MediaConfigDto;
  sense_groups?: Record<string, string[]>;
  mcp_servers?: Record<string, McpServerConfigDto>;
  roles?: Record<string, { brain: string; senseGroup: string; mcpServers?: string[]; systemPrompt?: string }>;
  presets?: Record<string, PresetDto>;
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

  /** chat.create：创建 chat。返回 chatId + 实际生效编制（预设路径由后端回填，供记 pet.runtime）。 */
  async createAgent(opts: CreateAgentOptions): Promise<CreateAgentResult> {
    const data = await call<{ chatId?: string; brain?: string; senseGroup?: string; mcpServers?: string[] }>("chat.create", {
      ...(opts.preset ? { preset: opts.preset } : {}),
      ...(opts.brain !== undefined ? { brain: opts.brain } : {}),
      ...(opts.senseGroup !== undefined ? { senseGroup: opts.senseGroup } : {}),
      mcpServers: opts.mcpServers ?? [],
      chatId: opts.chatId,
      parentChatId: opts.parentChatId,
    });
    if (!data?.chatId || !data.brain) {
      throw new Error("chat.create: missing chatId/brain/senseGroup in response");
    }
    return { chatId: data.chatId, brain: data.brain, senseGroup: data.senseGroup ?? "", mcpServers: data.mcpServers ?? [] };
  },

  /**
   * chat.send：流式发消息。返回 requestId（agents store 记录 requestId→chatId 供 routeChunk）。
   * done 在流式结束 resolve；CP1 可不 await（chunk 路由独立）。
   * P4：可选 attachments 参数，结构化附件（替代旧 [[media:]] 文本标记）。
   *   服务端据 assetId + mimeType 合成 [[media:<filename>]] 标记追加到 prompt，
   *   兼容既有 enrichMediaInputs 流程。前端 AgentDialog 把 MediaAttachment[] 传过来即可。
   */
  sendMessage(chatId: string, text: string, attachments?: ChatSendAttachment[]): { requestId: string; done: Promise<RpcResponse> } {
    return callStream("chat.send", {
      chatId,
      prompt: text,
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    });
  },

  /**
   * chat.resume：流式续跑（无 prompt，run("") 起流）。T9 wait=true 唤醒轮用：
   * 后端注入角色回复后推 role_reply → 前端调本方法 resume 主处理注入消息。
   * 也用于重连续跑 interrupted wait-子。返回 requestId 供 chunk 路由。
   */
  resumeChat(chatId: string): { requestId: string; done: Promise<RpcResponse> } {
    return callStream("chat.resume", { chatId });
  },

  /** runtime.set：原子设置 chat 的 brain + 工具组 + mcpServers。 */
  async setRuntime(chatId: string, selection: RuntimeSelection): Promise<void> {
    await call("runtime.set", {
      chatId,
      brain: selection.brain,
      senseGroup: selection.senseGroup,
      mcpServers: selection.mcpServers ?? [],
    });
  },

  /** session.runtime.set：临时设置主角色和小组角色编制，不持久化。 */
  async setSessionRuntime(chatId: string, selection: SessionRuntimeSelection): Promise<void> {
    await call("session.runtime.set", { chatId, ...selection });
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

  /** chat.contextUsage：轻量取上下文用量详情（比例 + 已用 token + 上限）。initFromChats 后驱动 ContextBar 初始渲染。 */
  async contextUsage(chatId: string): Promise<{ chatId: string; contextUsage: number; contextUsed: number; contextTotal: number }> {
    return call<{ chatId: string; contextUsage: number; contextUsed: number; contextTotal: number }>("chat.contextUsage", { chatId });
  },

  /** sense.approval：审批（accept/reject）。approvalId 来自 interrupt notification。 */
  async approval(approvalId: string, action: ApprovalAction): Promise<void> {
    await call("sense.approval", { approvalId, action });
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
   * sense.tools：列出代码维护的全部内置工具（name/label/description/icon），供设置面板感官分组下拉建议 + pet bar 运行中工具 icon 查询。
   * 仅内置；自定义/外部/MCP 工具不在内，靠组合框自由输入。返回形状容错（缺字段 -> 空数组）。
   */
  async listSenseTools(): Promise<SenseToolInfo[]> {
    const data = await call<Partial<{ tools: SenseToolInfo[] }>>("sense.tools", {});
    return Array.isArray(data?.tools) ? data.tools : [];
  },

  /**
   * sense.list：列出 config.sense_groups 全部组及其 sense 名（group→senses 解析）。
   * 供前端「能力判定」——pet 的 senseGroups（组名）经此解析为 sense 名集合，判断是否含某工具（如 update_todo）。
   * 返回形状容错（缺字段 -> 空数组）。
   */
  async listSenseGroups(): Promise<{ name: string; senses: string[] }[]> {
    const data = await call<Partial<{ senseGroups?: { name: string; senses: string[] }[] }>>("sense.list", {});
    return Array.isArray(data?.senseGroups) ? data.senseGroups : [];
  },

  /**
   * prompts.list：递归列出 .chery/prompts/ 下全部 .md（含子文件夹），每项为相对 .chery/ 的路径
   * （如 prompts/prefebMain/leader.md）。供设置面板 systemPrompt 级联选择器（el-cascader）建目录树。
   * 返回形状容错（缺字段 -> 空数组）。
   */
  async listPrompts(): Promise<string[]> {
    const data = await call<Partial<{ prompts?: string[] }>>("prompts.list", {});
    return Array.isArray(data?.prompts) ? data.prompts : [];
  },
  async uploadMedia(file: File): Promise<UploadedMediaAsset> {
    const server = await fetchServerConfig();
    const response = await fetch(httpUrl("/api/media/upload"), {
      method: "POST",
      headers: { "Content-Type": file.type, "X-Filename": file.name, ...(server.sessionToken ? { "X-Chery-Session-Token": server.sessionToken } : {}) },
      body: file,
    });
    if (!response.ok) throw new Error(`媒体上传失败: ${response.status}`);
    return await response.json() as UploadedMediaAsset;
  },

  /** utils.models：基于 provider/url/key 拉取可用模型列表。 */
  async fetchModels(provider: string, url: string, key?: string): Promise<{ models: Array<{ id: string; name?: string }>; error?: string }> {
    return await call<{ models: Array<{ id: string; name?: string }>; error?: string }>("utils.models", { provider, url, key });
  },

  /** env.list：读取 .env 文件中的变量名列表（供密钥下拉选择）。 */
  async listEnvVars(): Promise<string[]> {
    const data = await call<{ vars: string[] }>("env.list", {});
    return data?.vars ?? [];
  },

  /** utils.openFile：打开指定文件（用配置的编辑器或系统默认）。 */
  async openFile(path: string): Promise<void> {
    await call("utils.openFile", { path });
  },

  /** utils.openConfigDir：打开后端主机的 .chery 配置目录。 */
  async openConfigDir(): Promise<void> {
    await call("utils.openConfigDir", {});
  },

  /** utils.editors：获取系统可用的文本编辑器列表（供前端下拉选择）。 */
  async listEditors(): Promise<EditorInfo[]> {
    const data = await call<{ editors: EditorInfo[] }>("utils.editors", {});
    return data?.editors ?? [];
  },
};

/**
 * /api/config 全量配置缓存（default + senseGroups + presets）。
 * 幂等：首次 fetch 后缓存；失败时清缓存置 null（下次仍 fetch 重试），错误显式抛出由调用方处理（规则 12）。
 * AgentFab（presets）+ AgentDialog（senseGroups/default）共享同一缓存，避免重复 fetch。
 */
let serverConfigCache: ConfigDefault | null | undefined;

export async function fetchServerConfig(): Promise<ConfigDefault> {
  if (serverConfigCache) return serverConfigCache;
  try {
    const res = await fetch(httpUrl("/api/config"));
    if (!res.ok) throw new Error(`/api/config ${res.status}`);
    serverConfigCache = (await res.json()) as ConfigDefault;
    return serverConfigCache as ConfigDefault;
  } catch (e) {
    // 失败置 null（区分"未 fetch"与"fetch 成功但无 default"），下次不再重试
    serverConfigCache = null;
    throw e;
  }
}
