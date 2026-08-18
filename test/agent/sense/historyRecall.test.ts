/**
 * history_recall sense 单元测试。
 *
 * 覆盖：
 * - sense 定义：name / supervision=auto（只读惯例）
 * - 缺 chatId / 无 compact 历史 / search 缺 query → 友好错误
 * - list_generations：代际目录（index / trigger / 摘要 / 当前代提示）
 * - search：命中片段（角色 + 上下文 + 代 index）/ generation 限定 / role 过滤 / limit /
 *   当前代消息默认不检 / generation 不存在 / 未命中
 * - 硬字符上限：超限截断 + 显式注明
 * - 数据源含后代 chat 消息
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { addMessage, createChat, deleteChat, getChat } from '@/db/chat.js'
import { buildRootTimeline } from '@/service/chat/handler.js'
import config from '@/utils/config'
import historyRecallSense from '@/agent/sense/historyRecall.js'
import { SupervisionLevel } from '@/core/config.js'

const exec = historyRecallSense.executor.execute.bind(historyRecallSense.executor)
const sharedData = new Map<string, Map<string, unknown>>()

const chats: string[] = []

afterEach(() => {
  for (const chatId of chats.splice(0).reverse()) if (getChat(chatId)) deleteChat(chatId)
  // 恢复输出上限默认（截断用例会临时调小）
  config.global.history_recall = { max_output_chars: 4000 }
})

function newRootChat(): string {
  const rootChatId = randomUUID()
  chats.push(rootChatId)
  createChat(rootChatId, {
    runtime: { brain: 'mock_content', senseGroup: 'auto_senses', mcpServers: [] },
  })
  return rootChatId
}

/** 两段 compact + 当前代：u1/a1 | u2/a2(摘要) | u3/a3 | u4/a4(摘要) | u5/a5。
 * 分段 sleep 确保各代边界 created_at 严格递增（computeGenerations/search 按时间窗判定，避免同毫秒竞态）。 */
async function seedTwoGenerationChat(rootChatId: string): Promise<void> {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  addMessage('h01-u1', rootChatId, { role: 'user', content: '第一轮：部署方案选型' })
  addMessage('h02-a1', rootChatId, { role: 'assistant', content: '第一轮回答：选 k8s' })
  addMessage('h03-u2', rootChatId, { role: 'user', content: '[[command:/compact]]\n\n继续' })
  await sleep(5)
  addMessage('h04-a2', rootChatId, {
    role: 'assistant',
    content: '<summary>第一段摘要</summary> 分析过程略',
    contextCompaction: true,
  })
  await sleep(5)
  addMessage('h05-u3', rootChatId, { role: 'user', content: '第三轮：成本核算' })
  addMessage('h06-a3', rootChatId, { role: 'assistant', content: '第三轮回答：月度 2 万' })
  addMessage('h07-u4', rootChatId, { role: 'user', content: '[[command:/compact]]\n\n再来' })
  await sleep(5)
  addMessage('h08-a4', rootChatId, {
    role: 'assistant',
    content: '<summary>第二段摘要</summary> 分析过程略',
    contextCompaction: true,
  })
  await sleep(5)
  addMessage('h09-u5', rootChatId, { role: 'user', content: '当前代：收尾' })
  addMessage('h10-a5', rootChatId, { role: 'assistant', content: '当前代回答' })
}

function ready(chatId: string): void {
  // computeGenerations 依赖 execution_nodes（buildRootTimeline 懒回填）
  buildRootTimeline(chatId, 'conversation')
}

describe('history_recall sense 定义', () => {
  it('name = history_recall', () => {
    expect(historyRecallSense.definition.function.name).toBe('history_recall')
  })

  it('supervision = auto（只读惯例，smart 档自动放行）', () => {
    expect(historyRecallSense.supervisionLevel).toBe(SupervisionLevel.auto)
  })
})

describe('history_recall 输入与前置校验', () => {
  it('缺 chatId → 友好错误', async () => {
    const r = await exec({ action: 'list_generations' }, sharedData)
    expect(r.content).toContain('错误')
  })

  it('无 compact 历史 → 提示无需检索', async () => {
    const chatId = newRootChat()
    ready(chatId)
    const r = await exec({ action: 'list_generations' }, sharedData, { chatId })
    expect(r.content).toContain('还没有已定稿的压缩代际')
  })

  it('search 缺 query → 友好错误', async () => {
    const chatId = newRootChat()
    await seedTwoGenerationChat(chatId)
    ready(chatId)
    const r = await exec({ action: 'search' }, sharedData, { chatId })
    expect(r.content).toContain('query')
  })
})

