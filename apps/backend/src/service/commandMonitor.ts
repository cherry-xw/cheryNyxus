import { randomUUID } from 'node:crypto'
import type { AgentCommandMethodMap, AgentCommandRecord } from '@chery/protocol'
import { getChat, getRootChatId } from '@/db/chat.js'
import { safeJsonParse } from '@/utils/json.js'
import { getCommandRuntime } from './commands.js'
import type { CommandRuntime, CommandRuntimeEvent } from './commandRuntime.js'
import { Method, createNotification } from './message/types.js'
import type { HandlerContext, RpcRouter } from './message/router.js'
import { connectionManager } from './websocket/connection.js'
import { transport } from './websocket/transport.js'

type ListInput = AgentCommandMethodMap['agent.command.list']['params']
type SubscribeInput = AgentCommandMethodMap['agent.command.subscribe']['params']
interface Subscriber { connectionId: string; ownerId: string; filter: SubscribeInput }
const denied = () => Object.assign(new Error('无权访问此命令或会话'), { code: 'CAPABILITY_DENIED' })

/** Session ownership is rechecked for every request and every pushed event. No implicit owner claim. */
export class CommandMonitor {
  private readonly subscriptions = new Map<string, Subscriber>()
  private readonly detach: () => void
  private readonly detachConnections: () => void

  constructor(readonly runtime: CommandRuntime) {
    this.detach = runtime.subscribe((event) => this.push(event))
    this.detachConnections = connectionManager.onClose((connectionId) => {
      for (const [id, subscription] of this.subscriptions) if (subscription.connectionId === connectionId) this.subscriptions.delete(id)
    })
  }

  private owner(ctx: HandlerContext): string {
    if (!ctx.authenticatedUserId || (ctx.credentialKind && ctx.credentialKind !== 'control')) throw denied()
    return ctx.authenticatedUserId
  }

  private authorized(chatId: string, ownerId: string): boolean {
    if (!getChat(chatId)) return false
    const root = getChat(getRootChatId(chatId))
    const metadata = safeJsonParse<{ fileOwnerId?: string }>(root?.metadata ?? '{}', {})
    return metadata.fileOwnerId === ownerId
  }

  private matches(record: AgentCommandRecord, filter: SubscribeInput): boolean {
    if (filter.commandId) return record.commandId === filter.commandId
    if (!filter.chatId || record.chatId === filter.chatId) return true
    if (!filter.includeChildren) return false
    let chat = getChat(record.chatId)
    const seen = new Set<string>()
    while (chat?.parent_chat_id && !seen.has(chat.id)) {
      if (chat.parent_chat_id === filter.chatId) return true
      seen.add(chat.id)
      chat = getChat(chat.parent_chat_id)
    }
    return false
  }

  get(ctx: HandlerContext, commandId: string): AgentCommandRecord {
    const ownerId = this.owner(ctx)
    const command = this.runtime.get(commandId)
    if (!command || !this.authorized(command.chatId, ownerId)) throw denied()
    return command
  }

  list(ctx: HandlerContext, input: ListInput): AgentCommandMethodMap['agent.command.list']['result'] {
    const ownerId = this.owner(ctx)
    if (input.chatId && !this.authorized(input.chatId, ownerId)) throw denied()
    const limit = input.limit ?? 50
    const scope = input.scope ?? 'active'
    const stored = this.runtime.repository.list({ ...input, ownerId, limit: limit + 1,
      activeOnly: scope === 'active', historyOnly: scope === 'history' })
    const eligible = (record: AgentCommandRecord) => this.authorized(record.chatId, ownerId) && this.matches(record, input) &&
      (scope === 'all' || (record.endedAt === null) === (scope === 'active')) && (!input.before ||
        record.startedAt < input.before.startedAt || (record.startedAt === input.before.startedAt && record.commandId < input.before.commandId))
    const byId = new Map(stored.map((record) => [record.commandId, record]))
    for (const record of this.runtime.liveRecords()) if (eligible(record)) byId.set(record.commandId, record)
    const ordered = [...byId.values()].filter(eligible).sort((a, b) =>
      b.startedAt - a.startedAt || (a.commandId < b.commandId ? 1 : a.commandId > b.commandId ? -1 : 0))
    const commands = ordered.slice(0, limit)
    const last = commands.at(-1)
    return { commands, nextCursor: ordered.length > limit && last ? { startedAt: last.startedAt, commandId: last.commandId } : null }
  }

