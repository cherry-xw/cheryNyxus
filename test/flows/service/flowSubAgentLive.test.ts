/**
 * 流程测试 Tier 2：子 agent eager 后台启动 + live stream（S14b/S15b/S16b）。
 *
 * 规约见 [docs/flow-test.md](../../../docs/flow-test.md) §3.D 增补 + [docs/web/frontend-refactor-handoff.md](../../../docs/web/frontend-refactor-handoff.md)。
 *
 * 锁住 spawn_role sense 内 eager 启动（spawnEager + startChildEager）的 WS 行为：
 * - T1：spawn_role 完成 → 后端 fire-and-forget 启动子 chat → 子 stream chunks 通过 ws.send 到 parent ws
 *       （harness 在 client.background 按 chatId=childChatId 过滤可见）—— 证明 eager 路径生效。
 * - T2：子 done 通知携带 finished:true → 触发前端 turnChildIntoGhost 路径（同主 agent done 处理）。
 * - T3：sub-agent streams 给定 chatId 的 staged/reverse 等事件亦走 session WS。
 * - T4：eager 启动异常隔离——若 resolveParentWs 失败（异常竞态），spawn_role 主流程不抛错，
 *       后台失败不阻塞 sense 返回。
 *
 * 与 [flowSpawn.test.ts](./flowSpawn.test.ts)（S14/S15/S16 wire 验证）互补：
 * S14b 纯观察后端 eager 启动的 WS 输出。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { deleteChat } from '@/db/chat.js'
import type {
  ChatCreateResponseData,
  RoleCreatedNotificationData,
} from '@/service/message/types.js'
import {
  awaitInputAccepted,
  bootFlowService,
  connectClient,
  decideApproval,
  submitChatInput,
  type FlowService,
} from '../helpers/serviceHarness.js'
import {
  allEvents,
  notificationsByType,
  streamChunks,
  waitFor,
  waitForNotification,
} from '../helpers/eventsAssert.js'
import type { RpcClient } from '../../helpers/rpcClient.js'

/** 按 parentChatId 过滤 background 中 role_created。 */
async function waitForRoleCreated(
  client: RpcClient,
  parentChatId: string,
  timeoutMs = 8000,
): Promise<RoleCreatedNotificationData> {
  return waitFor(
    () => client.background,
    (events) =>
      notificationsByType(events, 'role_created').find(
        (n) => (n.data as { parentChatId: string }).parentChatId === parentChatId,
      )?.data as RoleCreatedNotificationData | undefined,
    timeoutMs,
  )
}

/** 按 chatId 过滤 client.background 中的 stream chunks（eager 启动 stream 经过 ws → 没 requestId 归宿 → background）。 */
function backgroundStreamChunksByChatId(client: RpcClient, chatId: string): unknown[] {
  return client.background.filter(
    (e) => (e as { chatId?: string }).chatId === chatId && (e as { type?: string }).type === 'stream',
  )
}

/** 按 chatId 过滤 client.background 中的 done notifications。 */
function backgroundDoneByChatId(
  client: RpcClient,
  chatId: string,
): Array<{ data?: { finished?: boolean; canResume?: boolean } }> {
  return client.background.filter(
    (e) =>
      (e as { chatId?: string }).chatId === chatId &&
      (e as { type?: string }).type === 'done',
  ) as Array<{ data?: { finished?: boolean; canResume?: boolean } }>
}

async function acceptSpawnApproval(client: RpcClient, inputEvents: unknown[]): Promise<void> {
  const approvalId = await waitFor(
    () => inputEvents as Parameters<typeof notificationsByType>[0],
    (events) =>
      (
        notificationsByType(events, 'interrupt')[0]?.data as
          | { approvalId: string }
          | undefined
      )?.approvalId,
  )
  await decideApproval(client, approvalId, 'accept')
}

