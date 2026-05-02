import dotenv from "dotenv";
import yaml from "js-yaml";
import fs from "fs";
import path from "path";
import { SupervisionLevel } from "@/llm/types";

dotenv.config();

type LLMProvider = {
  url: string;
  model: string;
  key?: string;
  thinking?: boolean;
  provider: string;
  tool_group?: string; // 使用哪个tool group
};

interface LLMConfig {
  clients: Record<string, LLMProvider>;
}

/**
 * Tool Group 配置
 */
interface ToolGroupConfig {
  auto_execute_level: keyof typeof SupervisionLevel; // 允许自动执行的监管等级
  tools: string[]; // 包含的tool名称列表
}

interface Config {
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

export type { Config, LLMConfig, LLMProvider, ToolGroupConfig };
export default config;
