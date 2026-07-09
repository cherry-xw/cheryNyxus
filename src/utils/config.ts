import dotenv from "dotenv";
import yaml from "js-yaml";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { SupervisionLevel } from "@/core/config";

// ESM 模块中获取 __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 根目录 .env（从 src/utils/ 向上两级）
// tsx 运行时: __dirname = src/utils/ → rootEnvPath = src/../.env = 项目根
const rootEnvPath = path.join(__dirname, "..", "..", ".env");
if (fs.existsSync(rootEnvPath)) {
  dotenv.config({ path: rootEnvPath });
} else {
  // 回退到 dist/.env（生产环境）
  dotenv.config({ path: path.join(__dirname, ".env") });
}

// 从 core 层重新导出 SupervisionLevel
export { SupervisionLevel } from "@/core/config";

/**
 * mock provider 脚本项（单次 LLM 调用的预定响应）
 * 用于离线测试 send/resume/revoke/loop 流程，不接真实 LLM。
 */
export interface MockScriptResponse {
  /** 思考增量 */
  thinking?: string;
  /** 正文增量 */
  content?: string;
  /** 工具调用（监管等级由 sense_groups 的 :level 决定，非脚本） */
  senseCalls?: { id?: string; name: string; arguments: string }[];
  /** 抛错（测 retry 中间件） */
  error?: string;
}

/**
 * mock 配置（brain 内）：只保留开关 + 脚本文件路径。
 * 脚本内容（repeat + script[]）放独立文件，避免 config.yaml 过长。
 */
interface MockConfig {
  /** 开关：是否启用 mock（缺省 true） */
  enabled?: boolean;
  /** 脚本文件路径，相对 .chery 目录（如 mock/read_file.yaml） */
  file: string;
}

/**
 * Brain 配置基础类型
 * 各 Provider 可扩展具体配置结构
 */
interface BrainConfig {
  url?: string;
  model: string;
  key?: string;
  /** 表示这个模型有没有思考能力 */
  thinking?: boolean;
  /** 表示这个大模型用什么适配的解析器 @/provider/xxx */
  provider: string;
  /** 每分钟最大请求数（RPM）限额，provider 层滑动窗口限流，未配置则不限流 */
  rpm?: number;
  /** mock provider 专用：脚本化响应 */
  mock?: MockConfig;
  /** 上下文长度上限（token），供前端 context bar 显示用量。缺省由前端兜底 */
  contextLimit?: number;
}

interface LLMConfig {
  brain: Record<string, BrainConfig>;
}

/**
 * 默认 agent 配置（FAB 创建主 pet 用，主从 Agent 桌宠系统 CP2）。
 * brain/senseGroups/mcpServers 与 chat.create/runtime.set 同字段语义。
 */
export interface DefaultAgentConfig {
  brain: string;
  senseGroups: string[];
  /** 缺省 []（关闭所有 MCP） */
  mcpServers?: string[];
}

/**
 * 子 agent 类型配置（spawn_subagent sense 按 type 查这里）。
 * 名 = 给 AI 的子 agent 名；brain 必须存在于 llm.brain（loadConfig 校验）。
 */
export interface SubagentConfig {
  brain: string;
  senseGroups: string[];
}

/**
 * 文件压缩配置
 */
interface FileCompressionConfig {
  truncate_threshold?: number; // 截断阈值（字节），默认150KB
  truncate_preview_lines?: number; // 截断保留行数，默认100行
  log_file_extensions?: string[]; // 日志文件扩展名列表
  drain_preview_count?: number; // Drain模板实例数，默认3
}

/**
 * 日志配置
 */
interface LoggerConfig {
  level?: "debug" | "info" | "warn" | "error" | "silent"; // 日志等级
  output?: ("console" | "file")[]; // 输出位置数组
  timestamp?: boolean; // 是否显示时间戳
  location?: boolean; // 是否显示调用位置
  format?: "plain" | "json"; // 输出格式
}

/**
 * 全局配置
 */
interface GlobalConfig {
  thinking: boolean; // 是否开启思考模式（如果能思考）
  supervision: SupervisionLevel; // 全局默认的监管等级
  stream: boolean; // 是否开启流式输出
  sense_execute_timeout?: number; // 感官执行超时时间（毫秒）
  approval_timeout?: number; // 审批超时时间（毫秒），超时视为拒绝（非 abort）
  maxLoopCount?: number; // loop 最大执行次数（默认 30）
  bash_log_retention_hours?: number; // bash 日志文件保留时间（小时）
  file_compression?: FileCompressionConfig; // 文件压缩配置
  logger?: LoggerConfig; // 日志配置
}

