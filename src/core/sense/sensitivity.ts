/**
 * smart 监管的敏感判定（确定性纯函数，零 I/O，禁止 LLM/外部脚本每次判定，规则5）。
 *
 * 调用方：buildSenseTrigger（agent/middleware/tool.ts）仅当 configuredLevel === smart 时调用。
 *   true  → 本次安全：effectiveLevel=auto（不建审批，归 autoCalls 直接执行）
 *   false → 本次敏感：effectiveLevel=smart（建审批，走 interrupt 等待用户确认）
 *
 * ruleSet 来源：ctx.runtime.sensitivityRules，由 ruleLoader.loadMergedRuleSet 在 resolve 期
 *   从 .chery/rule/（base.yaml 基准 + 预设 rule 覆盖文件）深合并编译冻结。详见
 *   docs/core/sense.md「smart 规则表」。
 *
 * 黑名单 fail-open 语义（命中危险才拦截，其余放行）：
 *   - ruleSet[name] === false      → false（硬开关：破坏性 sense 无条件需确认）
 *   - ruleSet[name] 未登记（undefined）→ true（未知 sense 默认放行，黑名单核心）
 *   - 命中 dangerPatterns           → false（命中危险，需确认）
 *   - 有条目但 extract 取参异常/空串 → false（fail-loud 保守，区别于「未登记即放行」）
 *   - 其余                           → true（放行）
 *
 * 设计原则：
 *   1. 确定性：同 (ruleSet, name, args) 永远同结果——resume 续接 / 断连重放行为一致。
 *   2. fail-open + 两道防线：未知默认放行（黑名单），但 `false` 硬开关 + 取参异常保守
 *      兜住破坏性 sense 与配置/args 异常（规则12 fail-loud）。
 */
import type { CompiledRuleSet } from './ruleLoader.js'

/**
 * 判定一次 smart sense 调用是否安全（可直接自动执行）。仅在 configuredLevel === smart 时调用。
 * 黑名单 fail-open：未命中 dangerPatterns / 未知 sense → 放行；命中危险 / false / 取参异常 → 需确认。
 */
export function isSafeSenseCall(
  ruleSet: CompiledRuleSet,
  name: string,
  args: Record<string, unknown>,
): boolean {
  const rule = ruleSet[name]
  // false → 硬开关：整体需确认（破坏性 sense 兜底）
  if (rule === false) return false
  // 未登记（未知 sense）→ fail-open 放行
  if (!rule) return true
  try {
    const target = rule.extract ? rule.extract(args) : ''
    // 有条目但取不到待匹配串 → fail-loud 保守需确认（extract 配错 / args 异常）
    if (!target) return false
    for (const p of rule.dangerPatterns ?? []) {
      // 命中危险（子串 / RegExp）→ 需确认
      if (typeof p === 'string' ? target.includes(p) : p.test(target)) return false
    }
    // 未命中任何危险 → 放行
    return true
  } catch {
    // 取参抛错 → 保守需确认
    return false
  }
}