  async logs(ctx: HandlerContext, input: AgentCommandMethodMap['agent.command.logs.read']['params']) {
    this.get(ctx, input.commandId)
    const page = await this.runtime.logs.read(input.commandId, input)
    // Decompression yields; an ownership change during the read must not leak the page.
    this.get(ctx, input.commandId)
    return page
  }

  async stop(ctx: HandlerContext, commandId: string) {
    this.get(ctx, commandId)
    const accepted = await this.runtime.cancel(commandId)
    return { accepted, command: this.get(ctx, commandId) }
  }

  subscribe(ctx: HandlerContext, filter: SubscribeInput) {
    const ownerId = this.owner(ctx)
    if (filter.commandId) this.get(ctx, filter.commandId)
    if (filter.chatId && !this.authorized(filter.chatId, ownerId)) throw denied()
    if ([...this.subscriptions.values()].filter((item) => item.connectionId === ctx.connectionId).length >= 32)
      throw Object.assign(new Error('打开的命令订阅过多，请关闭部分窗口'), { code: 'CONFLICT' })
    const subscriptionId = randomUUID()
    this.subscriptions.set(subscriptionId, { connectionId: ctx.connectionId, ownerId, filter: { ...filter } })
    return { subscriptionId }
  }

  unsubscribe(ctx: HandlerContext, subscriptionId: string) {
    this.owner(ctx)
    const entry = this.subscriptions.get(subscriptionId)
    const removed = entry?.connectionId === ctx.connectionId && this.subscriptions.delete(subscriptionId)
    return { removed: Boolean(removed) }
  }

  private push(event: CommandRuntimeEvent): void {
    const command = event.type === 'agent.command.updated' ? event.command : this.runtime.get(event.chunk.commandId)
    if (!command) return
    for (const [subscriptionId, entry] of this.subscriptions) {
      try {
        if (!this.authorized(command.chatId, entry.ownerId) || !this.matches(command, entry.filter)) continue
        if (event.type === 'agent.command.log.chunk' && entry.filter.commandId !== command.commandId) continue
        const connection = connectionManager.getAll().find((state) => state.id === entry.connectionId)
        if (connection?.authenticatedUserId !== entry.ownerId || connection.credentialKind !== 'control') {
          this.subscriptions.delete(subscriptionId)
          continue
        }
        const ws = connection.ws
        if (!ws || ws.readyState !== 1) { this.subscriptions.delete(subscriptionId); continue }
        // Do not retain an unbounded log queue for a slow viewer. Its next read uses the persisted cursor.
        if (ws.bufferedAmount > 1024 * 1024) { ws.close(1013, '命令日志接收过慢，请重新连接后补读'); continue }
        ws.send(transport.serializeMessage(createNotification(event.type, undefined,
          event.type === 'agent.command.updated' ? { subscriptionId, command } : { subscriptionId, chunk: event.chunk },
          { chatId: command.chatId, ...(command.runId ? { runId: command.runId } : {}) })))
      } catch { /* A viewer or database error must not interrupt the command output callback. */ }
    }
  }

  dispose(): void { this.detach(); this.detachConnections(); this.subscriptions.clear() }
}

export function registerCommandMonitorHandlers(router: RpcRouter): void {
  // Allocate the command runtime lazily: router assembly must not bootstrap the database or recover executions.
  let monitor: CommandMonitor | undefined
  const service = () => monitor ??= new CommandMonitor(getCommandRuntime())
  router.register(Method.AGENT_COMMAND_LIST, async (ctx, input) => service().list(ctx, input))
  router.register(Method.AGENT_COMMAND_GET, async (ctx, input) => ({ command: service().get(ctx, input.commandId) }))
  router.register(Method.AGENT_COMMAND_LOGS_READ, (ctx, input) => service().logs(ctx, input))
  router.register(Method.AGENT_COMMAND_STOP, (ctx, input) => service().stop(ctx, input.commandId))
  router.register(Method.AGENT_COMMAND_SUBSCRIBE, async (ctx, input) => service().subscribe(ctx, input))
  router.register(Method.AGENT_COMMAND_UNSUBSCRIBE, async (ctx, input) => service().unsubscribe(ctx, input.subscriptionId))
}
