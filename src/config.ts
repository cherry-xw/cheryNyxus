import baseConfig from "../config.json" with { type: "json" }
// eslint-disable-next-line no-process-env
const env = process.env

/**
 * 替换配置值中的环境变量占位符
 * 例如: "$LANGSMITH_API_KEY" → process.env.LANGSMITH_API_KEY
 */
function replaceEnvVars(value: unknown): unknown {
  if (typeof value === "string" && value.startsWith("$")) {
    const envKey = value.slice(1)
    const envValue = env[envKey]
    return envValue !== undefined ? envValue : value
  }

  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value)) {
      result[key] = replaceEnvVars(val)
    }
    return result
  }

  return value
}

/**
 * 合并配置：env优先级更高
 * - 识别 "$VAR_NAME" 格式的占位符，从 env 读取替换
 * - 递归合并所有配置项
 */
const config = replaceEnvVars(baseConfig) as typeof baseConfig

export default config

