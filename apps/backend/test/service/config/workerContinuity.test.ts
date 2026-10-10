import { fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import yaml from 'js-yaml'
import { expect, it } from 'vitest'
import { Method } from '@chery/protocol'
import { RpcClient } from '@test/helpers/rpcClient.js'
import type { RuntimeConfigSource } from '@/utils/config.js'
import type {
  ChatCreateResponseData,
  ChatEpochListResponseData,
  ChatInputSubmitResponseData,
  ChatTimelineGetResponseData,
  ConfigGetResponseData,
  ConfigSaveResponseData,
} from '@/service/message/types.js'

async function freePort(): Promise<number> {
  const server = createTcpServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as { port: number }).port
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
  return port
}

it('preserves a real worker and two sockets across a save during HTTP LLM streaming', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chery-worker-continuity-'))
  const requests: Array<{ url?: string; authorization?: string; body: Record<string, unknown> }> =
    []
  const streams: ServerResponse[] = []
  const provider = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    requests.push({
      url: request.url,
      authorization: request.headers.authorization,
      body: JSON.parse(body),
    })
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.write(
      `data: ${JSON.stringify({ id: 'controlled', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'before-save ' }, finish_reason: null }] })}\n\n`,
    )
    streams.push(response)
  })
  provider.listen(0, '127.0.0.1')
  await once(provider, 'listening')
  const providerPort = (provider.address() as { port: number }).port
  const wsPort = await freePort()
  const webPort = await freePort()
  cpSync(resolve('test/protocol-completeness/fixtures'), directory, { recursive: true })
  const configPath = join(directory, '.chery/config.yaml')
  const config = yaml.load(readFileSync(configPath, 'utf8')) as RuntimeConfigSource
  config.llm.brain.continuity = {
    provider: 'openai',
    model: 'controlled-model',
    key: 'test-old-key',
    url: `http://127.0.0.1:${providerPort}/v1`,
  }
  config.server = { host: '127.0.0.1', port: wsPort, webPort, serve_frontend: false }
  writeFileSync(configPath, yaml.dump(config))
  const child = fork(resolve('src/index.ts'), ['--worker'], {
    execArgv: ['--import', pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href],
    cwd: directory,
    env: {
      ...process.env,
      CHERY_DIR: directory,
      DB_DIR: join(directory, '.chery/db'),
      CHERY_TRANSPORT: 'json',
      NODE_ENV: 'test',
      TSX_TSCONFIG_PATH: resolve('tsconfig.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  })
  let output = ''
  child.stdout?.on('data', (chunk) => {
    output += chunk
  })
  child.stderr?.on('data', (chunk) => {
    output += chunk
  })
  const ipc: unknown[] = []
  child.on('message', (message) => ipc.push(message))
  const clients: RpcClient[] = []
  try {
    let sessionToken = ''
    await expect
      .poll(
        async () => {
          if (child.exitCode !== null) throw new Error(`worker exited: ${output}`)
          try {
            const response = await fetch(`http://127.0.0.1:${webPort}/api/config`)
            const data = (await response.json()) as { sessionToken?: string }
            sessionToken = data.sessionToken ?? ''
            return !!sessionToken
          } catch {
            return false
          }
        },
        { timeout: 15000 },
      )
      .toBe(true)
    for (let index = 0; index < 2; index++) {
      const client = new RpcClient({
        url: `ws://127.0.0.1:${wsPort}/?token=${sessionToken}`,
        origin: `http://127.0.0.1:${webPort}`,
      })
      await client.connect()
      clients.push(client)
    }
    const [client, other] = clients as [RpcClient, RpcClient]
    const initial = (await client.call(Method.CONFIG_GET, {})).data as ConfigGetResponseData
    const save = (candidate: ConfigGetResponseData, connection = client) => {
      const { baseRevision, ...raw } = candidate
      return connection.call(Method.CONFIG_SAVE, {
        protocolVersion: 2,
        requestId: randomUUID(),
        expectedBaseRevision: baseRevision,
        candidate: raw,
      })
    }
    const unchanged = await save(initial)
    expect(unchanged.success).toBe(true)
    const created = await client.call(Method.CHAT_CREATE, {
      brain: 'continuity',
      senseGroup: 'protocol_none',
      skipBlankReuse: true,
    })
    expect(created.success, JSON.stringify(created)).toBe(true)
    const { chatId } = created.data as ChatCreateResponseData
    await client.call(Method.CHAT_OPEN, { scope: 'chat', chatId })
    const input = () =>
      client.call(Method.CHAT_INPUT_SUBMIT, {
        chatId,
        commandId: randomUUID(),
        clientMessageId: randomUUID(),
        messageId: randomUUID(),
        content: 'controlled input',
      })
    const first = await input()
    expect(first.success, JSON.stringify(first)).toBe(true)
    const { runId } = first.data as ChatInputSubmitResponseData
    await expect.poll(() => streams.length, { timeout: 10000 }).toBe(1)
    await expect
      .poll(() =>
        client.received.some(
          (event) =>
            event.kind === 'chunk' &&
            event.runId === runId &&
            JSON.stringify(event.data).includes('before-save'),
        ),
      )
      .toBe(true)
    const epoch = (await client.call(Method.CHAT_EPOCH_LIST, { chatId }))
      .data as ChatEpochListResponseData
    const current = (await client.call(Method.CONFIG_GET, {})).data as ConfigGetResponseData
    current.llm.brain.continuity!.key = 'test-new-key'
    current.llm.brain.continuity!.url = `http://127.0.0.1:${providerPort}/next`
    const saved = await save(current)
    expect(saved.success, JSON.stringify(saved)).toBe(true)
    expect((saved.data as ConfigSaveResponseData).restart.required).toBe(false)
    const conflict = await save(initial, other)
    expect(conflict.success).toBe(false)
    expect(conflict.error?.message).toContain('baseRevision')
    expect(requests).toHaveLength(1)
    expect(requests[0]!.authorization).toBe('Bearer test-old-key')
    expect(child.exitCode).toBeNull()
    expect(ipc).not.toContainEqual(expect.objectContaining({ type: 'restart-ready' }))
    expect((await other.call(Method.CONFIG_GET, {})).success).toBe(true)
    await expect
      .poll(() => other.received.some((event) => event.type === 'config.apply.changed'))
      .toBe(true)
    const finish = (index: number) => {
      streams[index]!.end(
        `data: ${JSON.stringify({ id: 'controlled', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'after-save' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
      )
    }
    finish(0)
    await expect
      .poll(
        () => client.received.some((event) => event.type === 'done' && event.chatId === chatId),
        { timeout: 10000 },
      )
      .toBe(true)
    const timeline = (await client.call(Method.CHAT_TIMELINE_GET, { chatId }))
      .data as ChatTimelineGetResponseData
    expect(timeline.messages.filter((message) => message.role === 'user')).toHaveLength(1)
    expect(timeline.messages.filter((message) => message.role === 'assistant')).toHaveLength(1)
    expect(JSON.stringify(timeline.messages)).toContain('before-save after-save')
    const afterEpoch = (await client.call(Method.CHAT_EPOCH_LIST, { chatId }))
      .data as ChatEpochListResponseData
    expect(afterEpoch.activeEpochId).toBe(epoch.activeEpochId)
    expect(afterEpoch.epochs).toHaveLength(epoch.epochs.length)
    expect([
      ...new Set(
        client.received
          .filter((event) => event.kind === 'chunk' && event.chatId === chatId)
          .map((event) => event.runId),
      ),
    ]).toEqual([runId])
    expect((await input()).success).toBe(true)
    await expect.poll(() => streams.length, { timeout: 10000 }).toBe(2)
    expect(requests[1]!.authorization).toBe('Bearer test-new-key')
    expect(requests[1]!.url).toBe('/next/chat/completions')
    finish(1)
    await expect
      .poll(
        () =>
          client.received.filter((event) => event.type === 'done' && event.chatId === chatId)
            .length,
        { timeout: 10000 },
      )
      .toBe(2)
    expect(JSON.stringify(other.received)).not.toMatch(/test-old-key|test-new-key/)
    expect(output).not.toMatch(/test-old-key|test-new-key/)
    expect(child.exitCode).toBeNull()
    console.info(
      'worker-continuity evidence',
      JSON.stringify({
        pid: child.pid,
        runId,
        epochId: epoch.activeEpochId,
        connections: clients.length,
        providerRequests: requests.length,
        firstRunMessages: timeline.messages.length,
        restartReady: ipc.filter(
          (message) => (message as { type?: string }).type === 'restart-ready',
        ).length,
      }),
    )
  } finally {
    for (const client of clients) client.close()
    if (child.exitCode === null) {
      const exited = once(child, 'exit')
      child.send({ type: 'shutdown' })
      const timer = setTimeout(() => child.kill(), 8000)
      await exited
      clearTimeout(timer)
    }
    for (const stream of streams) stream.destroy()
    await new Promise<void>((resolveClose) => provider.close(() => resolveClose()))
    rmSync(directory, { recursive: true, force: true })
  }
}, 45000)
