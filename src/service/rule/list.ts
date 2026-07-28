import type { HandlerContext } from '../message/router.js'
import { Method, type RulesListResponseData } from '../message/types.js'
import { listRules } from '@/core/sense/ruleLoader.js'

/**
 * rules.list：列出 .chery/rule/ 下全部 .yaml 文件名（**排除基准 base.yaml**），
 * 供设置面板预设 tab 的「规则文件」下拉（el-select）填充。目录为空/不存在 → { rules: [] }。
 * 单一 choke point：listRules 排除 base.yaml → 前端下拉不可能选到基准。
 */
export async function handleRulesList(
  _ctx: HandlerContext,
  _params: unknown,
): Promise<RulesListResponseData> {
  return { rules: listRules() }
}

/**
 * 注册 Rule handlers
 */
export function registerRuleHandlers(router: import('../message/router.js').RpcRouter): void {
  router.register(Method.RULES_LIST, handleRulesList)
}
