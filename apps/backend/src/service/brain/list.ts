import type { HandlerContext } from '../message/router.js'
import { Method, type BrainListResponseData } from '../message/types.js'
import config, { DEFAULT_PRESET_NAME } from '@/utils/config'
import { listConnectedServerNames } from '@/core/mcp'
import { resolveBrainProtocol } from '@/core/llm/routing.js'

/**
 * 列出所有可用 brain（config.yaml 中 llm.brain 的键）+ 当前已连 MCP server（供前端渲染开关）。
 */
export async function handleBrainList(
  _ctx: HandlerContext,
  _params: unknown,
): Promise<BrainListResponseData> {
  // contextLimit 供前端 context bar 显示用量；缺省 undefined（显示为未知，不伪造百分比）。
  // default 标记 = 是否为「默认」预设 leader 角色的 brain（前端 AgentDialog 无 runtime 时预选默认 brain）
  const defaultPreset = config.presets?.[DEFAULT_PRESET_NAME]
  const defaultLeaderBrain = defaultPreset?.leader
    ? config.roles?.[defaultPreset.leader]?.brain
    : undefined
  const brains = Object.entries(config.llm.brain).map(([name, cfg]) => ({
    name,
    provider: cfg.provider,
    protocol: resolveBrainProtocol(cfg),
    model: cfg.model,
    thinking: cfg.thinking,
    capabilities: cfg.capabilities,
    contextLimit: cfg.contextLimit,
    default: name === defaultLeaderBrain,
    senseGroups: Object.keys(config.sense_groups ?? {}),
  }))
  return { brains, mcpServers: listConnectedServerNames() }
}

/**
 * 注册 Brain handlers
 */
export function registerBrainHandlers(router: import('../message/router.js').RpcRouter): void {
  router.register(Method.BRAIN_LIST, handleBrainList)
}
