import type { HandlerContext } from '../message/router.js'
import { Method, type PromptsListResponseData } from '../message/types.js'
import { listPrompts } from '@/agent/prompt/listPrompts.js'

/**
 * prompts.list：递归列出 .chery/prompt/ 下全部 .md（含子文件夹，排除全局 base system.md），供设置面板
 * systemPrompt 级联选择器（el-cascader）建目录树。目录为空返 { prompts: [] }。
 */
export async function handlePromptsList(
  _ctx: HandlerContext,
  _params: unknown,
): Promise<PromptsListResponseData> {
  return { prompts: listPrompts() }
}

/**
 * 注册 Prompt handlers
 */
export function registerPromptHandlers(router: import('../message/router.js').RpcRouter): void {
  router.register(Method.PROMPTS_LIST, handlePromptsList)
}
