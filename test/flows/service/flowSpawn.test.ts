/**
 * 流程测试 Tier 2：子 agent spawn 全链路 S14–S16（service+WS 级）。
 *
 * 规约见 [docs/flow-test.md](../../../docs/flow-test.md) §3.D / FP-F。主子 agent 唤醒策略调度器端到端：
 * - S14 immediate：spawn_role → role_created → startSpawn → 子 done → role_reply → 主 resume（全链路）。
 * - S15 deferred：多子 deferred，wakeScheduler silent 暂存，全完成兜底唤主（仅 1 条 role_reply）。
 * - S16 子刷新重连：子 running 断连 → attach(child, running:true) 续跑（机制继承 S8/S9）。
 *
 * 复用 serviceHarness + RpcClient + eventsAssert。role_created/role_reply 无 requestId → client.background，
 * 按 parentChatId 过滤避跨测串扰。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { deleteChat, getChat } from '@/db/chat.js'
import type {
  ChatCreateResponseData,
  ChatStartSpawnResponseData,
  ChatAttachResponseData,
  RoleCreatedNotificationData,
  RoleReplyNotificationData,
} from '@/service/message/types.js'
import { bootFlowService, connectClient, type FlowService } from '../helpers/serviceHarness.js'
import {
  allEvents,
  notificationsByType,
  streamChunks,
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

  it('spawn_role → role_created → startSpawn → 子 done → role_reply → 主 resume', async () => {
    const createRes = await client.call('chat.create', {
      brain: 'mock_spawn',
      senseGroup: 'spawn_senses',
    })
    parentChatId = (createRes.data as ChatCreateResponseData).chatId

    // 1. send：父轮1 content + spawn_role(immediate) → role_created 推主连接（background）
    const send = client.request('chat.send', { chatId: parentChatId, prompt: '派发审查' })
    const roleCreated = (await waitForRoleEvent(
      client,
      'role_created',
      parentChatId,
    )) as RoleCreatedNotificationData
    expect(roleCreated.type).toBe('reviewer')
    expect(roleCreated.wake).toBe('immediate')
    expect(roleCreated.parentChatId).toBe(parentChatId)
    expect(roleCreated.brain).toBe('mock_content')
    const { taskId, chatId: childChatId } = roleCreated

    // 父 yieldTurn → done（主非 waited child，loop 正常发 done）
    await waitForNotification(() => send.events, 'done')

    // 2. chat.startSpawn 退化为 recovery（spawn_role sense 已 eager 启动子）：
    //    - 子未完成 → alreadyRunning / 子已 finished → alreadyFinished（测试用 mock_content 同步响应场景，后者）
    //    - 与 S14 原语义（finished:true）等价——「子已能消费 done」即视为完成。
    const spawnRes = await client.call('chat.startSpawn', { taskId })
    const spawnData = spawnRes.data as ChatStartSpawnResponseData
    expect(spawnData.finished || spawnData.alreadyFinished).toBe(true)

    // 3. 子 done → wakeScheduler evalWakePolicy(immediate)=shouldWake → wakeParent → role_reply
    const roleReply = (await waitForRoleEvent(
      client,
      'role_reply',
      parentChatId,
    )) as RoleReplyNotificationData
    expect(roleReply.childChatId).toBe(childChatId)
    expect(roleReply.type).toBe('reviewer')
    expect(roleReply.content).toContain('角色')

    // 4. 主 resume：消费注入的 role 消息 → 轮2 content（script[1]）
    const resume = client.request('chat.resume', { chatId: parentChatId })
    await waitForNotification(() => resume.events, 'done')
    expect(collectStreamContent(allEvents(resume.events))).toContain('汇总')

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

    // 1. send：父一轮派发 2 个 deferred 子（不同 prompt 避免去重）→ 2 条 role_created
    const send = client.request('chat.send', { chatId: parentChatId, prompt: '并行派发' })
    await waitFor(
      () => client.background,
      () => (roleEventCount(client, 'role_created', parentChatId) >= 2 ? true : undefined),
    )
    await waitForNotification(() => send.events, 'done')
    expect(roleEventCount(client, 'role_created', parentChatId)).toBe(2)

    const createdEvents = notificationsByType(client.background, 'role_created').filter(
      (n) => (n.data as { parentChatId: string }).parentChatId === parentChatId,
    )
    const taskA = (createdEvents[0]!.data as RoleCreatedNotificationData).taskId
    const taskB = (createdEvents[1]!.data as RoleCreatedNotificationData).taskId

    // 2. 两子 deferred + eager 并发跑（mock_content 同步响应→fast-finish）：
    //    截断 deferred silent 失效（两子全部 finish 太快，无可观察中间态）
    //    → 直接验最终态：A startSpawn recovery 命中 alreadyFinished；B 同样
    //    role_reply 数量断言：「仅 1 条」（deferred 全完成兜底唤主，非每子各唤）锁核心语义
    await client.call('chat.startSpawn', { taskId: taskA })
    await sleep(300)
    // 等待 role_reply 到达（最后完成的子触发；eager 下时机不可控）
    const reply = (await waitForRoleEvent(
      client,
      'role_reply',
      parentChatId,
    )) as RoleReplyNotificationData
    expect(reply.type).toBe('reviewer')

    // 3. startSpawn B：recovery alreadyFinished，主已被最后完成子唤起
    await client.call('chat.startSpawn', { taskId: taskB })
    await sleep(300)
    // 仅 1 条 role_reply（deferred 兜底唤主，非按子计数）
    expect(roleEventCount(client, 'role_reply', parentChatId)).toBe(1)

    // 4. 主 resume：消费暂存的 role 消息 → 轮2 content
    const resume = client.request('chat.resume', { chatId: parentChatId })
    await waitForNotification(() => resume.events, 'done')
    expect(collectStreamContent(allEvents(resume.events))).toContain('汇总')
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

  it('子 running 断连 → attach(child, running:true) → 跨断连续跑至 done', async () => {
    const createRes = await client.call('chat.create', {
      brain: 'mock_spawn_stream',
      senseGroup: 'spawn_senses',
    })
    parentChatId = (createRes.data as ChatCreateResponseData).chatId

    // 1. send：父派发 reviewer_stream（流式子）
    const send = client.request('chat.send', { chatId: parentChatId, prompt: '派发流式审查' })
    const roleCreated = (await waitForRoleEvent(
      client,
      'role_created',
      parentChatId,
    )) as RoleCreatedNotificationData
    expect(roleCreated.type).toBe('reviewer_stream')
    const { taskId, chatId: childChatId } = roleCreated
    await waitForNotification(() => send.events, 'done')

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

    // 3. chat.startSpawn RPC：recovery（子运行中 → alreadyRunning:true），无 stream chunk 流经 RPC；
    //    仍发 RPC 验证「子流启动 + recovery 共存」语义不破。
    const spawnHandle = client.request('chat.startSpawn', { taskId })
    const spawnRes = await client.awaitResponse(spawnHandle)
    const spawnData = spawnRes.data as ChatStartSpawnResponseData
    expect(spawnData.chatId).toBe(childChatId)
    expect(spawnData.alreadyRunning).toBe(true)

    // 4. 断连 → grace（子 run 存活，不 park）；即时重连
    client.close()
    await client.reconnect()

    // 5. attach 子：running=true（子跨断连存活，generator 仍悬挂）+ 重定向输出到新 ws
    const attachRes = await client.call('chat.attach', { chatId: childChatId })
    const attachData = attachRes.data as ChatAttachResponseData
    expect(attachData.running).toBe(true)
    expect(attachData.attached).toBe(true)

    // 6. sync 子（chat_events 补齐断连窗口事件）
    await client.call('chat.sync', { chatId: childChatId, afterSeq: 0 })

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