/**
 * 服务配置（端口 + 传输格式，从环境变量迁移至此）
 */
interface ServerConfig {
  port: number; // WebSocket 服务端口
  transport: "binary" | "json"; // 传输格式：binary（二进制帧）/ json（JSON 字符串）
}

/**
 * MCP server 单项配置
 * transport=stdio 时用 command/args/env 启动子进程；transport=streamable-http 时用 url 连接远程 server。
 * supervision 为 server 级默认监管等级（覆盖 global.supervision），可被 sense_groups 的 :level 进一步覆盖。
 */
interface McpServerConfig {
  transport: "stdio" | "streamable-http";
  command?: string; // stdio：可执行文件
  args?: string[]; // stdio：命令行参数
  env?: Record<string, string>; // stdio：子进程环境变量（$ENV 占位符由 replaceEnvVars 注入）
  url?: string; // streamable-http：server URL
  supervision?: SupervisionLevel; // server 级默认监管等级（loadConfig 把字符串转枚举）
}

/**
 * 扩展全局配置（包含自动补全的路径）
 */
interface ExtendedGlobalConfig extends GlobalConfig {
  skills_dir: string; // 自动补全：chery_dir + "/.chery/skills"
  senses_dir: string; // 自动补全：chery_dir + "/.chery/senses"
  system_prompt: string; // 自动补全：chery_dir + "/.chery/system.md"
  db_dir: string; // 自动补全：chery_dir + "/db"
}

interface Config {
  global: ExtendedGlobalConfig;
  llm: LLMConfig;
  sense_groups?: Record<string, string[]>; // sense分组配置
  mcp_servers?: Record<string, McpServerConfig>; // MCP server 配置（name → 连接参数 + server 级监管默认）
  server: ServerConfig; // 服务配置（端口 + 传输格式，loadConfig 兜底默认值）
  /** 默认主 agent 配置（FAB 创建主 pet 用）。缺省时前端走自带兜底 */
  default?: DefaultAgentConfig;
  /** 子 agent 类型模块（spawn_subagent sense 按 type 查） */
  subagents?: Record<string, SubagentConfig>;
}

/**
 * 原始（磁盘/YAML）全局配置：supervision 为字符串（未转枚举）、无路径补全。
 * 供 config.get/config.save RPC 传输与编辑。
 */
interface GlobalConfigRaw extends Omit<GlobalConfig, "supervision"> {
  supervision: "auto" | "confirm" | "manual";
}

/** 原始 MCP server 配置：supervision 为字符串（未转枚举） */
interface McpServerConfigRaw extends Omit<McpServerConfig, "supervision"> {
  supervision?: "auto" | "confirm" | "manual";
}

/**
 * 原始配置（config.get 返回 / config.save 入参）：无 server 段、无路径补全、
 * supervision 为字符串、key 仍为 $ENV 占位符。读写均不碰运行时内存单例（重启生效）。
 */
interface ConfigRaw {
  global: GlobalConfigRaw;
  llm: LLMConfig;
  sense_groups?: Record<string, string[]>;
  mcp_servers?: Record<string, McpServerConfigRaw>;
  default?: DefaultAgentConfig;
  subagents?: Record<string, SubagentConfig>;
}

const missingEnvVars: string[] = [];

function replaceEnvVars(value: unknown): unknown {
  if (typeof value === "string") {
    const envVarMatch = value.match(/^\$([A-Z_][A-Z0-9_]*)$/);
    if (envVarMatch && envVarMatch[1]) {
      const envVarName = envVarMatch[1];
      const envValue = process.env[envVarName];
      if (!envValue) {
        missingEnvVars.push(envVarName);
        return value; // 原样返回
      }
      return envValue;
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(replaceEnvVars);
  }

  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = replaceEnvVars(val);
    }
    return result;
  }

  return value;
}

