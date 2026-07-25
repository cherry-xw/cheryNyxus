/**
 * Tier 2 流程测试服务 harness：启动真实 WS+HTTP 服务（全 handler 注册 + disconnectGrace 配置），
 * 临时端口 + 固定 sessionToken（startService 内部生成但不返回，故显式注入）。
 *
 * 复用 test/flows/setup.ts 全局环境（CHERY_DIR=fixtures、binary transport、DB 清理）。
 * staticDir 取 CHERY_DIR（fixtures 目录，已存在），HTTP 静态服务对此目录无害。
 */
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startService, type ServiceHandle } from '@/service/index.js'
import { closeAllConnections } from '@/service/websocket/index.js'
import { bootstrapAgentRuntime } from '@/agent/bootstrap.js'
import { closeAllDbs } from '@/db/index.js'
import config from '@/utils/config.js'
import { RpcClient } from '../../helpers/rpcClient.js'

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
  config.global.db_dir = join(tmpdir(), `cheryclaw-flow-${process.pid}`)
  if (options?.disconnectGraceMs !== undefined) {
    config.global.disconnect_grace_ms = options.disconnectGraceMs
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
