import { randomUUID } from 'crypto'
import { createChat, updateChatMetadata } from '@/db/chat.js'
import {
  ensureChat,
  clearChatRuntime,
  getActiveChatRunId,
  activateChatRun,
  releaseChatRun,
} from '../chat/runtime.js'
import { observeAgentChunks } from '../chat/observer.js'
import type { RuntimeSelection } from '@/agent/runtimeResolver.js'
import type { SkillFilter } from '@/agent/prompt/loadSkill.js'
import { logger } from '@/utils/logger/index.js'

/**
 * 独立维护 chat 后台运行（脱离 RPC ctx / 无 parent ws，参考 spawnEager 但无父 ws 路径）。
 *
 * 用于定时触发器（Dream）与 Extract 触发器：创建一个独立主 agent chat（或子 chat），
 * 后台跑 prompt，输出仅落 DB + logger（无 ws 推送——维护任务无前端订阅者）。
 *
 * 与 spawnEager.runChildTaskInBackground 的差异：
 * - spawnEager 走 handleChatStartSpawn + claimSpawnTask（依赖 spawn_tasks 表 + 父 ws 推 chunk）
 * - 本函数直连 ensureChat + agent.run + observeAgentChunks（无 spawn_tasks、无父 ws、无 chunk 推送）
 *
 * 错误隔离：失败仅 logger.error，不抛出（caller 已 try/catch）。
 */

export interface MaintenanceChatOptions {
  /** 预设名（溯源 + 日志用） */
  presetName?: string
  /** 交付 curator 执行的任务 prompt */
  task: string
  /** runtime 编制（brain + senseGroup + mcpServers） */
  selection: RuntimeSelection
  /** 角色 system prompt 文件绝对路径（可选） */
  systemPromptFile?: string
  /** 项目工作目录（可选，注入 <workspace> 段） */
  workspace?: string
  /** 技能组/插件组过滤（可选） */
  skillFilter?: SkillFilter
  /** spawn roster（可选，仅用于预设主 agent 溯源） */
  spawnTypes?: string[]
  /** 父 chatId（可选，有值则为子 chat 走 parent_chat_id 关联 + wake 策略；无值则独立主 chat） */
  parentChatId?: string
  /** 唤醒策略（parentChatId 给出时必填，默认 deferred 不唤主） */
  wake?: 'immediate' | 'deferred' | 'barrier'
  /** 角色 type（溯源用，写入 metadata.type） */
  type?: string
}

/**
 * 创建并后台运行一个维护 chat。
 * 不抛错：内部 try/catch 包外层，失败仅 logger.error。
 */
export async function runMaintenanceChat(opts: MaintenanceChatOptions): Promise<void> {
  const chatId = randomUUID()
  const metadata: Record<string, unknown> = {
    runtime: opts.selection,
    ...(opts.systemPromptFile ? { systemPromptFile: opts.systemPromptFile } : {}),
    ...(opts.workspace ? { workspace: opts.workspace } : {}),
    ...(opts.skillFilter ? { skillFilter: opts.skillFilter } : {}),
    ...(opts.spawnTypes ? { spawnTypes: opts.spawnTypes } : {}),
    ...(opts.type ? { type: opts.type } : {}),
    ...(opts.presetName ? { preset: opts.presetName } : {}),
    // 维护 chat 标记（供 listAllChats 清理 / 前端识别）
    maintenance: true,
  }
  if (opts.parentChatId) {
    metadata.wake = opts.wake ?? 'deferred'
  }

  createChat(chatId, metadata, opts.parentChatId)
  let agent
  try {
    agent = await ensureChat(chatId, opts.selection)
  } catch (err) {
    clearChatRuntime(chatId)
    // 删 createChat 刚插入的 DB 行（孤儿行清理）
    logger.event(
      'maintenance.ensure-failed',
      {
        chatId,
        preset: opts.presetName,
        message: (err as Error).message,
      },
      3,
    )
    return
  }

  const runId = `maintenance-${chatId.slice(0, 8)}`
  activateChatRun(chatId, runId)
  logger.event('maintenance.start', {
    chatId,
    preset: opts.presetName,
    parentChatId: opts.parentChatId,
    type: opts.type,
    taskPreview: opts.task.slice(0, 200),
  })

  try {
    const generator = observeAgentChunks(agent.run(opts.task), chatId, () => agent.getMessages())
    // 维护任务无前端订阅者：迭代消费 generator 驱动 agent 跑完，chunk 不推 ws
    for await (const _ of generator) {
      void _ // chunk 仅由 observeAgentChunks 内部落库，这里不转发
    }
    updateChatMetadata(chatId, { finished: true })
    logger.event('maintenance.done', {
      chatId,
      preset: opts.presetName,
      runId,
    })
  } catch (err) {
    // 维护 chat 失败不唤主（独立任务），仅记 error
    logger.event(
      'maintenance.failed',
      {
        chatId,
        preset: opts.presetName,
        message: (err as Error).message,
        stack: (err as Error).stack,
      },
      3,
    )
    // 不标 finished（失败=中断态，与统一暂停语义一致，孤儿行可接受）
  } finally {
    releaseChatRun(chatId, runId)
    // 子 chat 维护：若 parentChatId 给出，走 registerWaitedChild + child_done 路径由 observer 处理
    // 但本函数直连 agent.run（不经 spawnEager），子完成不会自动唤主 ——
    // 仅当 wake=deferred 时这是期望行为（不唤主）；immediate/barrier 需 caller 自行处理（当前不用）
    // 独立主 chat（无 parent）无需唤醒链
  }
}

/**
 * 简易存在性校验：chat 是否仍在运行（供 schedule 重入保护）。
 */
export function isMaintenanceChatRunning(chatId: string): boolean {
  return getActiveChatRunId(chatId) !== undefined
}
