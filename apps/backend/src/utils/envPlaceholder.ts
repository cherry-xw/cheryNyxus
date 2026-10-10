/**
 * 配置中的环境变量占位符约定。
 *
 * 仅支持 `$API_KEY` 这一类全大写名称。将格式判断集中在此处，避免配置保存、
 * 回滚和运行期请求对同一个占位符得出不同结论。
 */
export const ENV_PLACEHOLDER_RE = /^\$[A-Z_][A-Z0-9_]*$/

/** 值看似环境变量占位符，但不符合项目约定。 */
export function isMalformedEnvPlaceholder(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('$') && !ENV_PLACEHOLDER_RE.test(value)
}

/** 面向用户的统一修复指引；不回显原值，避免误泄露字面密钥。 */
export function envPlaceholderFormatError(field: string): string {
  return `${field} 环境变量占位符格式错误：仅支持 $API_KEY 这类全大写字母、数字和下划线的格式，请在设置中修正后重试。`
}