function loadConfig(): Config {
  // .chery 目录路径（从环境变量读取，默认 process.cwd()）
  const cheryDir = process.env.CHERY_DIR || process.cwd();

  // 从 .chery/config.yaml 读取配置（运行时配置，不走打包）
  const configPath = path.join(cheryDir, ".chery", "config.yaml");

  if (!fs.existsSync(configPath)) {
    console.error(`✗ 配置文件不存在: ${configPath}`);
    console.error(`  请确认 CHERY_DIR 环境变量指向正确的项目根目录（当前: ${cheryDir}）`);
    process.exit(1);
  }

  const configFile = fs.readFileSync(configPath, "utf8");
  const rawConfig = yaml.load(configFile) as Config;

  const config = replaceEnvVars(rawConfig) as Config;

  // 业务校验（raw 形态：supervision 仍为字符串）。启动期 fail loud（规则12）。
  // brain 引用 / supervision 合法值 / sense :level / brain 必填项均在此（原内联块抽出共用）。
  const rawErrors = validateRawConfig(config as unknown as ConfigRaw);
  if (rawErrors.length > 0) {
    throw new Error(`配置校验失败:\n${rawErrors.join("\n")}`);
  }

  // 将字符串转换为枚举（校验已保证 supervision 为合法值）
  if (typeof config.global.supervision === "string") {
    config.global.supervision = SupervisionLevel[
      config.global.supervision as keyof typeof SupervisionLevel
    ];
  }

  // MCP servers supervision 字符串转枚举（同 global.supervision 模式）
  if (config.mcp_servers) {
    for (const serverCfg of Object.values(config.mcp_servers)) {
      if (typeof serverCfg.supervision === "string") {
        serverCfg.supervision =
          SupervisionLevel[serverCfg.supervision as keyof typeof SupervisionLevel];
      }
    }
  }

  // 自动补全 .chery 目录路径
  config.global.skills_dir = path.join(cheryDir, ".chery", "skills");
  config.global.senses_dir = path.join(cheryDir, ".chery", "senses");
  config.global.system_prompt = path.join(cheryDir, ".chery", "system.md");
  config.global.db_dir = process.env.DB_DIR ?? path.join(cheryDir, ".chery", "db");

  // 服务配置默认值兜底（端口 + 传输格式；web_port 已废弃，HTTP 端口改 WEB_PORT 环境变量）
  const serverRaw = config.server as Partial<ServerConfig> | undefined;
  config.server = {
    port: serverRaw?.port ?? 8182,
    transport: serverRaw?.transport === "json" ? "json" : "binary",
  };

  // 添加环境变量缺失警告
  if (!process.env.CHERY_DIR) {
    console.warn(`⚠️ 环境变量 CHERY_DIR 未配置，使用默认路径: ${cheryDir}`);
  }

  if (missingEnvVars.length > 0) {
    console.warn(`⚠️ 环境变量未配置: ${missingEnvVars.join(", ")}`);
  }

  return config;
}

const config = loadConfig();

/**
 * 重读 .chery/config.yaml 的 mcp_servers 段，跑 replaceEnvVars + supervision 解析，
 * 原地替换 config.mcp_servers。供 mcp.reload 在运行期拾取配置变更。
 *
 * 作用域：仅 mcp_servers。其他配置段（global/sense_groups/llm）不重读——
 * 全量配置热更属另一特性。
 *
 * 安全性：仅 core/mcp/loader 读取 config.mcp_servers（已确认），替换引用不影响其他模块。
 */
export function reloadMcpServersConfig(): Record<string, McpServerConfig> | undefined {
  const cheryDir = process.env.CHERY_DIR || process.cwd();
  const configPath = path.join(cheryDir, ".chery", "config.yaml");
  if (!fs.existsSync(configPath)) return config.mcp_servers;

  const raw = yaml.load(fs.readFileSync(configPath, "utf8")) as {
    mcp_servers?: Record<string, McpServerConfig>;
  };
  const rawServers = raw.mcp_servers;
  if (!rawServers) {
    config.mcp_servers = undefined;
    return undefined;
  }

  const replaced = replaceEnvVars(rawServers) as Record<string, McpServerConfig>;
  for (const serverCfg of Object.values(replaced)) {
    if (typeof serverCfg.supervision === "string") {
      serverCfg.supervision =
        SupervisionLevel[serverCfg.supervision as keyof typeof SupervisionLevel];
    }
  }

  config.mcp_servers = replaced;
  return replaced;
}

const VALID_SUPERVISION = ["auto", "confirm", "manual"] as const;
type SupervisionName = (typeof VALID_SUPERVISION)[number];

function isSupervisionName(v: unknown): v is SupervisionName {
  return v === "auto" || v === "confirm" || v === "manual";
}

/**
 * 业务校验原始配置（raw 形态：supervision 为字符串、未补全路径、key 仍为 $ENV）。
 * 返回错误字符串数组（空 = 通过）。loadConfig 启动期与 config.save RPC 共用。
 *
 * 修复点：原 loadConfig 用 SupervisionLevel[name] 转换，非法字符串静默变 undefined；
 * 本函数显式校验 supervision 合法值，fail loud（规则12）。
 */
