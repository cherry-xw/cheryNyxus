/**
 * 流程测试 Tier 2：子 agent spawn 全链路 S14–S16（service+WS 级）。
 *
 * 规约见 [docs/flow-test.md](../../../docs/flow-test.md) §3.D / FP-F。主子 agent 唤醒策略调度器端到端：
 * - S14 immediate：spawn_role → role_created → eager 子 done → role_reply → 主 canonical resume。
 * - S15 deferred：多子 deferred，wakeScheduler silent 暂存，全完成兜底唤主（仅 1 条 role_reply）。
 * - S16 子刷新重连：子 running 断连 → open(child) 续跑（机制继承 S8/S9）。
 *
 * 复用 serviceHarness + RpcClient + eventsAssert。role_created/role_reply 无 requestId → client.background，
 * 按 parentChatId 过滤避跨测串扰。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { deleteChat, getChat } from '@/db/chat.js'
import type {
  ChatCreateResponseData,
  RoleCreatedNotificationData,
  RoleReplyNotificationData,
} from '@/service/message/types.js'
import {
  awaitInputAccepted,
  awaitResumeStarted,
  bootFlowService,
  connectClient,
  decideApproval,
  openChat,
  resumeChatRun,
  submitChatInput,
  type FlowService,
} from '../helpers/serviceHarness.js'
import {
  notificationsByType,
  collectStreamContent,
  waitFor,
  waitForNotification,
} from '../helpers/eventsAssert.js'
import type { RpcClient } from '../../helpers/rpcClient.js'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 按 parentChatId 过滤 background 中的 role_created/role_reply（避跨测 stale 串扰）。 */
async function waitForRoleEvent(
  client: RpcClient,
  type: 'role_created' | 'role_reply',
  parentChatId: string,
  timeoutMs = 8000,
): Promise<RoleCreatedNotificationData | RoleReplyNotificationData> {
  return waitFor(
    () => client.background,
    (events) =>
      notificationsByType(events, type).find(
        (n) => (n.data as { parentChatId: string }).parentChatId === parentChatId,
      )?.data as RoleCreatedNotificationData | RoleReplyNotificationData | undefined,
    timeoutMs,
  )
}

/** 该 parent 的某类 role 事件计数（background 过滤）。 */
function roleEventCount(
  client: RpcClient,
  type: 'role_created' | 'role_reply',
  parentChatId: string,
): number {
  return notificationsByType(client.background, type).filter(
    (n) => (n.data as { parentChatId: string }).parentChatId === parentChatId,
  ).length
}

function chatEventsSince(client: RpcClient, start: number, chatId: string) {
  return client.received
    .slice(start)
    .filter((event) => (event as { chatId?: string }).chatId === chatId)
}

async function acceptSpawnApprovals(
  client: RpcClient,
  inputEvents: Parameters<typeof notificationsByType>[0],
  count = 1,
): Promise<void> {
  const approvalIds = await waitFor(
    () => inputEvents,
    (events) => {
      const ids = notificationsByType(events, 'interrupt').map(
        (event) => (event.data as { approvalId: string }).approvalId,
      )
      return ids.length >= count ? ids.slice(0, count) : undefined
    },
  )
  for (const approvalId of approvalIds) await decideApproval(client, approvalId, 'accept')
}

describe('S14 spawn immediate 全链路', () => {
  let svc: FlowService
  let client: RpcClient
  let parentChatId: string

  beforeAll(async () => {
    svc = await bootFlowService()
    client = await connectClient(svc)
  })

  afterEach(async () => {
    if (parentChatId) {
      try {
        deleteChat(parentChatId)
      } catch {
        /* chat may already be gone */
      }
    }
  })

  afterAll(async () => {
    client.close()
    await svc.close()
  })

  it('spawn_role → role_created → eager 子 done → role_reply → 主 resume', async () => {
    const createRes = await client.call('chat.create', {
      brain: 'mock_spawn',
      senseGroup: 'spawn_senses',
    })
    parentChatId = (createRes.data as ChatCreateResponseData).chatId

    const input = submitChatInput(client, parentChatId, '派发审查')
    await awaitInputAccepted(client, input)
    await acceptSpawnApprovals(client, input.events)
    const roleCreated = (await waitForRoleEvent(
      client,
      'role_created',
      parentChatId,
    )) as RoleCreatedNotificationData
    expect(roleCreated.type).toBe('reviewer')
    expect(roleCreated.wake).toBe('immediate')
    expect(roleCreated.parentChatId).toBe(parentChatId)
    expect(roleCreated.brain).toBe('mock_content')
    const { chatId: childChatId } = roleCreated

    // 父 yieldTurn → done（主非 waited child，loop 正常发 done）
    await waitForNotification(() => input.events, 'done')

    // 2. 子由 spawn_role 后端 eager 启动；done 后 wakeScheduler 唤醒主会话。
    const roleReply = (await waitForRoleEvent(
      client,
      'role_reply',
      parentChatId,
    )) as RoleReplyNotificationData
    expect(roleReply.childChatId).toBe(childChatId)
    expect(roleReply.type).toBe('reviewer')
    expect(roleReply.content).toContain('角色')

    // 4. 主 resume：消费注入的 role 消息 → 轮2 content（script[1]）
    const resumeStart = client.received.length
    const resume = resumeChatRun(client, parentChatId)
    await awaitResumeStarted(client, resume)
    await waitForNotification(() => chatEventsSince(client, resumeStart, parentChatId), 'done')
    expect(collectStreamContent(chatEventsSince(client, resumeStart, parentChatId))).toContain('汇总')
    client.release(resume)

    // 5. DB：子 chat finished + parent_chat_id 关联
    const childRow = getChat(childChatId)
    expect(childRow?.parent_chat_id).toBe(parentChatId)
    expect(JSON.parse(childRow!.metadata!).finished).toBe(true)
  }, 20000)
})

