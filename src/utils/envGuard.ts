/**
 * 环境变量敏感值脱敏工具
 *
 * 从 .env 读取 key→value 映射，对文本中敏感 key（KEY/SECRET/TOKEN/PASSWORD/AUTH）的**值**做遮蔽：
 * key 名保留、值替换为占位符，防止敏感信息泄露。非敏感 key 完全不动。
 */

import { listEnvVarMap } from './config.js'

/** 敏感 key 判定（key 名匹配，大小写不敏感）。 */
export const SENSITIVE_KEY_RE = /KEY|SECRET|TOKEN|PASSWORD|AUTH/i

/** 裸值子串替换最小长度（避免短值误伤，如 'true'/'0' 等通用短值）。 */
export const MIN_BARE_VALUE_LENGTH = 8

/** 缓存 .env key→value 映射，首次读取时加载一次，避免重复读文件。 */
let cachedEnvVarMap: Record<string, string> | null = null

/**
 * 获取 .env key→value 映射（带缓存）
 *
 * @returns key→value 映射
 */
export function getEnvVarMap(): Record<string, string> {
  if (cachedEnvVarMap === null) {
    cachedEnvVarMap = listEnvVarMap()
  }
  return cachedEnvVarMap
}

/**
 * 重置 envGuard 缓存（供测试 / 运行期 .env 变更失效用）。
 */
export function resetEnvVarCache(): void {
  cachedEnvVarMap = null
}

/**
 * 转义正则表达式特殊字符
 *
 * @param str 原始字符串
 * @returns 转义后的字符串
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 纯函数：对 content 遮蔽 envMap 中敏感 key 的值。
 *
 * 两段式替换：
 *  - 行内 `KEY=value` → `KEY=[REDACTED]`（key 名保留，`[^\r\n]*` 覆盖带引号/任意字符形式，无论值长短）
 *  - 裸值子串：值长 ≥ MIN_BARE_VALUE_LENGTH 时按值长降序替换（避免短值为长值子串时二次替换错位）
 * 非敏感 key（不含 SENSITIVE_KEY_RE 关键词）的 key 名与值完全不动。
 *
 * @param content 原始文本内容
 * @param envMap .env key→value 映射
 * @param placeholder 替换占位符（默认 '[REDACTED]'）
 * @returns 脱敏后的文本
 *
 * @example
 * ```ts
 * const envMap = { API_KEY: 'sk-12345', NODE_ENV: 'production' };
 * redactSensitiveValues('API_KEY=sk-12345\nNODE_ENV=production', envMap);
 * // 输出: "API_KEY=[REDACTED]\nNODE_ENV=production"（NODE_ENV 非敏感 key，完全不动）
 * ```
 */
export function redactSensitiveValues(
  content: string,
  envMap: Record<string, string>,
  placeholder = '[REDACTED]',
): string {
  const entries = Object.entries(envMap).filter(
    ([key, value]) =>
      SENSITIVE_KEY_RE.test(key) &&
      value &&
      value !== placeholder &&
      !placeholder.includes(value),
  )
  if (entries.length === 0) return content

  let result = content

  // 行内 pass：KEY=value → KEY=[REDACTED]（词边界 \b 保证 MY_API_KEY 不被 API_KEY 命中）
  for (const [key] of entries) {
    result = result.replace(
      new RegExp(`\\b${escapeRegex(key)}\\s*=\\s*[^\\r\\n]*`, 'g'),
      `${key}=${placeholder}`,
    )
  }

  // 裸值 pass：值长 ≥ MIN_BARE_VALUE_LENGTH，按值长降序（长值先替换，避免短值破坏长值子串）
  const bareValues = entries
    .filter(([, value]) => value.length >= MIN_BARE_VALUE_LENGTH)
    .sort((a, b) => b[1].length - a[1].length)
  for (const [, value] of bareValues) {
    result = result.replace(new RegExp(escapeRegex(value), 'g'), placeholder)
  }

  return result
}

/**
 * 在文本中脱敏 .env 敏感 key 的值（对外入口，签名保持不变——tool.ts 唯一调用点零改动）。
 *
 * @param content 原始文本内容
 * @param placeholder 替换占位符（默认 '[REDACTED]'）
 * @returns 脱敏后的文本
 *
 * @example
 * ```ts
 * const content = "API_KEY=sk-12345\nTOKEN=abc123";
 * const redacted = redactEnvKeys(content);
 * // 输出: "API_KEY=[REDACTED]\nTOKEN=[REDACTED]"（key 名保留、值替换）
 * ```
 */
export function redactEnvKeys(content: string, placeholder = '[REDACTED]'): string {
  return redactSensitiveValues(content, getEnvVarMap(), placeholder)
}
