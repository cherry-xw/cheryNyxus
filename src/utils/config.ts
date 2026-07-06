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
}

interface LLMConfig {
  brain: Record<string, BrainConfig>;
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
  web_port: number; // Web 前端服务端口（暂未使用，预留给后续 Vue 构建产物服务）
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

  // 将字符串转换为枚举
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

  // 服务配置默认值兜底（端口 + 传输格式，从环境变量迁移到 config.yaml）
  const serverRaw = config.server as Partial<ServerConfig> | undefined;
  config.server = {
    port: serverRaw?.port ?? 8182,
    web_port: serverRaw?.web_port ?? 8183,
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

export type { Config, BrainConfig, GlobalConfig, LoggerConfig, McpServerConfig };
export default config;
