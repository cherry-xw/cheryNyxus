import { queryInformation } from './information.js'
import { sendAssetFile } from './files.js'
import type { QQNotification } from '@chery/protocol'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  QQCapabilities,
  QQHelloResponseSchema,
  QQIdentityBindResponseSchema,
  QQRecoverResponseSchema,
  QQNotificationSchema,
  QQDeliveryResultRequestSchema,
} from '@chery/protocol'
import type { BackendChannel, WireNotification } from './wire.js'

export type PluginContext = {
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
  outputs: Record<string, { status: 'unknown' | 'sent'; hash?: string; confirmation?: Record<string, unknown> }>
  seq: Record<string, number>
  blocked: Record<string, boolean>
}
const VERSION = '0.2.6'
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
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
function readJournal(file: string): Journal {
  if (!fs.existsSync(file)) return { events: Object.create(null), outputs: Object.create(null), seq: {}, blocked: {} }
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof parsed.events !== 'object' ||
    typeof parsed.outputs !== 'object' || !parsed.events || !parsed.outputs || Array.isArray(parsed.events) || Array.isArray(parsed.outputs) ||
    Object.keys(parsed.events).length > 10000 || Object.keys(parsed.outputs).length > 10000 ||
    Object.values(parsed.events).some((value: any) => !value || typeof value.hash !== 'string' || typeof value.accepted !== 'boolean') ||
    Object.values(parsed.outputs).some((value: any) => !value || !['unknown', 'sent'].includes(value.status) ||
      value.confirmation !== undefined && !QQDeliveryResultRequestSchema.safeParse(value.confirmation).success)
  )
    throw new Error('invalid journal')
  parsed.seq ??= {}
  parsed.blocked ??= {}
  if (typeof parsed.seq !== 'object' || !parsed.seq || Array.isArray(parsed.seq) || Object.values(parsed.seq).some(value => !Number.isSafeInteger(value) || Number(value) < 0) ||
    typeof parsed.blocked !== 'object' || !parsed.blocked || Array.isArray(parsed.blocked) || Object.values(parsed.blocked).some(value => typeof value !== 'boolean')) throw new Error('invalid journal')
  for (const key of ['events', 'outputs', 'seq', 'blocked']) parsed[key] = Object.assign(Object.create(null), parsed[key])
  return parsed as Journal
}
function saveJournal(file: string, journal: Journal): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.next`
  fs.writeFileSync(temp, JSON.stringify(journal), { mode: 0o600 })
  fs.renameSync(temp, file)
}
export function textOf(message: any): string {
  return Array.isArray(message)
    ? message
        .filter((x) => x?.type === 'text')
        .map((x) => String(x.data?.text ?? ''))
        .join('') + message.filter(x => x?.type === 'json').map(x => {
          try { const raw = String(x.data?.data ?? ''); if (raw.length > 65536) return ''; const card = JSON.parse(raw); const app = String(card.app ?? ''); if (!['com.tencent.miniapp_01', 'com.tencent.structmsg'].includes(app)) return ''; const values: string[] = []; const collect = (v: unknown, depth = 0): void => { if (depth > 8) return; if (typeof v === 'string') values.push(v); else if (v && typeof v === 'object') Object.values(v).slice(0,100).forEach(x => collect(x, depth+1)) }; collect(card.meta); const links = values.flatMap(v => v.match(/https?:\/\/[^\s"<>]+/g) ?? []); return links.filter(v => { try { const u = new URL(v); return u.protocol === 'https:' && ['b23.tv','www.bilibili.com','bilibili.com'].includes(u.hostname) } catch {return false} }).map(v => '\n' + v).join('') } catch {return ''}
        }).join('')
    : String(message ?? '')
}
function normalizedEvent(event: any, selfId: string): Record<string, unknown> | undefined {
  if (event?.post_type !== 'message') return undefined
  if (!['group', 'private'].includes(event.message_type) || !Array.isArray(event.message) ||
    event.message_type === 'private' && event.group_id !== undefined ||
    event.sender?.user_id !== undefined && qqId(event.sender.user_id) !== qqId(event.user_id) ||
    typeof event.message_id === 'number' && !Number.isSafeInteger(event.message_id) || !/^-?\d{1,100}$/.test(String(event.message_id)) ||
    !Number.isFinite(event.time) || event.time < 0) return undefined
  if (qqId(event.self_id) !== selfId || qqId(event.user_id) === selfId) return undefined
  const group = event.message_type === 'group'
  const targetId = qqId(group ? event.group_id : event.user_id)
  const senderId = qqId(event.user_id)
  const messageId = String(event.message_id)
  const conversationType = group ? 'group' : 'private'
  const attachments: Array<{ type: string; name?: string; url?: string; mimeType?: string }> = []
  const parts: Array<{ type: 'text'; text: string } | { type: 'attachment'; index: number }> = []
  for (const segment of Array.isArray(event.message) ? event.message : []) {
    if (segment?.type === 'text') parts.push({ type: 'text', text: String(segment.data?.text ?? '') })
    else if (['image', 'video', 'file', 'record'].includes(segment?.type) && attachments.length < 30) {
      let url: string | undefined
      try { const parsed = new URL(String(segment.data?.url ?? '')); if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) url = parsed.href } catch {}
      parts.push({ type: 'attachment', index: attachments.length })
      attachments.push({ type: segment.type, ...(segment.data?.name ? { name: String(segment.data.name).slice(0, 200) } : {}), ...(url ? { url } : {}) })
    } else if (segment?.type === 'json') { const text = textOf([segment]); if (text) parts.push({ type: 'text', text }) }
  }
  return {
    eventId: `qq:${selfId}:${conversationType}:${targetId}:${messageId}`,
    selfId,
    conversationType,
    targetId,
    senderId,
    senderName: String(event.sender?.card || event.sender?.nickname || ''),
    ...(Array.isArray(event.message) && event.message.some((x: any) => x?.type === 'reply') ? { replyToMessageId: String(event.message.find((x: any) => x?.type === 'reply').data?.id ?? '') } : {}),
    attachments,
    ...(Array.isArray(event.message) ? { parts } : {}),
    messageId,
    content: textOf(event.message).trim(),
    mentionedBot:
      group &&
      Array.isArray(event.message) &&
      event.message.some((x: any) => x?.type === 'at' && String(x.data?.qq) === selfId),
    occurredAt: Number(event.time ?? 0),
  }
}
export function normalize(event: unknown, selfId: string): Record<string, unknown> | undefined {
  try { return normalizedEvent(event, selfId) } catch { return undefined }
}
export class Adapter {
  private selfId?: string
  private wire: BackendChannel
  private journalFile: string
  private journal: Journal
  private current?: Status
  private unsubscribe?: () => void
  private starting?: Promise<void>
  private fileGeneration = 0
  private stopped = false
  private authenticated = false
  private lifetime = new AbortController()
  private queues = new Map<string, Promise<void>>()
  constructor(
    private readonly ctx: PluginContext,
    wire: BackendChannel,
    private readonly actionTimeoutMs = 15000,
  ) {
    this.wire = wire
    this.journalFile = path.join(ctx.dataPath, 'delivery-journal.json')
    try { this.journal = readJournal(this.journalFile) }
    catch {
      this.journal = { events: Object.create(null), outputs: Object.create(null), seq: {}, blocked: {} }
      this.current = { ...this.status(), state: 'journal-invalid', ready: false }
    }
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
    const signal = this.lifetime.signal
    signal.throwIfAborted()
    return new Promise((resolve, reject) => {
      const abort = () => finish(() => reject(new Error('adapter stopped')))
      const timer = setTimeout(() => finish(() => reject(new Error('action timeout'))), this.actionTimeoutMs)
      const finish = (done: () => void) => { clearTimeout(timer); signal.removeEventListener('abort', abort); done() }
      signal.addEventListener('abort', abort, { once: true })
      Promise.resolve().then(() => { signal.throwIfAborted(); return this.ctx.actions.call(name, params, this.ctx.adapterName, this.ctx.pluginManager.config) })
        .then(value => finish(() => resolve(value)), () => finish(() => reject(new Error('action unavailable'))))
    })
  }
  async start(): Promise<void> {
    if (this.stopped || this.current?.state === 'journal-invalid') return
    if (this.starting) return this.starting
    this.starting = this.startInternal().finally(() => {
      this.starting = undefined
    })
    return this.starting
  }
  private async startInternal(): Promise<void> {
    this.authenticated = false
    const generation = ++this.fileGeneration
    const validate = () => { if (this.stopped || generation !== this.fileGeneration) throw new Error('stale connection') }
    let diagnostic = 'action-error'
    let sourceType = 'none'
    let discovered = false
    try {
      const login = await this.action('get_login_info', {})
      const online = await this.action('get_status', {})
      validate()
      sourceType = 'napcat-action'
      diagnostic = 'invalid-self-id'
      this.selfId = qqId(login?.user_id)
      diagnostic = 'offline'
      if (online?.online !== true || online?.good !== true) throw new Error('offline')
      discovered = true
      this.current = {
        state: 'disconnected',
        ready: false,
        blockedTargets: Object.values(this.journal.blocked).filter(Boolean).length,
        identity: {
          state: 'discovered',
          sourceType: 'napcat-action',
          validation: 'accepted',
          diagnostic: 'none',
        },
      }
      this.unsubscribe?.()
      this.unsubscribe = this.wire.onMessage(
        (message) => { void this.enqueueNotification(message as WireNotification).catch(() => undefined) },
      )
      await this.wire.connect()
      validate()
      const hello = await this.wire.request('qq.plugin.hello', {
        protocolVersion: 1,
        pluginVersion: VERSION,
        selfId: this.selfId,
        capabilities: [...QQCapabilities],
      })
      const helloData = hello.success
        ? QQHelloResponseSchema.safeParse(hello.data)
        : { success: false as const }
      validate()
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
      validate()
      if (!bindData.success || bindData.data.selfId !== this.selfId)
        throw new Error('identity rejected')
      for (const output of Object.values(this.journal.outputs)) {
        if (output.confirmation?.selfId === this.selfId && !await this.confirmDelivery(output.confirmation)) throw new Error('confirmation unavailable')
        validate()
      }
      this.authenticated = true
      const recover = await this.wire.request('qq.request.recover', { selfId: this.selfId })
      validate()
      const recoverData = recover.success
        ? QQRecoverResponseSchema.safeParse(recover.data)
        : { success: false as const }
      if (!recoverData.success) throw new Error('recover rejected')
      for (const event of recoverData.data.events) { await this.enqueueNotification(event); validate() }
      this.current = { ...this.current, state: 'ready', ready: true }
    } catch {
      if (this.stopped || generation !== this.fileGeneration) return
      this.authenticated = false
      this.current = {
        state: discovered ? 'backend-unsupported' : 'identity-unavailable',
        ready: false,
        blockedTargets: this.status().blockedTargets,
        identity: discovered
          ? {
              state: 'discovered',
              sourceType: 'napcat-action',
              validation: 'accepted',
              diagnostic: 'none',
            }
          : {
              state: 'unavailable',
              sourceType,
              validation: 'rejected',
              diagnostic,
            },
      }
      this.ctx.logger.warn?.(`cheryNyxus: ${this.current.state}`)
      this.wire.close()
    }
  }
  async receive(event: unknown): Promise<void> {
    if (this.stopped || this.current && !['ready', 'disconnected', 'delivery-unknown'].includes(this.current.state)) return
    if (!this.current?.ready) await this.start()
    if (!this.current?.ready || !this.selfId) return
    try {
      const input = normalize(event, this.selfId)
       if (!input || !input.content && !(input.attachments as unknown[])?.length) return
      const previous = this.journal.events[String(input.eventId)]
      if (previous) return
      if (Object.keys(this.journal.events).length >= 10000) { this.current = { ...this.status(), state: 'journal-full', ready: false }; return }
      const generation = this.fileGeneration
      const raw = event as { message?: Array<{ type: string; data?: Record<string, unknown> }> }
      const segments = raw.message?.filter(segment => ['image', 'video', 'file', 'record'].includes(segment.type)).slice(0, 30) ?? []
      const attachments = input.attachments as Array<{ url?: string }>
      for (const [index, segment] of segments.entries()) {
        if (attachments[index]?.url) continue
        const fileId = segment.data?.file_id ?? segment.data?.file
        if (typeof fileId !== 'string' || !/^[a-zA-Z0-9._-]{1,512}$/.test(fileId) || ['.', '..'].includes(fileId)) continue
        try {
          const result = await this.action('get_file', { file_id: fileId })
          const url = new URL(String((result?.data ?? result)?.url ?? ''))
          if (url.protocol === 'https:' && !url.username && !url.password) attachments[index]!.url = url.href
        } catch { /* 缺少安全下载地址时，后端保留不可读取说明。 */ }
      }
      if (this.stopped || generation !== this.fileGeneration || this.journal.events[String(input.eventId)]) return
      this.journal.events[String(input.eventId)] = { hash: hash(input), accepted: false }
      saveJournal(this.journalFile, this.journal)
      const response = await this.wire.request('qq.event.submit', input)
      if (this.stopped || generation !== this.fileGeneration) return
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
  private async confirmDelivery(receipt: Record<string, unknown>): Promise<boolean> {
    const generation = this.fileGeneration
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.stopped || generation !== this.fileGeneration) return false
      try {
        const response = await this.wire.request('qq.delivery.result', receipt)
        if (!response.success) throw new Error(`Confirmation rejected: ${response.error?.code ?? 'unknown'} ${response.error?.message ?? ''}`)
        return true
      } catch {
        this.ctx.logger.warn?.('QQ confirmation retry', { eventId: receipt.eventId, attempt })
      }
    }
    return false
  }
  private async enqueueNotification(event: WireNotification): Promise<void> {
    if (this.stopped) return
    if (event?.type === 'qq.connection.state') { await this.notification(event); return }
    const key = `${event?.data?.selfId}:${event?.data?.conversationType}:${event?.data?.targetId}`
    const generation = this.fileGeneration
    const task = (this.queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      if (!this.stopped && generation === this.fileGeneration) await this.notification(event)
    })
    this.queues.set(key, task)
    try { await task } finally { if (this.queues.get(key) === task) this.queues.delete(key) }
  }
  private async notification(event: WireNotification): Promise<void> {
    if (this.stopped) return
    if (event?.type === 'qq.connection.state' && event.data?.state === 'disconnected') {
      this.fileGeneration++
      this.authenticated = false
      this.lifetime.abort()
      this.lifetime = new AbortController()
      this.current = { ...this.status(), state: 'disconnected', ready: false }
      return
    }
    if (event?.type === 'qq.connection.state' && event.data?.state === 'connected') {
      if (!this.starting && this.current?.state === 'disconnected') void this.start()
      return
    }
    if (
      !event ||
      !this.authenticated ||
      event.kind !== 'notification' ||
      !this.selfId ||
      event.data?.selfId !== this.selfId
    )
      return
    if (event.type === 'qq.information.request') {
      let success=false, result='{}'
      try { result=JSON.stringify(await queryInformation((name,params)=>this.action(name,params),event.data));success=true } catch { /* explicit failure without profile/error disclosure */ }
      await this.wire.request('qq.information.result',{selfId:this.selfId,lookupId:event.data.lookupId,targetId:String(event.data.targetId),success,result})
      return
    }
    if (event.type === 'qq.lookup.request') {
      let items: Array<{ id: string; name: string; card?: string }> = []
      let success = false
      try {
        if (event.data.conversationType !== 'group') throw new Error('Group directory only')
        const raw = await this.action(event.data.lookupKind === 'members' ? 'get_group_member_list' : 'get_ai_characters', { group_id: String(event.data.targetId), ...(event.data.lookupKind === 'members' ? { no_cache: true } : { chat_type: 1 }) })
        const data = Array.isArray(raw) ? raw : raw?.data
        if (!Array.isArray(data)) throw new Error('Invalid directory')
        items = event.data.lookupKind === 'members'
          ? data.map((m: any) => ({ id: String(m.user_id), name: String(m.nickname ?? ''), card: String(m.card ?? '') }))
          : data.flatMap((g: any) => (g.characters ?? []).map((v: any) => ({ id: String(v.character_id), name: String(v.character_name) })))
        success = true
      } catch { /* Send an explicit failure, never invent directory data. */ }
      await this.wire.request('qq.lookup.result', { selfId: this.selfId, lookupId: event.data.lookupId, groupId: String(event.data.targetId), kind: event.data.lookupKind, items, success })
      return
    }
    if (
      ![
        'qq.reply.action',
        'qq.message.ack',
        'qq.waiting',
        'qq.tool.icon',
        'qq.reply.part',
        'qq.reply.file',
        'qq.reply.video',
        'qq.reply.images',
        'qq.request.failed',
      ].includes(event.type)
    )
      return
    const target = event.data.targetId as string
    const outputId = String(event.data.eventId)
    const previous = this.journal.outputs[outputId]
    if (previous) {
      if (previous.hash && previous.hash !== hash(event)) return
      if (previous.confirmation) await this.confirmDelivery(previous.confirmation)
      return
    }
    const key = `${this.selfId}:${event.data.conversationType}:${target}`
    if (this.journal.blocked[key]) return
    if (!QQNotificationSchema.safeParse(event).success || event.data.seq !== (this.journal.seq[key] ?? 0) + 1) {
      this.journal.blocked[key] = true
      saveJournal(this.journalFile, this.journal)
      this.current = { ...this.status(), blockedTargets: Object.values(this.journal.blocked).filter(Boolean).length }
      return
    }
    if (Object.keys(this.journal.outputs).length >= 10000) { this.current = { ...this.status(), state: 'journal-full', ready: false }; return }
    if (event.type === 'qq.message.ack' && event.data.text !== undefined && event.data.text !== '收到') {
      this.journal.blocked[key] = true; saveJournal(this.journalFile, this.journal); return
    }
    const payload =
      event.type === 'qq.tool.icon'
        ? (/^[\p{Extended_Pictographic}\uFE0F\u200D]{1,12}$/u.test(String(event.data.icon ?? '')) ? String(event.data.icon) : '🔧')
        : event.type === 'qq.request.failed' ? '刚才处理失败了，请稍后再试。' : String(event.data.text ?? '')
    this.journal.outputs[outputId] = { status: 'unknown', hash: hash(event) }
    this.journal.seq[key] = Number(event.data.seq)
    this.journal.blocked[key] = true
    saveJournal(this.journalFile, this.journal)
    const fileGeneration = this.fileGeneration
    try {
      if (event.type === 'qq.reply.file') {
        const validate = () => { if (fileGeneration !== this.fileGeneration) throw new Error('File delivery stopped') }
        const delivery = await sendAssetFile({ dataPath: this.ctx.dataPath, event: event.data as QQNotification['data'],
          validate,
          read: async offset => {
            const result = await this.wire.request('qq.file.read', { selfId: this.selfId, eventId: outputId, offset })
            if (!result.success) throw new Error('File read rejected')
            return result.data as { offset: number; dataBase64: string; eof: boolean }
          }, action: (name, params) => this.action(name, params) })
        validate()
        const receipt = { eventId: outputId, requestId: event.data.requestId, selfId: this.selfId, conversationType: event.data.conversationType,
          targetId: target, seq: event.data.seq, status: 'sent', ...delivery, sentAt: Date.now(), activity: false, terminal: event.data.completeReply === true }
        this.journal.outputs[outputId] = { status: 'sent', hash: hash(event), confirmation: receipt }
        delete this.journal.blocked[key]
        saveJournal(this.journalFile, this.journal)
        await this.confirmDelivery(receipt)
        return
      }
      if (event.type === 'qq.reply.action') {
        if (event.data.conversationType !== 'group') throw new Error('Group reply only')
        let result: any
        const kind = event.data.actionKind
        if (kind === 'quote') result = await this.action('send_msg', { group_id: target, message_type: 'group', message: [{ type: 'reply', data: { id: event.data.messageId } }, ...(event.data.userId ? [{ type: 'at', data: { qq: event.data.userId } }] : []), { type: 'text', data: { text: payload } }] })
        else if (kind === 'reaction') result = await this.action('set_msg_emoji_like', { message_id: event.data.messageId, emoji_id: event.data.emojiId, set: true })
        else if (kind === 'poke') result = await this.action('group_poke', { group_id: target, user_id: event.data.userId })
        else if (kind === 'voice') result = await this.action('send_group_ai_record', { group_id: target, character: event.data.character, text: payload })
        else if (kind === 'mention') result = await this.action('send_msg', { group_id: target, message_type: 'group', message: [{ type: 'at', data: { qq: event.data.userId } }, { type: 'text', data: { text: payload } }] })
        else throw new Error('Unknown reply action')
        if (this.stopped || fileGeneration !== this.fileGeneration) return
        if (result?.retcode !== undefined && result.retcode !== 0) throw Object.assign(new Error('Action rejected'), { definitelyFailed: true })
        if (result?.result !== undefined && typeof result.result === 'number' && result.result !== 0) throw Object.assign(new Error('Action rejected'), { definitelyFailed: true })
        const messageId = result?.message_id ?? result?.data?.message_id
        if (['voice', 'mention', 'quote'].includes(String(kind)) && messageId === undefined) throw new Error('Delivery unknown')
        const receipt = { eventId: outputId, requestId: event.data.requestId, selfId: this.selfId, conversationType: 'group', targetId: target, seq: event.data.seq, status: 'sent', messageIds: messageId === undefined ? [] : [String(messageId)], sentAt: Date.now(), activity: false, terminal: event.data.completeReply === true }
        this.journal.outputs[outputId] = { status: 'sent', hash: hash(event), confirmation: receipt }
        delete this.journal.blocked[key]
        saveJournal(this.journalFile, this.journal)
        await this.confirmDelivery(receipt)
        return
      }
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
        if (this.stopped || fileGeneration !== this.fileGeneration) return
        const receipt = {
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
        }
        this.journal.outputs[outputId] = { status: 'sent', hash: hash(event), confirmation: receipt }
        delete this.journal.blocked[key]
        saveJournal(this.journalFile, this.journal)
        await this.confirmDelivery(receipt)
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
      const ids: string[] = []
      const pieces = Array.from(payload)
      const batches = ['qq.reply.video', 'qq.reply.images'].includes(event.type) ? [message]
        : Array.from({ length: Math.max(1, Math.ceil(pieces.length / 4000)) }, (_, index) => ({ ...message, message: [{ type: 'text', data: { text: pieces.slice(index * 4000, (index + 1) * 4000).join('') } }] }))
      for (const batch of batches) {
        const result = await this.action('send_msg', batch)
        if (this.stopped || fileGeneration !== this.fileGeneration) return
        const id = result?.message_id ?? result?.data?.message_id
        if (!/^-?\d{1,100}$/.test(String(id))) throw new Error('delivery unknown')
        ids.push(String(id))
      }
      const terminal =
        event.type === 'qq.request.failed' ||
        event.type === 'qq.reply.video' ||
        event.type === 'qq.reply.images' ||
        (event.type === 'qq.reply.part' && event.data.partIndex === event.data.totalParts)
      const activity = ['qq.message.ack', 'qq.waiting', 'qq.tool.icon'].includes(event.type)
      const receipt = {
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
      }
      this.journal.outputs[outputId] = { status: 'sent', hash: hash(event), confirmation: receipt }
      delete this.journal.blocked[key]
      saveJournal(this.journalFile, this.journal)
      await this.confirmDelivery(receipt)
    } catch (error) {
      this.ctx.logger.warn?.('QQ delivery stage failed', { eventId: outputId, type: event.type, stage: this.journal.outputs[outputId]?.status === 'sent' ? 'confirmation' : 'action' })
      if (this.stopped || fileGeneration !== this.fileGeneration) return
      if (this.journal.outputs[outputId]?.status === 'sent') return
      const definitelyFailed = ['qq.reply.action', 'qq.reply.file'].includes(event.type) && (error as { definitelyFailed?: boolean })?.definitelyFailed === true
      const receipt = {
          eventId: outputId,
          requestId: event.data.requestId,
          selfId: this.selfId,
          conversationType: event.data.conversationType,
          targetId: target,
          seq: event.data.seq,
          status: definitelyFailed ? 'failed' : 'unknown',
          messageIds: [],
          activity: false,
          terminal: (['qq.reply.action', 'qq.reply.file'].includes(event.type) && event.data.completeReply === true) || event.type === 'qq.request.failed' || event.type === 'qq.reply.video' || event.type === 'qq.reply.images' || (event.type === 'qq.reply.part' && event.data.partIndex === event.data.totalParts),
      }
      this.journal.outputs[outputId]!.confirmation = receipt
      if (definitelyFailed) delete this.journal.blocked[key]
      if (!definitelyFailed) this.current = {
        ...this.status(),
        ready: true,
        state: 'delivery-unknown',
        blockedTargets: Object.values(this.journal.blocked).filter(Boolean).length,
      }
      saveJournal(this.journalFile, this.journal)
      await this.confirmDelivery(receipt)
    }
    saveJournal(this.journalFile, this.journal)
  }
  close(): void {
    this.authenticated = false
    this.stopped = true
    this.fileGeneration++
    this.lifetime.abort()
    this.queues.clear()
    this.unsubscribe?.()
    this.wire.close()
    this.current = { ...this.status(), ready: false, state: 'stopped' }
  }
}