export function validateRawConfig(raw: ConfigRaw): string[] {
  const errors: string[] = [];

  // supervision 合法值（global + mcp_servers）
  const gsup = raw.global?.supervision;
  if (!isSupervisionName(gsup)) {
    errors.push(`global.supervision "${String(gsup)}" 非法（合法：auto/confirm/manual）`);
  }
  if (raw.mcp_servers) {
    for (const [name, cfg] of Object.entries(raw.mcp_servers)) {
      const sup = cfg?.supervision;
      if (sup !== undefined && !isSupervisionName(sup)) {
        errors.push(`mcp_servers.${name}.supervision "${String(sup)}" 非法（合法：auto/confirm/manual）`);
      }
    }
  }

  // sense_groups 的 :level 后缀合法
  if (raw.sense_groups) {
    for (const [group, senses] of Object.entries(raw.sense_groups)) {
      for (const entry of senses ?? []) {
        const idx = entry.indexOf(":");
        if (idx >= 0) {
          const level = entry.slice(idx + 1);
          if (!isSupervisionName(level)) {
            errors.push(`sense_groups.${group} 的 "${entry}" :level 后缀非法（合法：auto/confirm/manual）`);
          }
        }
      }
    }
  }

  // llm.brain.* model/provider 必填
  const brainEntries = Object.entries(raw.llm?.brain ?? {});
  if (brainEntries.length === 0) {
    errors.push("llm.brain 不能为空（至少配置一颗大脑）");
  }
  const brainNames = brainEntries.map(([n]) => n);
  for (const [name, cfg] of brainEntries) {
    if (!cfg?.model) errors.push(`llm.brain.${name}.model 必填`);
    if (!cfg?.provider) errors.push(`llm.brain.${name}.provider 必填`);
  }

  // default.brain / subagents.*.brain 必须存在于 llm.brain
  if (raw.default) {
    if (!brainNames.includes(raw.default.brain)) {
      errors.push(`default.brain "${raw.default.brain}" 不在 llm.brain 列表（可用：${brainNames.join(", ")})`);
    }
  }
  if (raw.subagents) {
    for (const [name, cfg] of Object.entries(raw.subagents)) {
      if (!brainNames.includes(cfg.brain)) {
        errors.push(`subagents.${name}.brain "${cfg.brain}" 不在 llm.brain 列表（可用：${brainNames.join(", ")})`);
      }
    }
  }

  return errors;
}

/**
 * 读 .chery/config.yaml 原文（供 config.get）。
 * 不 replaceEnvVars（key 保持 $ENV 占位符）、不补全路径、不转 supervision 枚举；剥离 server 段。
 */
export function readRawConfig(): ConfigRaw {
  const cheryDir = process.env.CHERY_DIR || process.cwd();
  const configPath = path.join(cheryDir, ".chery", "config.yaml");
  const raw = yaml.load(fs.readFileSync(configPath, "utf8")) as ConfigRaw & { server?: unknown };
  // 端口/传输不通过面板编辑，剥离 server
  const { server: _server, ...rest } = raw;
  void _server;
  return rest;
}

/**
 * 校验 + 写回 .chery/config.yaml（供 config.save）。
 * 不碰运行时内存单例（重启生效）。失败 fail loud 返回 errors，不写盘。
 * 写回保留盘上 server 段不动，js-yaml dump 无注释（注释文档备份在 config.yaml.example）。
 */
export function saveRawConfig(partial: ConfigRaw): { ok: true } | { ok: false; errors: string[] } {
  const errors = validateRawConfig(partial);
  if (errors.length > 0) return { ok: false, errors };

  const cheryDir = process.env.CHERY_DIR || process.cwd();
  const configPath = path.join(cheryDir, ".chery", "config.yaml");

  // 读盘取 server 段（保留不动），合并 partial（除 server 外全部字段）
  const disk = yaml.load(fs.readFileSync(configPath, "utf8")) as { server?: ServerConfig };
  const merged = { ...partial, server: disk.server ?? { port: 8182, transport: "binary" as const } };

  fs.writeFileSync(configPath, yaml.dump(merged, { lineWidth: -1 }));
  return { ok: true };
}

export type { Config, ConfigRaw, BrainConfig, GlobalConfig, LoggerConfig, McpServerConfig };
export default config;
