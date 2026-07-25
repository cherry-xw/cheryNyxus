import config from '@/utils/config.js'
import { getChat, getChatWorkspace } from '@/db/chat.js'
import { resolvePresetSelection } from '@/agent/runtimeResolver.js'
import { runMaintenanceChat } from '../schedule/maintenanceChat.js'
import { logger } from '@/utils/logger/index.js'

/**
 * Extract 触发器（参考 Claude Code Extract Memories Agent——每轮对话结束后台提取）。
 *
 * 主 agent 一轮 done（产出最终响应且无 senseCalls）后，observer 调 maybeTriggerExtract：
 * 若配置了「维护」预设 → fire-and-forget spawn curator 做 Extract（分析最近对话提取记忆）。
 *
 * 与文章 Extract 的差异：
 * - 文章用 forked agent（同进程内 fork，maxTurns=5 + canUseTool 沙箱）；cheryClaw 用独立 chat（spawn curator 子 agent）
 * - 文章每轮触发；cheryClaw 由 observer 主 agent done 后触发，curator 子 chat wake=deferred 不唤主
 * - 互斥：curator Extract prompt 内指示「主 agent 本轮已写记忆则跳过」+ memory_manage list 比对 manifest
 *
 * 不阻塞主流程：void 异步执行，错误仅 logger.error。
 */

/** 「维护」预设名（与 config.yaml presets 键一致） */
const MAINTENANCE_PRESET = '维护'

/** Extract 任务 prompt 模板（交给 curator） */
const EXTRACT_TASK_PROMPT = `Extract：分析最近交付你的对话内容，提取不可推导、非显而易见的信息写入项目记忆。

流程：
1. 先 memory_manage list scope=global + scope=workspace（若有 workspace）读已有 manifest
2. 仅用交付你的最近对话消息，提取值得长期记住的信息（user/feedback/project/reference 四类之一）
3. 同主题已有记忆 → update 更新，不创建重复文件
4. 达上限时 add 必须指定 replaceTarget + replaceReason 淘汰最过时
5. 最多 5 轮工具调用——只提取不验证（不 grep 源码、不 git log）

禁止保存：代码模式/架构/文件路径/git 历史/调试配方/CLAUDE.md 内容/临时任务状态。
feedback/project 类 content 必须含 **Why:** + **How to apply:** 结构；相对日期转绝对日期。

若主 agent 本轮已通过 memory_manage 写入记忆（manifest 有新条目），跳过本轮提取并回报「主 agent 已写入，跳过」。`

/**
 * 主 agent done 后触发 Extract（若配置了维护预设）。
 * observer 在 generator 正常退出后调用。不抛错，不阻塞。
 */
export function maybeTriggerExtract(chatId: string): void {
  try {
    // 仅主 agent 触发（子 agent 不触发 Extract，避免递归）
    const chat = getChat(chatId)
    if (!chat) return
    if (chat.parent_chat_id) return // 子 agent 跳过

    // 维护 chat 自身不触发 Extract（避免维护 chat done 后再触发 Extract 递归）
    // 通过 metadata.maintenance 标记识别（runMaintenanceChat 写入）
    if (chat.metadata) {
      try {
        const meta = JSON.parse(chat.metadata) as { maintenance?: boolean }
        if (meta.maintenance === true) return
      } catch {
        // metadata 非合法 JSON → 旧记录兼容，忽略
      }
    }

    const preset = config.presets?.[MAINTENANCE_PRESET]
    if (!preset) return // 未配置维护预设 → 不触发

    // 解析 curator 编制
    let resolved
    try {
      resolved = resolvePresetSelection(MAINTENANCE_PRESET)
    } catch (err) {
      logger.event(
        'extract.preset-unresolved',
        { preset: MAINTENANCE_PRESET, message: (err as Error).message },
        3,
      )
      return
    }

    const workspace = getChatWorkspace(chatId)
    logger.event('extract.trigger', {
      chatId,
      leader: preset.leader,
      hasWorkspace: !!workspace,
    })

    void runMaintenanceChat({
      presetName: MAINTENANCE_PRESET,
      task: EXTRACT_TASK_PROMPT,
      selection: resolved.selection,
      systemPromptFile: resolved.systemPromptFile,
      workspace, // 继承主 chat workspace（同项目，curator 可操作 workspace 层记忆）
      skillFilter: resolved.skillFilter,
      spawnTypes: resolved.spawnTypes,
      parentChatId: chatId, // 子 chat（走 parent_chat_id 关联）
      wake: 'deferred', // 不唤主：Extract 完成仅落 DB，不打断主 agent
      type: preset.leader, // curator 角色名
    })
  } catch (err) {
    // 失败不阻塞主流程
    logger.event('extract.trigger-failed', { chatId, message: (err as Error).message }, 3)
  }
}
