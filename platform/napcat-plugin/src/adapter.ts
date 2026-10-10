import fs from 'node:fs'
import path from 'node:path'
import {
  QQCapabilities,
  QQHelloResponseSchema,
  QQIdentityBindResponseSchema,
  QQRecoverResponseSchema,
} from '@chery/protocol'
import { BackendWire, type WireNotification } from './wire.js'

type ActionContext = {
  configPath: string
  dataPath: string
  adapterName: string
  pluginManager: { config: unknown }
  logger: { info?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void }
  actions: {
    call: (name: string, params: unknown, adapterName: string, config: unknown) => Promise<any>
  }
}
type Status = {
  state: string
  ready: boolean
  blockedTargets: number
  identity: { state: string; sourceType: string; validation: string; diagnostic: string }
}
type Journal = {
  events: Record<string, { hash: string; accepted: boolean }>
  outputs: Record<string, { status: 'unknown' | 'sent'; hash?: string }>
}
const VERSION = '0.1.0'
const idPattern = /^[1-9]\d{0,19}$/
function qqId(value: unknown): string {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('invalid self id')
    value = String(value)
  }
  if (typeof value !== 'string' || !idPattern.test(value)) throw new Error('invalid self id')
  return value
}
function hash(value: unknown): string {
  return JSON.stringify(value)
}
function readJournal(file: string): Journal {
  if (!fs.existsSync(file)) return { events: {}, outputs: {} }
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof parsed.events !== 'object' ||
    typeof parsed.outputs !== 'object'
  )
    throw new Error('invalid journal')
  return parsed as Journal
}
function saveJournal(file: string, journal: Journal): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.next`
  fs.writeFileSync(temp, JSON.stringify(journal), { mode: 0o600 })
  fs.renameSync(temp, file)
}
function textOf(message: any): string {
  return Array.isArray(message)
    ? message
        .filter((x) => x?.type === 'text')
        .map((x) => String(x.data?.text ?? ''))
        .join('')
    : String(message ?? '')
}
function normalizedEvent(event: any, selfId: string): Record<string, unknown> | undefined {
  if (event?.post_type !== 'message') return undefined
  if (qqId(event.self_id) !== selfId || qqId(event.user_id) === selfId) return undefined
  const group = event.message_type === 'group'
  const targetId = qqId(group ? event.group_id : event.user_id)
  const senderId = qqId(event.user_id)
  const messageId = String(event.message_id)
  const conversationType = group ? 'group' : 'private'
  return {
    eventId: `qq:${selfId}:${conversationType}:${targetId}:${messageId}`,
    selfId,
    conversationType,
    targetId,
    senderId,
    senderName: String(event.sender?.nickname ?? ''),
    messageId,
    content: textOf(event.message).trim(),
    mentionedBot:
      group &&
      Array.isArray(event.message) &&
      event.message.some((x: any) => x?.type === 'at' && String(x.data?.qq) === selfId),
    occurredAt: Number(event.time ?? 0),
  }
}
export class Adapter {
  private selfId?: string
  private wire: BackendWire
  private journalFile: string
  private journal: Journal
  private current?: Status
  private unsubscribe?: () => void
  private starting?: Promise<void>
  constructor(
    private readonly ctx: ActionContext,
    wire: BackendWire,
  ) {
    this.wire = wire
    this.journalFile = path.join(ctx.dataPath, 'delivery-journal.json')
    this.journal = readJournal(this.journalFile)
  }
  status(): Status {
    return (
      this.current ?? {
        state: 'identity-unavailable',
        ready: false,
        blockedTargets: 0,
        identity: {
          state: 'unavailable',
          sourceType: 'none',
          validation: 'rejected',
          diagnostic: 'source-missing',
        },
      }
    )
  }
  async action(name: string, params: unknown): Promise<any> {
    return this.ctx.actions.call(name, params, this.ctx.adapterName, this.ctx.pluginManager.config)
  }
  async start(): Promise<void> {
    if (this.starting) return this.starting
    this.starting = this.startInternal().finally(() => {
      this.starting = undefined
    })
    return this.starting
  }
  private async startInternal(): Promise<void> {
    try {
      const login = await this.action('get_login_info', {})
      const online = await this.action('get_status', {})
      this.selfId = qqId(login?.user_id)
      if (online?.online !== true || online?.good !== true) throw new Error('offline')
      this.current = {
        state: 'disconnected',
        ready: false,
        blockedTargets: 0,
        identity: {
          state: 'discovered',
          sourceType: 'napcat-action',
          validation: 'accepted',
          diagnostic: 'none',
        },
      }
      await this.wire.connect()
      this.unsubscribe?.()
      this.unsubscribe = this.wire.onMessage(
        (message) => void this.notification(message as WireNotification),
      )
      const hello = await this.wire.request('qq.plugin.hello', {
        protocolVersion: 1,
        pluginVersion: VERSION,
        selfId: this.selfId,
        capabilities: [...QQCapabilities],
      })
      const helloData = hello.success
        ? QQHelloResponseSchema.safeParse(hello.data)
        : { success: false as const }
      if (
        !helloData.success ||
        helloData.data.selfId !== this.selfId ||
        QQCapabilities.some((capability) => !helloData.data.capabilities.includes(capability))
      )
        throw new Error('backend unsupported')
      const bind = await this.wire.request('qq.identity.bind', {
        selfId: this.selfId,
        sourceType: 'napcat-action',
        validation: 'accepted',
        verifiedAt: Date.now(),
        sourceVersion: 'napcat',
      })
      const bindData = bind.success
        ? QQIdentityBindResponseSchema.safeParse(bind.data)
        : { success: false as const }
      if (!bindData.success || bindData.data.selfId !== this.selfId)
        throw new Error('identity rejected')
      const recover = await this.wire.request('qq.request.recover', { selfId: this.selfId })
      const recoverData = recover.success
        ? QQRecoverResponseSchema.safeParse(recover.data)
        : { success: false as const }
      if (!recoverData.success) throw new Error('recover rejected')
      for (const event of recoverData.data.events) await this.notification(event)
      this.current = { ...this.current, state: 'ready', ready: true }
    } catch (error) {
      this.current = {
        state: 'backend-unsupported',
        ready: false,
        blockedTargets: this.status().blockedTargets,
        identity: this.selfId
          ? {
              state: 'discovered',
              sourceType: 'napcat-action',
              validation: 'accepted',
              diagnostic: 'none',
            }
          : {
              state: 'unavailable',
              sourceType: 'none',
              validation: 'rejected',
              diagnostic: 'action-error',
            },
      }
      this.ctx.logger.warn?.(
        'QQ plugin startup blocked',
        error instanceof Error ? error.message : 'error',
      )
      this.wire.close()
    }
  }
  async receive(event: unknown): Promise<void> {
    if (!this.current?.ready) await this.start()
    if (!this.current?.ready || !this.selfId) return
    try {
      const input = normalizedEvent(event, this.selfId)
      if (!input || !input.content) return
      const previous = this.journal.events[String(input.eventId)]
      if (previous) return
      const response = await this.wire.request('qq.event.submit', input)
      if (!response.success) return
      this.journal.events[String(input.eventId)] = {
        hash: hash(input),
        accepted: Boolean((response.data as any)?.accepted),
      }
      saveJournal(this.journalFile, this.journal)
    } catch {
      // Rejected or malformed events have no side effects.
    }
  }
  private async notification(event: WireNotification): Promise<void> {
    if (event?.type === 'qq.connection.state' && event.data?.state === 'disconnected') {
      this.current = { ...this.status(), state: 'disconnected', ready: false }
      return
    }
    if (
      !event ||
      event.kind !== 'notification' ||
      !this.selfId ||
      event.data?.selfId !== this.selfId
    )
      return
    if (
      ![
        'qq.message.ack',
        'qq.waiting',
        'qq.tool.icon',
        'qq.reply.part',
        'qq.reply.video',
        'qq.reply.images',
        'qq.request.failed',
      ].includes(event.type)
    )
      return
    const target = event.data.targetId as string
    const outputId = String(event.data.eventId)
    if (this.journal.outputs[outputId]) return
    const payload =
      event.type === 'qq.tool.icon'
        ? String(event.data.icon ?? '🔧')
        : String(event.data.text ?? '')
    this.journal.outputs[outputId] = { status: 'unknown' }
    saveJournal(this.journalFile, this.journal)
    try {
      if (event.type === 'qq.message.ack') {
        let activity = false
        const messageIds: string[] = []
        if (event.data.conversationType === 'private') {
          const result = await this.action('send_msg', {
            user_id: target,
            message_type: 'private',
            message: [{ type: 'text', data: { text: '收到' } }],
          })
          if (result?.message_id === undefined) throw new Error('delivery unknown')
          messageIds.push(String(result.message_id))
          activity = true
        }
        if (
          event.data.conversationType === 'group' &&
          /^-?\d+$/.test(String(event.data.messageId ?? '')) &&
          /^\d+$/.test(String(event.data.emojiId ?? ''))
        ) {
          try {
            const result = await this.action('set_msg_emoji_like', {
              message_id: event.data.messageId,
              emoji_id: event.data.emojiId,
              set: true,
            })
            if (result?.retcode !== undefined && result.retcode !== 0)
              throw new Error('reaction rejected')
            if (
              result?.result !== undefined &&
              typeof result.result === 'number' &&
              result.result !== 0
            )
              throw new Error('reaction rejected')
            if (result?.result === false) throw new Error('reaction rejected')
            activity = true
            this.ctx.logger.info?.('QQ acknowledgement reaction applied')
          } catch {
            this.ctx.logger.warn?.('QQ acknowledgement reaction unavailable; continuing reply')
          }
        }
        const confirmation = await this.wire.request('qq.delivery.result', {
          eventId: outputId,
          requestId: event.data.requestId,
          selfId: this.selfId,
          conversationType: event.data.conversationType,
          targetId: target,
          seq: event.data.seq,
          status: 'sent',
          messageIds,
          sentAt: Date.now(),
          activity,
          terminal: false,
        })
        if (!confirmation.success) throw new Error('delivery rejected')
        this.journal.outputs[outputId] = { status: 'sent' }
        saveJournal(this.journalFile, this.journal)
        return
      }
      if (event.type === 'qq.reply.video' && !/^\d+\.mp4$/.test(String(event.data.mediaFile ?? ''))) throw new Error('Invalid media file')
      if (event.type === 'qq.reply.images' && (!Array.isArray(event.data.mediaFiles) || !event.data.mediaFiles.length || event.data.mediaFiles.length > 30 || event.data.mediaFiles.some((f: string) => !/^\d+-\d+\.(?:jpg|png|gif)$/.test(f)))) throw new Error('Invalid image files')
      const segments = event.type === 'qq.reply.images'
        ? (event.data.mediaFiles as string[]).map(file => ({type: 'image', data: {file: `file:///app/cherynyxus-media/${file}`}}))
        : event.type === 'qq.reply.video'
        ? [{type: 'video', data: {file: `file:///app/cherynyxus-media/${event.data.mediaFile}`}}]
        : [{type: 'text', data: {text: payload}}]
      const message =
        event.data.conversationType === 'group'
          ? {
              group_id: target,
              message_type: 'group',
              message: segments,
            }
          : {
              user_id: target,
              message_type: 'private',
              message: segments,
            }
      const result = await this.action('send_msg', message)
      const ids = result?.message_id === undefined ? [] : [String(result.message_id)]
      const terminal =
        event.type === 'qq.request.failed' ||
        event.type === 'qq.reply.video' ||
        event.type === 'qq.reply.images' ||
        (event.type === 'qq.reply.part' && event.data.partIndex === event.data.totalParts)
      const activity = ['qq.message.ack', 'qq.waiting', 'qq.tool.icon'].includes(event.type)
      const confirmation = await this.wire.request('qq.delivery.result', {
        eventId: outputId,
        requestId: event.data.requestId,
        selfId: this.selfId,
        conversationType: event.data.conversationType,
        targetId: target,
        seq: event.data.seq,
        status: 'sent',
        messageIds: ids,
        sentAt: Date.now(),
        activity,
        terminal,
      })
      if (!confirmation.success) throw new Error('delivery rejected')
      this.journal.outputs[outputId] = { status: 'sent', hash: hash(result) }
    } catch {
      await this.wire
        .request('qq.delivery.result', {
          eventId: outputId,
          requestId: event.data.requestId,
          selfId: this.selfId,
          conversationType: event.data.conversationType,
          targetId: target,
          seq: event.data.seq,
          status: 'unknown',
          messageIds: [],
          activity: false,
          terminal: false,
        })
        .catch(() => {})
      this.current = {
        ...this.status(),
        ready: false,
        state: 'delivery-unknown',
        blockedTargets: this.status().blockedTargets + 1,
      }
    }
    saveJournal(this.journalFile, this.journal)
  }
  close(): void {
    this.unsubscribe?.()
    this.wire.close()
    this.current = { ...this.status(), ready: false, state: 'stopped' }
  }
}
