/**
 * 安全的 JSON 解析函数
 * 解析失败时返回 fallback 值，避免抛出异常
 */
export function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}
