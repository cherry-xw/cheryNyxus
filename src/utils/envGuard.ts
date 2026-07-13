/**
 * 环境变量敏感信息脱敏工具
 *
 * 从 .env 文件提取环境变量名，在文本中替换为占位符，防止敏感信息泄露
 */

import { listEnvVarNames } from "./config.js";

/**
 * 缓存的环境变量名列表
 * 启动时加载一次，避免重复读取文件
 */
let cachedEnvVarNames: string[] | null = null;

/**
 * 获取环境变量名列表（带缓存）
 *
 * @returns 环境变量名数组（已排序）
 */
export function getEnvVarNames(): string[] {
  if (cachedEnvVarNames === null) {
    cachedEnvVarNames = listEnvVarNames();
  }
  return cachedEnvVarNames;
}

/**
 * 重置缓存（供测试使用）
 */
export function resetEnvVarCache(): void {
  cachedEnvVarNames = null;
}

/**
 * 在文本中脱敏环境变量名
 *
 * 将所有 .env 中定义的环境变量名替换为占位符
 *
 * @param content 原始文本内容
 * @param placeholder 替换占位符（默认 '[REDACTED]'）
 * @returns 脱敏后的文本
 *
 * @example
 * ```ts
 * const content = "API_KEY=sk-12345\nTOKEN=abc123";
 * const redacted = redactEnvKeys(content);
 * // 输出: "[REDACTED]=sk-12345\n[REDACTED]=abc123"
 * ```
 */
export function redactEnvKeys(content: string, placeholder = "[REDACTED]"): string {
  const envVarNames = getEnvVarNames();

  if (envVarNames.length === 0) {
    return content;
  }

  // 构建正则表达式：匹配所有环境变量名
  // 使用词边界 \b 确保只匹配完整的变量名（避免部分匹配）
  // 示例：API_KEY 匹配 "API_KEY=value"，但不匹配 "MY_API_KEY=value"
  const pattern = new RegExp(
    `\\b(${envVarNames.map(escapeRegex).join("|")})\\b`,
    "g"
  );

  return content.replace(pattern, placeholder);
}

/**
 * 转义正则表达式特殊字符
 *
 * @param str 原始字符串
 * @returns 转义后的字符串
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}