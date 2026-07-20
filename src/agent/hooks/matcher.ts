/**
 * Hooks matcher 与 if 谓词实现。
 *
 * - matcher：仿 Claude Code 规则（exact / `|`/`,` 分隔集合 / 正则）
 * - if 谓词：jq-lite 子集（仅支持字段访问、字面量比较、truthy）
 *
 * 详见 [docs/agent/hooks.md](../../../../docs/agent/hooks.md)。
 */

/** Handler 配置：含 matcher / if 谓词 / command / timeout */
export interface HookHandlerConfig {
  /** 可选：按 provider 过滤（exact / `|`/`,` 分隔 / 正则） */
  matcher?: string
  /** 可选：jq-lite 谓词（基于 {event, payload, ctx} 评估） */
  if?: string
  /** 必填：shell 命令（支持 ${CHERY_DIR}/${VAR} 模板替换） */
  command: string
  /** 可选：超时（秒），默认 10 */
  timeout?: number
}

/**
 * matcher 评估。
 *
 * 仿 Claude Code 规则：
 * - undefined / '*' / '' → 匹配全部
 * - 仅含 [a-zA-Z0-9_] → 精确字符串
 * - 含 `|` 或 `,` 字符 → 分隔的多精确字符串集合
 * - 其它字符 → JS 正则（unanchored）
 *
 * 注：本实现简化为：含 `|` 或 `,` → 分隔集合；否则尝试当正则；正则失败或仅精确字符 → 精确匹配。
 */
export function matches(matcher: string | undefined, value: string): boolean {
  if (!matcher || matcher === '*') return true

  // `|` 或 `,` 分隔的多精确字符串集合
  if (matcher.includes('|') || matcher.includes(',')) {
    const alts = matcher
      .split(/[|,]/)
      .map((s) => s.trim())
      .filter(Boolean)
    return alts.includes(value)
  }

  // 含正则元字符 → 当正则（unanchored）
  const regexMeta = /[.*+?^${}()|[\]\\]/.test(matcher)
  if (regexMeta) {
    try {
      return new RegExp(matcher).test(value)
    } catch {
      // 正则非法 → 降级精确匹配
      return matcher === value
    }
  }

  // 仅精确字符 → 精确匹配
  return matcher === value
}

/**
 * jq-lite 谓词评估。
 *
 * 支持语法（极简，够 PreLLMRequest 场景）：
 * - `field == "value"` / `field != "value"` / `field == value`（字符串比较）
 * - `field`（单独字段名 → truthy 检查）
 * - `field` 路径支持 `.` 分隔（如 `payload.thinking`）
 *
 * 不支持：算术、函数调用、复杂表达式。Handler 想用复杂逻辑 → 直接在 handler 脚本内用 jq。
 */
export function evalIf(expr: string, ctx: Record<string, unknown>): boolean {
  const trimmed = expr.trim()
  if (!trimmed) return true

  // == 比较
  const eqMatch = trimmed.match(/^([\w.]+)\s*==\s*(.+)$/)
  if (eqMatch) {
    const [, path, rhsRaw] = eqMatch
    const lhs = readPath(ctx, path ?? '')
    const rhs = parseLiteral((rhsRaw ?? '').trim())
    return lhs === rhs
  }

  // != 比较
  const neqMatch = trimmed.match(/^([\w.]+)\s*!=\s*(.+)$/)
  if (neqMatch) {
    const [, path, rhsRaw] = neqMatch
    const lhs = readPath(ctx, path ?? '')
    const rhs = parseLiteral((rhsRaw ?? '').trim())
    return lhs !== rhs
  }

  // 单独字段 → truthy
  if (/^[\w.]+$/.test(trimmed)) {
    return Boolean(readPath(ctx, trimmed))
  }

  // 不支持的语法 → 默认 false（保守拒绝）
  return false
}

/** 读 ctx 中路径（点号分隔） */
function readPath(ctx: Record<string, unknown>, path: string): unknown {
  if (!path) return undefined
  const parts = path.split('.')
  let cur: unknown = ctx
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[p]
  }
  return cur
}

/** 解析字面量：字符串/数字/布尔/null */
function parseLiteral(s: string): unknown {
  // 字符串（双引号）
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    return s.slice(1, -1)
  }
  // 字符串（单引号）
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) {
    return s.slice(1, -1)
  }
  // 数字
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s)
  // 布尔/null
  if (s === 'true') return true
  if (s === 'false') return false
  if (s === 'null') return null
  // 兜底：当作字符串
  return s
}

/**
 * 模板替换：command 中的 ${CHERY_DIR} / ${VAR} 替换为环境变量值。
 * 不递归（替换一次），无 ${} 形式则原样返回。
 */
export function expandCommandTemplate(
  command: string,
  env: Record<string, string | undefined>,
): string {
  return command.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, name: string) => env[name] ?? '')
}