describe('history_recall list_generations', () => {
  it('两代目录：index / trigger / 摘要 / 当前代提示', async () => {
    const chatId = newRootChat()
    await seedTwoGenerationChat(chatId)
    ready(chatId)
    const r = await exec({ action: 'list_generations' }, sharedData, { chatId })
    expect(r.content).toContain('共 2 个已定稿代际')
    expect(r.content).toMatch(/第1代 \[手动\]/)
    expect(r.content).toMatch(/第2代 \[手动\]/)
    expect(r.content).toContain('第一段摘要')
    expect(r.content).toContain('第二段摘要')
    expect(r.content).toContain('当前代（第 3 代）')
  })
})

describe('history_recall search', () => {
  it('命中：代 index + 角色 + 上下文片段', async () => {
    const chatId = newRootChat()
    await seedTwoGenerationChat(chatId)
    ready(chatId)
    const r = await exec({ action: 'search', query: '部署' }, sharedData, { chatId })
    expect(r.content).toContain('命中 1 条')
    expect(r.content).toContain('[第1代] user')
    expect(r.content).toContain('部署方案选型')
  })

  it('generation 限定：只查该代', async () => {
    const chatId = newRootChat()
    await seedTwoGenerationChat(chatId)
    ready(chatId)
    const r = await exec({ action: 'search', query: '轮', generation: 2 }, sharedData, { chatId })
    expect(r.content).toContain('成本核算')
    expect(r.content).not.toContain('部署方案选型')
  })

  it('generation 不存在 → 友好错误并列有效范围', async () => {
    const chatId = newRootChat()
    await seedTwoGenerationChat(chatId)
    ready(chatId)
    const r = await exec({ action: 'search', query: 'x', generation: 9 }, sharedData, { chatId })
    expect(r.content).toContain('代际 9 不存在')
    expect(r.content).toContain('第 1 ~ 2 代')
  })

  it('role 过滤：只命中指定角色', async () => {
    const chatId = newRootChat()
    await seedTwoGenerationChat(chatId)
    ready(chatId)
    const r = await exec({ action: 'search', query: '轮', role: 'assistant' }, sharedData, {
      chatId,
    })
    expect(r.content).toContain('第一轮回答')
    expect(r.content).not.toContain('第一轮：部署')
  })

  it('当前代消息默认不在检索范围（未命中提示）', async () => {
    const chatId = newRootChat()
    await seedTwoGenerationChat(chatId)
    ready(chatId)
    const r = await exec({ action: 'search', query: '收尾' }, sharedData, { chatId })
    expect(r.content).toContain('未找到')
  })

  it('后代 chat 消息计入数据源', async () => {
    const rootChatId = newRootChat()
    addMessage('c01-u1', rootChatId, { role: 'user', content: '第一轮' })
    // 子消息先落库、compact 边界后落库 → 子消息 createdAt 必然落在第 1 代窗口内（避免同毫秒竞态）
    const childChatId = randomUUID()
    chats.push(childChatId)
    createChat(childChatId, { type: 'worker' }, rootChatId)
    addMessage('c03-r1', childChatId, { role: 'role', content: '子角色回复：审查通过' })
    addMessage('c02-a1', rootChatId, {
      role: 'assistant',
      content: '<summary>子任务摘要</summary>',
      contextCompaction: true,
    })
    ready(rootChatId)
    const r = await exec({ action: 'search', query: '审查通过' }, sharedData, {
      chatId: rootChatId,
    })
    expect(r.content).toContain('[第1代] role')
    expect(r.content).toContain('审查通过')
  })

  it('硬字符上限：超限截断并显式注明', async () => {
    const chatId = newRootChat()
    await seedTwoGenerationChat(chatId)
    ready(chatId)
    config.global.history_recall = { max_output_chars: 120 }
    const r = await exec({ action: 'search', query: '轮' }, sharedData, { chatId })
    expect(r.content.length).toBeLessThanOrEqual(120)
    expect(r.content).toContain('已截断')
    expect(r.content).toContain('缩小 query')
  })
})
