/**
 * Tier 2 流程测试服务 harness：启动真实 WS+HTTP 服务（全 handler 注册 + disconnectGrace 配置），
 * 临时端口 + 固定 sessionToken（startService 内部生成但不返回，故显式注入）。
 *
 * 复用 test/flows/setup.ts 全局环境（CHERY_DIR=fixtures、binary transport、DB 清理）。
 * staticDir 取 CHERY_DIR（fixtures 目录，已存在），HTTP 静态服务对此目录无害。
 */
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startService, type ServiceHandle } from '@/service/index.js'
import { closeAllConnections } from '@/service/websocket/index.js'
import { bootstrapAgentRuntime } from '@/agent/bootstrap.js'
import { closeAllDbs } from '@/db/index.js'
import config from '@/utils/config.js'
import type {
  ChatInputSubmitResponseData,
  InteractionApprovalDecideResponseData,
  InteractionListResponseData,
  ChatOpenResponseData,
  ChatTimelineGetResponseData,
} from '@/service/message/types.js'
import type { ChatRunResumeResponse } from '@chery/protocol'
import { RpcClient, type RequestHandle } from '../../helpers/rpcClient.js'

let runtimeBootstrapped = false

export interface FlowService {
  wsPort: number
  webPort: number
  token: string
  handle: ServiceHandle
  close(): Promise<void>
}

const require = createRequire(import.meta.url)

export interface BootFlowOptions {
  /**
   * 覆盖断连宽限期（config.global.disconnect_grace_ms）。S10 验「超 grace 释放」用短值
   * （真实 timer，免 fake timers 与异步 ws/grace 链路耦合）。startService 前设，全进程生效。
   */
  disconnectGraceMs?: number
  /** Canonical detached approvals use this business deadline independently of WebSocket ownership. */
  approvalTimeoutMs?: number
  /** Resource ceiling for unlimited approvals; reaching it parks the run as resumable. */
  approvalHardTimeoutMs?: number
}

export async function bootFlowService(options?: BootFlowOptions): Promise<FlowService> {
  // 注册 provider + 内置 senses（真实 app 入口顺序：bootstrap 先于 startService）。
  // vitest 每文件独立进程；registerBuiltinProviders 自带幂等守卫。
  if (!runtimeBootstrapped) {
    await bootstrapAgentRuntime()
    runtimeBootstrapped = true
  }
  // per-process 隔离 DB 目录：config.global.db_dir 改到临时目录（process.pid 唯一），
  // 避免多 Tier 2 文件并行跑时跨进程共享 fixtures DB 致 SQLITE_BUSY。
  // config.yaml/mock 仍读 CHERY_DIR(fixtures)，仅 DB 隔离；须在首次 DB 访问前设置。
  config.global.db_dir = join(tmpdir(), `cheryNyxus-flow-${process.pid}`)
  if (options?.disconnectGraceMs !== undefined) {
    config.global.disconnect_grace_ms = options.disconnectGraceMs
  }
  if (options?.approvalTimeoutMs !== undefined) {
    config.global.approval_timeout = options.approvalTimeoutMs
  }
  if (options?.approvalHardTimeoutMs !== undefined) {
    config.global.approval_hard_timeout = options.approvalHardTimeoutMs
  }
  const staticDir =
    process.env.CHERY_DIR ??
    require
      .resolve('../../test/flows/fixtures/.chery/config.yaml')
      .replace(/\/\.chery\/config\.yaml$/, '')
  const token = 'flow-test-token'
  const handle = startService({
    port: 0,
    webPort: 0,
    staticDir,
    sessionToken: token,
    host: '127.0.0.1',
  })

  // port:0 由 OS 分配；await 'listening' 拿实际端口（构造后同步挂监听器可捕获尚未完成的 listen）。
  await waitForListening(handle)
  const wsPort = addressedPort(handle.wss.address())
  const webPort = addressedPort(handle.httpServer.address())

  return {
    wsPort,
    webPort,
    token,
    handle,
    close: async () => {
      closeAllConnections(handle.wss)
      await new Promise<void>((resolve) => {
        handle.wss.close(() => resolve())
      })
      await new Promise<void>((resolve) => {
        handle.httpServer.close(() => resolve())
      })
      closeAllDbs()
    },
  }
}

