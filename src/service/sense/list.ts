import type { HandlerContext } from '../message/router.js'
import {
  Method,
  type SenseListResponseData,
  type SenseToolsDocsRequestData,
  type SenseToolsDocsResponseData,
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
 * 注意：不返回 doc 字段——完整说明文档走 sense.tools.docs，避免每次下拉都携带大段文档。
 */
export async function handleSenseTools(
  _ctx: HandlerContext,
  _params: unknown,
): Promise<SenseToolsResponseData> {
  return {
    tools: BUILTIN_SENSE_TOOLS.map(({ name, label, description, icon }) => ({
      name,
      label,
      description,
      icon,
    })),
  }
}

/**
 * sense.tools.docs：统一返回内置工具的完整说明文档。
 * - 不传 tools / 传空数组 → 全量返回（前端自行按需取用，一次拉取缓存）。
 * - 传 tools → 按 name 列表过滤，一次性返回对应说明（未知 name 自动忽略）。
 * 文档统一定义于 BUILTIN_SENSE_TOOLS.doc，无需每次展示重新提取。
 */
export async function handleSenseToolDocs(
  _ctx: HandlerContext,
  params: SenseToolsDocsRequestData,
): Promise<SenseToolsDocsResponseData> {
  const want = params.tools?.length ? new Set(params.tools) : null
  const docs = BUILTIN_SENSE_TOOLS.filter((t) => !want || want.has(t.name)).map((t) => ({
    name: t.name,
    doc: t.doc,
  }))
  return { docs }
}

/**
 * 注册 Sense handlers
 */
export function registerSenseHandlers(router: import('../message/router.js').RpcRouter): void {
  router.register(Method.SENSE_LIST, handleSenseList)
  router.register(Method.SENSE_TOOLS, handleSenseTools)
  router.register(Method.SENSE_TOOLS_DOCS, handleSenseToolDocs)
}
