import dotenv from "dotenv";
import yaml from "js-yaml";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { SupervisionLevel } from "@/core/config";

// ESM 模块中获取 __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 优先加载 dist/.env（生产环境），否则加载根目录 .env（开发环境）
const distEnvPath = path.join(__dirname, ".env");
if (fs.existsSync(distEnvPath)) {
  dotenv.config({ path: distEnvPath });
} else {
  dotenv.config();
}

// 从 core 层重新导出 SupervisionLevel
export { SupervisionLevel } from "@/core/config";

/**
 * LLM Client 配置基础类型
 * 各 Provider 可扩展具体配置结构
 */
interface ClientConfig {
  url: string;
  model: string;
  key?: string;
  /** 表示这个模型有没有思考能力 */
  thinking?: boolean;
  /** 表示这个大模型用什么适配的解析器 @/provider/xxx */
  provider: string;
  /** 使用哪个tool group（支持单个或多个工具组） */
  tool_group?: string | string[];
}

interface LLMConfig {
  clients: Record<string, ClientConfig>;
}

/**
 * Tool Group 配置
 */
interface ToolGroupConfig {
  tools: string[]; // 包含的tool名称列表
  supervision?: SupervisionLevel; // 组级别监管等级，设置后强制覆盖组内所有工具自身声明
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
 * 全局配置
 */
interface GlobalConfig {
  thinking: boolean; // 是否开启思考模式（如果能思考）
  supervision: SupervisionLevel; // 全局默认的监管等级
  stream: boolean; // 是否开启流式输出
  tool_execute_timeout?: number; // 工具执行超时时间（毫秒）
  maxLoopCount?: number; // loop 最大执行次数（默认 30）
  bash_log_retention_hours?: number; // bash 日志文件保留时间（小时）
  file_compression?: FileCompressionConfig; // 文件压缩配置
}

/**
 * 扩展全局配置（包含自动补全的路径）
 */
interface ExtendedGlobalConfig extends GlobalConfig {
  skills_dir: string; // 自动补全：chery_dir + "/.chery/skills"
  tools_dir: string; // 自动补全：chery_dir + "/.chery/tools"
  system_prompt: string; // 自动补全：chery_dir + "/.chery/system.md"
}

interface Config {
  global: ExtendedGlobalConfig;
  llm: LLMConfig;
  tool_groups?: Record<string, ToolGroupConfig>; // tool分组配置
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
  // 从 .chery/config.yaml 读取配置（运行时配置，不走打包）
  const configPath = path.join(process.cwd(), ".chery", "config.yaml");

  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
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

  // tool_groups 内的 supervision 同样转枚举
  if (config.tool_groups) {
    for (const group of Object.values(config.tool_groups)) {
      if (typeof group.supervision === "string") {
        group.supervision = SupervisionLevel[
          group.supervision as keyof typeof SupervisionLevel
        ];
      }
    }
  }

  // 自动补全 .chery 目录路径（从环境变量读取，默认 process.cwd()）
  const cheryDir = process.env.CHERY_DIR || process.cwd();
  config.global.skills_dir = path.join(cheryDir, ".chery", "skills");
  config.global.tools_dir = path.join(cheryDir, ".chery", "tools");
  config.global.system_prompt = path.join(cheryDir, ".chery", "system.md");

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
// console.log(JSON.stringify(config));

export type { Config, LLMConfig, ClientConfig, ToolGroupConfig, GlobalConfig, ExtendedGlobalConfig, FileCompressionConfig };
export default config;