describe('S15 spawn deferred 静默批量唤主', () => {
  let svc: FlowService
  let client: RpcClient
  let parentChatId: string

  beforeAll(async () => {
    svc = await bootFlowService()
    client = await connectClient(svc)
  })

  afterEach(async () => {
    if (parentChatId) {
      try {
        deleteChat(parentChatId)
      } catch {
        /* chat may already be gone */
      }
    }
  })

  afterAll(async () => {
    client.close()
    await svc.close()
  })

  it('2 子 deferred：首子 silent 不唤主，全完成仅 1 条 role_reply', async () => {
    const createRes = await client.call('chat.create', {
      brain: 'mock_spawn_deferred',
      senseGroup: 'spawn_senses',
    })
    parentChatId = (createRes.data as ChatCreateResponseData).chatId

    const input = submitChatInput(client, parentChatId, '并行派发')
    await awaitInputAccepted(client, input)
    await acceptSpawnApprovals(client, input.events, 2)
    await waitFor(
      () => client.background,
      () => (roleEventCount(client, 'role_created', parentChatId) >= 2 ? true : undefined),
    )
    await waitForNotification(() => input.events, 'done')
    expect(roleEventCount(client, 'role_created', parentChatId)).toBe(2)

    // 2. 两子 deferred 由后端 eager 并发执行；全部完成时只允许一个兜底唤醒。
    const reply = (await waitForRoleEvent(
      client,
      'role_reply',
      parentChatId,
    )) as RoleReplyNotificationData
    expect(reply.type).toBe('reviewer_stream')

    await sleep(300)
    // 仅 1 条 role_reply（deferred 兜底唤主，非按子计数）
    expect(roleEventCount(client, 'role_reply', parentChatId)).toBe(1)

    // 4. 主 resume：消费暂存的 role 消息 → 轮2 content
    const resumeStart = client.received.length
    const resume = resumeChatRun(client, parentChatId)
    await awaitResumeStarted(client, resume)
    await waitForNotification(() => chatEventsSince(client, resumeStart, parentChatId), 'done')
    expect(collectStreamContent(chatEventsSince(client, resumeStart, parentChatId))).toContain('汇总')
    client.release(resume)
  }, 25000)
})

describe('S16 子 agent 刷新重连（机制继承 S8/S9）', () => {
  let svc: FlowService
  let client: RpcClient
  let parentChatId: string

  beforeAll(async () => {
    svc = await bootFlowService()
    client = await connectClient(svc)
  })

  afterEach(async () => {
    if (parentChatId) {
      try {
        deleteChat(parentChatId)
      } catch {
        /* chat may already be gone */
      }
    }
  })

  afterAll(async () => {
    client.close()
    await svc.close()
  })

  it('子 running 断连 → open(child) 恢复运行态 → 跨断连续跑至 done', async () => {
    const createRes = await client.call('chat.create', {
      brain: 'mock_spawn_stream',
      senseGroup: 'spawn_senses',
    })
    parentChatId = (createRes.data as ChatCreateResponseData).chatId

    const input = submitChatInput(client, parentChatId, '派发流式审查')
    await awaitInputAccepted(client, input)
    await acceptSpawnApprovals(client, input.events)
    const roleCreated = (await waitForRoleEvent(
      client,
      'role_created',
      parentChatId,
    )) as RoleCreatedNotificationData
    expect(roleCreated.type).toBe('reviewer_stream')
    const { chatId: childChatId } = roleCreated
    await waitForNotification(() => input.events, 'done')

    // 2. eager 已启动子 → 子 stream chunks 经 ws 推到 parent 连接；
    //    requestId=eager-{taskId} → harness 路由到 client.background（pending 不匹配）。
    //    等首个 stream chunk（chunkDelayMs=2000 拉长）证子 running + 已过 ws。
    await waitFor(
      () => client.background,
      (events) => {
        const childChunks = events.filter(
          (e) =>
            (e as { chatId?: string }).chatId === childChatId &&
            (e as { type?: string }).type === 'stream',
        )
        return childChunks.length > 0 ? true : undefined
      },
      10000,
    )

    // 3. 断连；eager 子 run 存活，随后即时重连。
    client.close()
    await client.reconnect()

    const opened = await openChat(client, childChatId)
    expect(opened.state.run?.state).toBe('running')
    expect(opened.state.activeTurns.length).toBeGreaterThan(0)

    // 7. 余下 stream chunk + done 经 liveOutput 到新 ws；子端终态可能不显式 done notification
    //    （runner 已 fast-finish mock_content mock_child_stream）→ 验 chat 内容+1 条 done 通知
    await waitFor(
      () => client.background,
      (events) =>
        events.some(
          (e) =>
            (e as { chatId?: string }).chatId === childChatId &&
            (e as { type?: string }).type === 'done',
        )
          ? true
          : undefined,
      12000,
    )
    // 子端已累计 chunk 数 >= 1
    const childStreamChunks = client.background.filter(
      (e) =>
        (e as { chatId?: string }).chatId === childChatId &&
        (e as { type?: string }).type === 'stream',
    )
    expect(childStreamChunks.length).toBeGreaterThan(0)
  }, 30000)
})
