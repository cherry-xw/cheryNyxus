/**
 * chat.promptSnapshot：重建 chat 当前 runtime 的 system prompt 全文 + 工具定义。
 *
 * 用途：前端历史抽屉顶部「上下文」hover 面板展示完整系统提示词（system 消息内容 + tools 字段）。
 * 重建基准：chat metadata 持久化的 systemPromptFile/workspace/skillFilter + runtime selection
 *   （与 init 期 buildFirstSystemPrompt / RuntimeResolver.resolve 同源，recompute-at-request）。
 * 不入 DB、不缓存（与 contextUsage.ts 一致：系统消息不入库，recompute 偏差可忽略）。
 *
 * tools 统一返回 OpenAI 形状（{type:'function',function:{name,description,parameters}}），
 * 剥离 provider 差异（OpenAI strict / Anthropic input_schema 在各自 provider 内转换，快照层不关心）。
 */
import type { HandlerContext } from '../message/router.js'
import {
  Method,
  type ChatPromptSnapshotRequestData,
  type ChatPromptSnapshotResponseData,
  type PromptSnapshotTool,
} from '../message/types.js'
import buildFirstSystemPrompt from '@/agent/prompt/index.js'
import { RuntimeResolver } from '@/agent/runtimeResolver.js'
import {
  getChat,
  getChatRuntimeSelection,
  getChatSystemPromptFile,
  getChatWorkspace,
  getChatSkillFilter,
} from '@/db/chat.js'
import { getChatMentionableRoles } from './roleMentions.js'

/**
 * 重建 system prompt 全文 + tools 列表。
 * selection 缺失（chat 无 runtime）→ tools=[]；systemPrompt 仍按 systemPromptFile/workspace/skillFilter 重建。
 * 与 computeContextBreakdown 同构：isSubagent 据是否 parent_chat_id 决定 injectMemoryManage。
 */
function buildPromptSnapshot(chatId: string): {
  systemPrompt: string
  tools: PromptSnapshotTool[]
} {
  const systemPromptFile = getChatSystemPromptFile(chatId)
  const workspace = getChatWorkspace(chatId)
  const skillFilter = getChatSkillFilter(chatId)
  const systemPrompt = buildFirstSystemPrompt(
    systemPromptFile,
    workspace,
    skillFilter,
    getChatMentionableRoles(chatId),
  )

  const selection = getChatRuntimeSelection(chatId)
  if (!selection) return { systemPrompt, tools: [] }

  const isSubagent = !!getChat(chatId)?.parent_chat_id
  const runtime = new RuntimeResolver().resolve(selection, {
    injectMemoryManage: !isSubagent,
    chatId,
  })
  const tools: PromptSnapshotTool[] = runtime.builtSenses.map((fn) => ({
    name: fn.function.name,
    description: fn.function.description,
    parameters: fn.function.parameters,
  }))
  return { systemPrompt, tools }
}

export async function handleChatPromptSnapshot(
  _ctx: HandlerContext,
  data: ChatPromptSnapshotRequestData,
): Promise<ChatPromptSnapshotResponseData> {
  const { chatId } = data
  if (!getChat(chatId)) throw new Error('这个会话不见了')
  try {
    const { systemPrompt, tools } = buildPromptSnapshot(chatId)
    return { chatId, systemPrompt, tools }
  } catch (err) {
    // resolve runtime 失败（感官组不存在 / MCP server 未连等）→ fail loud：抛错给前端，不静默返空 tools
    throw new Error(`重建提示词快照失败：${(err as Error).message}`)
  }
}

/** 注册到 chat 管理 handlers（与 contextUsage 同批，非流式轻量 RPC）。 */
export function registerPromptSnapshotHandler(
  router: import('../message/router.js').RpcRouter,
): void {
  router.register(Method.CHAT_PROMPT_SNAPSHOT, handleChatPromptSnapshot)
}
