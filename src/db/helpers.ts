/**
 * DB 行读取共享 helper：JSON 列还原。
 *
 * SQLite 行列以 JSON 字符串持久化结构化数据，读取端统一经这两个 helper
 * 还原（写入端 JSON.stringify 无需封装）。行列值是 TEXT 列，解析失败即抛
 * （数据损坏 fail-loud）。
 */

/** 还原单行的一个 JSON 列；行不存在或列 NULL → undefined。 */
export function jsonRow<T>(
  row: { [key: string]: unknown } | undefined,
  column: string,
): T | undefined {
  const value = row?.[column]
  if (value === undefined || value === null) return undefined
  return JSON.parse(String(value)) as T
}

/** 还原多行的同一 JSON 列（按给定行数组顺序）。 */
export function jsonRows<T>(rows: { [key: string]: unknown }[], column: string): T[] {
  return rows.map((row) => JSON.parse(String(row[column]) as string) as T)
}
