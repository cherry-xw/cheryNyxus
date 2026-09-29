/**
 * lite 内置工具专有内容区（LiteCommandDetail / LiteReadFileDetail / …）共用的参数解析小工具。
 * 只做「从 arguments JSON 取字段」的扁平取值，不做展示。
 */
import { normalizeKey, parseJsonValue } from './toolRendering'

/** 工具 arguments（JSON 字符串或对象）→ 记录；解析失败 / 非对象返回 {}。 */
export function argsRecord(text: string | null | undefined): Record<string, unknown> {
  const value = parseJsonValue(text)
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function matchKey(
  record: Record<string, unknown>,
  keys: readonly string[],
): [string, unknown] | undefined {
  for (const [key, value] of Object.entries(record)) {
    if (keys.some((k) => normalizeKey(k) === normalizeKey(key))) return [key, value]
  }
  return undefined
}

/** 按（归一化）键取字符串字段；未命中返回 ''。 */
export function argString(record: Record<string, unknown>, ...keys: string[]): string {
  const hit = matchKey(record, keys)
  return hit && typeof hit[1] === 'string' ? hit[1] : ''
}

/** 按（归一化）键取数字字段；未命中返回 undefined。 */
export function argNumber(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  const hit = matchKey(record, keys)
  return typeof hit?.[1] === 'number' ? hit[1] : undefined
}

/** 按（归一化）键取布尔字段；未命中返回 undefined。 */
export function argBoolean(
  record: Record<string, unknown>,
  ...keys: string[]
): boolean | undefined {
  const hit = matchKey(record, keys)
  return typeof hit?.[1] === 'boolean' ? hit[1] : undefined
}