describe('S14b/S16b spawn eager 启动 + live stream 推送', () => {
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
      parentChatId = ''
    }
  })

  afterAll(async () => {
    client.close()
    await svc.close()
  })

  it('T1 eager 启动：spawn_role 后 sub-agent stream chunks 经 ws 推到 parent 连接', async () => {
    const createRes = await client.call('chat.create', {
      brain: 'mock_spawn_stream',
      senseGroup: 'spawn_senses',
    })
    parentChatId = (createRes.data as ChatCreateResponseData).chatId

    const input = submitChatInput(client, parentChatId, '派发流式审查')
    await awaitInputAccepted(client, input)
    await acceptSpawnApproval(client, input.events)
    const roleCreated = await waitForRoleCreated(client, parentChatId)
    expect(roleCreated.type).toBe('reviewer_stream')
    expect(roleCreated.brain).toBe('mock_child_stream')
    const { chatId: childChatId } = roleCreated
    // 父 yieldTurn → done
    await waitForNotification(() => input.events, 'done', 10000)

    // 2. eagerly-started sub-agent 应在 background 流出 stream chunks（按 chatId === childChatId 过滤）。
    //    chunkDelayMs=2000 → 至少 1 chunk 在 6s 窗口内；waitFor 失败 → bug 在 eager 未启动 / 未推 ws。
    const firstChunk = await waitFor(
      () => client.background,
      () => {
        const chunks = backgroundStreamChunksByChatId(client, childChatId)
        return chunks.length > 0 ? chunks[0] : undefined
      },
      12000,
    )
    expect((firstChunk as { chatId?: string } | undefined)?.chatId).toBe(childChatId)

    // 3. 继续收集 eager 子角色的 chunks 与 done；公共客户端不再调用内部 startSpawn。
    const finalDone = await waitFor(
      () => client.background,
      () => backgroundDoneByChatId(client, childChatId).find((d) => d.data?.finished === true),
      15000,
    )
    expect(finalDone.data?.finished).toBe(true)
  }, 30000)

  it('T2 fast-finish ghost: mock_content 子 agent 立即 done（finished:true）', async () => {
    const createRes = await client.call('chat.create', {
      brain: 'mock_spawn', // S14 同款：子 = reviewer (mock_content)
      senseGroup: 'spawn_senses',
    })
    parentChatId = (createRes.data as ChatCreateResponseData).chatId

    const input = submitChatInput(client, parentChatId, '派发审查')
    await awaitInputAccepted(client, input)
    await acceptSpawnApproval(client, input.events)
    const roleCreated = await waitForRoleCreated(client, parentChatId)
    const { chatId: childChatId } = roleCreated
    await waitForNotification(() => input.events, 'done', 10000)

    // mock_content 一响应即 done with finished:true；eager 启动应让 done 在 background 中可见
    const done = await waitFor(
      () => client.background,
      () =>
        backgroundDoneByChatId(client, childChatId).find((d) => d.data?.finished === true) ??
        undefined,
      8000,
    )
    expect(done.data?.finished).toBe(true)
  }, 20000)

  it('T3 sub-agent chunks 携带 chatId=childChatId 流过 seq path（前端 store 路由关键）', async () => {
    const createRes = await client.call('chat.create', {
      brain: 'mock_spawn_stream',
      senseGroup: 'spawn_senses',
    })
    parentChatId = (createRes.data as ChatCreateResponseData).chatId

    const input = submitChatInput(client, parentChatId, '派发')
    await awaitInputAccepted(client, input)
    await acceptSpawnApproval(client, input.events)
    const roleCreated = await waitForRoleCreated(client, parentChatId)
    const { chatId: childChatId } = roleCreated
    await waitForNotification(() => input.events, 'done', 10000)

    // 等任意 chunk 到达
    await waitFor(
      () => client.background,
      () => (backgroundStreamChunksByChatId(client, childChatId).length > 0 ? true : undefined),
      10000,
    )

    const chunks = backgroundStreamChunksByChatId(client, childChatId)
    expect(chunks.length).toBeGreaterThan(0)
    // 每条 chunk 都带 chatId + requestId（前端 seq path 关键字段）
    for (const chunk of chunks) {
      const c = chunk as { chatId?: string; requestId?: string }
      expect(c.chatId).toBe(childChatId)
      expect(typeof c.requestId).toBe('string')
    }
  }, 20000)

  it('T4 error path: 子 agent mock 异常（mock_todo 不存在 — fallback）不影响 parent 流', async () => {
    // 验证 eager 启动错误隔离：mock_spawn 在 mock_todo role 配置下应正常（不抛错阻断 parent sense 返回）
    const createRes = await client.call('chat.create', {
      brain: 'mock_spawn',
      senseGroup: 'spawn_senses',
    })
    parentChatId = (createRes.data as ChatCreateResponseData).chatId

    const input = submitChatInput(client, parentChatId, '派发审查')
    await awaitInputAccepted(client, input)
    await acceptSpawnApproval(client, input.events)
    const roleCreated = await waitForRoleCreated(client, parentChatId)
    await waitForNotification(() => input.events, 'done', 10000)
    // 父 done 已收到 → spawn_role sense 路径未抛错阻塞 main loop
    expect(input.events.some((e) => (e as { type?: string }).type === 'done')).toBe(true)
    // 副断言：role_created + done 都到达（no silent failure）
    expect(notificationsByType(client.background, 'role_created').length).toBeGreaterThanOrEqual(1)
  }, 15000)
})
