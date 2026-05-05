import dotenv from "dotenv";
import yaml from "js-yaml";
import fs from "fs";
import path from "path";

dotenv.config();


/**
 * Tool 监管等级枚举
 * - auto: 自动执行，无需确认
 * - confirm: 需用户确认后执行
 * - manual: 禁止自动执行，仅手动触发
 */
export enum SupervisionLevel {
  auto = 0,
  confirm = 1,
  manual = 2,
}

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
  /** 使用哪个tool group */
  tool_group?: string;
}

interface LLMConfig {
  clients: Record<string, ClientConfig>;
}

/**
 * Tool Group 配置
 */
interface ToolGroupConfig {
  auto_execute_level: keyof typeof SupervisionLevel; // 允许自动执行的监管等级
  tools: string[]; // 包含的tool名称列表
}

/**
 * 全局配置
 */
interface GlobalConfig {
  thinking: boolean; // 是否开启思考模式（如果能思考）
  supervision: keyof typeof SupervisionLevel; // 全局默认的监管等级
  stream: boolean; // 是否开启流式输出
}

interface Config {
  global: GlobalConfig;
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
  const configPath = path.join(process.cwd(), "config.yaml");

  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  const configFile = fs.readFileSync(configPath, "utf8");
  const rawConfig = yaml.load(configFile) as Config;

  const config = replaceEnvVars(rawConfig) as Config;

  if (missingEnvVars.length > 0) {
    console.warn(`⚠️ 环境变量未配置: ${missingEnvVars.join(", ")}`);
  }

  return config;
}

const config = loadConfig();
console.log(JSON.stringify(config));

export type { Config, LLMConfig, ClientConfig, ToolGroupConfig, GlobalConfig };
export default config;
