import type { HandlerContext } from '../message/router.js'
import {
  Method,
  type SenseListResponseData,
  type SenseToolsResponseData,
} from '../message/types.js'
import config from '@/utils/config'
import { BUILTIN_SENSE_TOOLS } from '@/agent/sense/index.js'

/**
 * 列出所有可用 sense group（config.yaml 中 sense_groups 的键）
 */
export async function handleSenseList(
  _ctx: HandlerContext,
  _params: unknown,
): Promise<SenseListResponseData> {
  const senseGroups = Object.entries(config.sense_groups ?? {}).map(([name, senses]) => ({
    name,
    senses,
  }))
  return { senseGroups }
}

/**
 * 列出代码维护的全部内置工具（name/label/description），供设置面板感官分组下拉。
 * 仅内置；自定义/外部/MCP 工具不在此列，前端组合框允许自由输入。
 */
export async function handleSenseTools(
  _ctx: HandlerContext,
  _params: unknown,
): Promise<SenseToolsResponseData> {
  return { tools: BUILTIN_SENSE_TOOLS }
}

/**
 * 注册 Sense handlers
 */
export function registerSenseHandlers(router: import('../message/router.js').RpcRouter): void {
  router.register(Method.SENSE_LIST, handleSenseList)
  router.register(Method.SENSE_TOOLS, handleSenseTools)
}
