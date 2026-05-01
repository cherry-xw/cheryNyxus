import dotenv from 'dotenv';
import yaml from 'js-yaml';
import fs from 'fs';
import path from 'path';

dotenv.config();

type LLMProvider = Record<string, string | undefined>;

interface LLMConfig {
  providers: {
    ollama: LLMProvider;
    openai: LLMProvider;
  };
}

interface Config {
  llm: LLMConfig;
}

function replaceEnvVars(value: unknown): unknown {
  if (typeof value === 'string') {
    const envVarMatch = value.match(/^\$([A-Z_][A-Z0-9_]*)$/);
    if (envVarMatch && envVarMatch[1]) {
      const envVarName = envVarMatch[1];
      const envValue = process.env[envVarName];
      if (!envValue) {
        throw new Error(`Environment variable ${envVarName} is not defined`);
      }
      return envValue;
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(replaceEnvVars);
  }

  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = replaceEnvVars(val);
    }
    return result;
  }

  return value;
}

function loadConfig(): Config {
  const configPath = path.join(process.cwd(), 'config.yaml');

  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  const configFile = fs.readFileSync(configPath, 'utf8');
  const rawConfig = yaml.load(configFile) as Config;

  const config = replaceEnvVars(rawConfig) as Config;

  return config;
}

export const config = loadConfig();
console.log(JSON.stringify(config));

export type { Config, LLMConfig, LLMProvider };