/** 建立已连接的 RpcClient（url 带 token、Origin 落入 allowedOrigins）。 */
export async function connectClient(svc: FlowService): Promise<RpcClient> {
  const client = new RpcClient({
    url: `ws://127.0.0.1:${svc.wsPort}/?token=${svc.token}`,
    origin: `http://127.0.0.1:${svc.webPort}`,
  })
  await client.connect()
  return client
}

/** Submit user input through the canonical command plane. */
export function submitChatInput(
  client: RpcClient,
  chatId: string,
  content: string,
): RequestHandle {
  return client.request('chat.input.submit', {
    chatId,
    commandId: randomUUID(),
    clientMessageId: randomUUID(),
    messageId: randomUUID(),
    content,
  })
}

/** Resume a paused run through the canonical command plane. */
export function resumeChatRun(client: RpcClient, chatId: string): RequestHandle {
  return client.request('chat.run.resume', { chatId, commandId: randomUUID() })
}

/** Atomically open a direct-chat subscription and hydrate its transient state. */
export async function openChat(client: RpcClient, chatId: string): Promise<ChatOpenResponseData> {
  return requireResponseData<ChatOpenResponseData>(
    await client.call('chat.open', { scope: 'chat', chatId }),
    'chat.open',
  )
}

/** Read the canonical, retention-independent message timeline. */
export async function getChatTimeline(
  client: RpcClient,
  chatId: string,
  knownRevision?: number,
): Promise<ChatTimelineGetResponseData> {
  return requireResponseData<ChatTimelineGetResponseData>(
    await client.call('chat.timeline.get', {
      chatId,
      ...(knownRevision === undefined ? {} : { knownRevision }),
    }),
    'chat.timeline.get',
  )
}

/** Decode the immediate ACK while keeping the request handle for live events. */
export async function awaitInputAccepted(
  client: RpcClient,
  handle: RequestHandle,
): Promise<ChatInputSubmitResponseData> {
  return requireResponseData<ChatInputSubmitResponseData>(
    await client.awaitResponse(handle),
    'chat.input.submit',
  )
}

/** Decode a canonical resume ACK while keeping the handle for live events. */
export async function awaitResumeStarted(
  client: RpcClient,
  handle: RequestHandle,
): Promise<ChatRunResumeResponse> {
  return requireResponseData<ChatRunResumeResponse>(
    await client.awaitResponse(handle),
    'chat.run.resume',
  )
}

/** Resolve a durable approval through the canonical interaction command plane. */
export async function decideApproval(
  client: RpcClient,
  interactionId: string,
  action: 'accept' | 'reject',
  reason?: string,
): Promise<InteractionApprovalDecideResponseData> {
  const listed = requireResponseData<InteractionListResponseData>(
    await client.call('interaction.list', {}),
    'interaction.list',
  )
  const interaction = listed.interactions.find((item) => item.interactionId === interactionId)
  if (!interaction) throw new Error(`approval interaction not found: ${interactionId}`)
  return requireResponseData<InteractionApprovalDecideResponseData>(
    await client.call('interaction.approval.decide', {
      interactionId,
      action,
      expectedRevision: interaction.revision,
      commandId: randomUUID(),
      ...(reason === undefined ? {} : { reason }),
    }),
    'interaction.approval.decide',
  )
}

function requireResponseData<T>(
  response: { success: boolean; data?: unknown; error?: unknown },
  method: string,
): T {
  if (!response.success) throw new Error(`${method} failed: ${JSON.stringify(response.error)}`)
  return response.data as T
}

function waitForListening(handle: ServiceHandle): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let remaining = 2
    const done = (err?: Error) => {
      if (err) reject(err)
      else if (--remaining === 0) resolve()
    }
    // wss（ws 库）的 listening 由内部 http server 触发
    handle.wss.on('listening', () => done())
    handle.wss.on('error', done)
    if (handle.httpServer.listening) done()
    else {
      handle.httpServer.once('listening', () => done())
      handle.httpServer.once('error', done)
    }
  })
}

function addressedPort(addr: { port?: number } | string | null): number {
  if (addr && typeof addr === 'object' && typeof addr.port === 'number') return addr.port
  throw new Error('server not bound to a port')
}
