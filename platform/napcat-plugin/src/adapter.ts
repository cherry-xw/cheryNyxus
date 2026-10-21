import { NativeImages } from './nativeImages.js'
import { queryInformation } from './information.js'
import { sendAssetFile } from './files.js'
import type { QQNotification, QQServiceState } from '@chery/protocol'
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
  QQServiceStateSchema,
  QQServiceStateNotificationSchema,
} from '@chery/protocol'
import type { BackendChannel, WireNotification } from './wire.js'

export type PluginContext = {
  core?: unknown
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
  service?: QQServiceState
  events: Record<string, { hash: string; accepted: boolean }>
  outputs: Record<string, { status: 'unknown' | 'sent' | 'failed'; hash?: string; confirmation?: Record<string, unknown>; retryEvent?: WireNotification; retryAt?: number; reported?: boolean; progress?: boolean }>
  seq: Record<string, number>
  blocked: Record<string, boolean>
  progressSeq?: Record<string, number>
}
const VERSION = '0.2.15'
const idPattern = /^[1-9]\d{0,19}$/
function qqId(value: unknown): string {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('invalid self id')
    value = String(value)
  }
  if (typeof value !== 'string' || !idPattern.test(value)) throw new Error('invalid self id')
  return value
}
function nativeMessageId(value: unknown): string | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? String(value) : undefined
  return typeof value === 'string' && /^-?\d{1,100}$/.test(value) ? value : undefined
}
function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
function readJournal(file: string): Journal {
  if (!fs.existsSync(file)) return { events: Object.create(null), outputs: Object.create(null), seq: {}, blocked: {} }
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (parsed && typeof parsed === 'object' && parsed.service !== undefined) parsed.service = QQServiceStateSchema.parse(parsed.service)
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof parsed.events !== 'object' ||
    typeof parsed.outputs !== 'object' || !parsed.events || !parsed.outputs || Array.isArray(parsed.events) || Array.isArray(parsed.outputs) ||
    Object.keys(parsed.events).length > 10000 || Object.keys(parsed.outputs).length > 10000 ||
    Object.values(parsed.events).some((value: any) => !value || typeof value.hash !== 'string' || typeof value.accepted !== 'boolean') ||
    Object.values(parsed.outputs).some((value: any) => !value || !['unknown', 'sent', 'failed'].includes(value.status) ||
      value.confirmation !== undefined && !QQDeliveryResultRequestSchema.safeParse(value.confirmation).success)
  )
    throw new Error('invalid journal')
  if (parsed.progressSeq !== undefined && (!parsed.progressSeq || typeof parsed.progressSeq !== 'object' || Array.isArray(parsed.progressSeq) || Object.values(parsed.progressSeq).some(value => !Number.isSafeInteger(value) || Number(value) < 0))) throw new Error('invalid progress sequence')
  parsed.seq ??= {}
  parsed.blocked ??= {}
  if (typeof parsed.seq !== 'object' || !parsed.seq || Array.isArray(parsed.seq) || Object.values(parsed.seq).some(value => !Number.isSafeInteger(value) || Number(value) < 0) ||
    typeof parsed.blocked !== 'object' || !parsed.blocked || Array.isArray(parsed.blocked) || Object.values(parsed.blocked).some(value => typeof value !== 'boolean')) throw new Error('invalid journal')
  for (const key of ['events', 'outputs', 'seq', 'blocked']) parsed[key] = Object.assign(Object.create(null), parsed[key])
  return parsed as Journal
}
function saveJournal(file: string, journal: Journal): void {
  // Only confirmed, reported heartbeat receipts are disposable; never prune unknown sends.
  const progress = Object.entries(journal.outputs).filter(([, o]) => o.progress && o.status === 'sent' && o.reported)
  journal.progressSeq ??= {}
  for (const [id, output] of progress.slice(0, Math.max(0, progress.length - 256))) {
    const receipt = output.confirmation!
    const key = `${receipt.selfId}:${receipt.conversationType}:${receipt.targetId}`
    journal.progressSeq[key] = Math.max(journal.progressSeq[key] ?? 0, Number(receipt.seq))
    delete journal.outputs[id]
  }
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
      if (segment.type !== 'image') try { const parsed = new URL(String(segment.data?.url ?? '')); if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) url = parsed.href } catch {}
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
  private images: NativeImages
  private selfId?: string
  private wire: BackendChannel
  private journalFile: string
  private journal: Journal
  private current?: Status
  private unsubscribe?: () => void
  private starting?: Promise<void>
  private fileGeneration = 0
  private deliveryEpoch = 0
  private serviceInstance?: string
  private pendingService?: QQServiceState
  private readonly closedNotices = new Set<string>()
  private stopped = false
  private authenticated = false
  private lifetime = new AbortController()
  private queues = new Map<string, Promise<void>>()
  private activeDeliveries = new Set<string>()
  private retrying = false
  private retryTimer?: ReturnType<typeof setInterval>
  private async retryAcknowledgements(): Promise<void> {
    if (this.retrying || this.stopped || !this.authenticated || this.journal.service?.phase === 'closing') return
    this.retrying = true
    try {
      for (const output of Object.values(this.journal.outputs).filter(o => o.retryEvent || (o.confirmation && !o.reported)).slice(0,16)) {
        if (output.confirmation && !output.reported) output.reported = await this.confirmDelivery(output.confirmation)
        if (output.retryEvent && (output.retryAt ?? 0) <= Date.now()) await this.enqueueNotification(output.retryEvent)
      }
    } finally { this.retrying = false }
  }
  constructor(
    private readonly ctx: PluginContext,
    wire: BackendChannel,
  ) {
    this.wire = wire
    this.images = new NativeImages(ctx.core, wire, () => this.selfId, undefined, nativeMsgId => this.action('get_msg', {message_id:nativeMsgId}), (stage,code)=>ctx.logger.warn?.('QQ image '+stage+' '+code))
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
  private clearPendingDelivery(preserveImageScope = false): void {
    this.deliveryEpoch++
    if (!preserveImageScope) this.images.reset()
    this.queues.clear()
    this.activeDeliveries.clear()
    this.lifetime.abort()
    this.lifetime = new AbortController()
    for (const output of Object.values(this.journal.outputs)) {
      delete output.retryAt
      delete output.retryEvent
      // Receipt history remains readable, but is not replayed into a new/closed Backend queue.
      if (output.confirmation) output.reported = true
    }
    this.journal.blocked = {}
  }
  private acceptServiceState(input: QQServiceState, recovery = false): void {
    if (!this.authenticated || input.selfId !== this.selfId) return
    if (!recovery && !this.serviceInstance) {
      if (!this.pendingService || this.pendingService.backendInstanceId !== input.backendInstanceId || input.version > this.pendingService.version)
        this.pendingService = input
      return
    }
    if (!recovery && input.backendInstanceId !== this.serviceInstance) return
    const previous = this.journal.service
    if (previous?.backendInstanceId === input.backendInstanceId && input.version < previous.version) return
    if (!recovery && previous?.backendInstanceId === input.backendInstanceId && input.version === previous.version) return
    if (recovery) this.serviceInstance = input.backendInstanceId
    if (previous?.backendInstanceId !== input.backendInstanceId || input.phase === 'closing' && previous?.phase !== 'closing')
      this.clearPendingDelivery(recovery && input.phase !== 'closing')
    this.journal.service = structuredClone(input)
    saveJournal(this.journalFile, this.journal)
  }
  /** Only an authenticated, explicit service state grants these offline replies. No input is queued. */
  private async closedInput(event: unknown): Promise<boolean> {
    const service = this.journal.service
    if (!service || service.phase === 'running' || !this.selfId || service.selfId !== this.selfId ||
      this.status().identity.validation !== 'accepted') return false
    const input = normalize(event, this.selfId)
    if (!input) return true
    if (!service.targets.some(target => target.conversationType === input.conversationType && target.targetId === input.targetId)) return true
    const answer = service.phase === 'draining' && this.authenticated && this.status().ready && input.replyToMessageId &&
      service.questions.some(question => question.conversationType === input.conversationType && question.targetId === input.targetId &&
        question.senderId === input.senderId && question.messageIds.includes(String(input.replyToMessageId)))
    if (answer) return false
    if (!input.content && !(input.attachments as unknown[])?.length && !input.mentionedBot) return true
    const id = String(input.eventId)
    if (this.closedNotices.has(id)) return true
    this.closedNotices.add(id)
    if (this.closedNotices.size > 256) this.closedNotices.delete(this.closedNotices.values().next().value!)
    try {
      await this.action('send_msg', { message_type: input.conversationType,
        ...(input.conversationType === 'group' ? { group_id: input.targetId } : { user_id: input.targetId }),
        message: [{ type: 'text', data: { text: '服务已关闭' } }] })
    } catch { /* A physical send may be unknown; never save or automatically retry the new input. */ }
    return true
  }
  async action(name: string, params: unknown): Promise<any> {
    const signal = this.lifetime.signal
    signal.throwIfAborted()
    return new Promise((resolve, reject) => {
      const abort = () => finish(() => reject(new Error('adapter stopped')))
      const finish = (done: () => void) => { signal.removeEventListener('abort', abort); done() }
      signal.addEventListener('abort', abort, { once: true })
      Promise.resolve().then(() => { signal.throwIfAborted(); return this.ctx.actions.call(name, params, this.ctx.adapterName, this.ctx.pluginManager.config) })
        .then(value => finish(() => resolve(value)), (err: unknown) => {
          const msg = err instanceof Error ? err.message : ''
          const definitelyFailed = /Native message send failed:|EventChecker Failed:|文件异常|获取视频缩略图失败|消息体无法解析|语音转换失败|请求参数错误/.test(msg)
          finish(() => reject(Object.assign(new Error('action unavailable'), definitelyFailed ? { definitelyFailed: true } : {})))
        })
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
    this.serviceInstance = undefined
    this.pendingService = undefined
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
      this.authenticated = true
      this.retryTimer ??= setInterval(() => { void this.retryAcknowledgements().catch(() => this.ctx.logger.warn?.('QQ recovery retry failed')) }, 5000)
      for (const output of Object.values(this.journal.outputs)) {
        if (output.confirmation?.selfId === this.selfId && !output.reported && this.journal.service?.phase !== 'closing') {
          output.reported = await this.confirmDelivery(output.confirmation)
          validate()
        }
      }
      this.images.attach()
      const scope = await this.wire.request('qq.image.scope.get', { selfId: this.selfId })
      if (!scope.success) throw new Error('scope rejected')
      await this.images.accept(scope.data)
      validate()
      const recover = await this.wire.request('qq.request.recover', { selfId: this.selfId })
      validate()
      const recoverData = recover.success
        ? QQRecoverResponseSchema.safeParse(recover.data)
        : { success: false as const }
      if (!recoverData.success) throw new Error('recover rejected')
      this.acceptServiceState(recoverData.data.service, true)
      if (this.pendingService) { this.acceptServiceState(this.pendingService); this.pendingService = undefined }
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
    if (this.stopped) return
    if (await this.closedInput(event)) return
    if (this.stopped || this.current && !['ready', 'disconnected', 'delivery-unknown'].includes(this.current.state)) return
    if (!this.current?.ready) await this.start()
    if (await this.closedInput(event)) return
    if (!this.current?.ready || !this.selfId) return
    try {
      if (!this.images.allows(event)) return
      await this.images.admit(event)
      if (await this.closedInput(event)) return
      if (!this.images.allows(event)) return
      const input = normalize(event, this.selfId)
       if (!input || !input.content && !(input.attachments as unknown[])?.length && !input.mentionedBot) return
      const previous = this.journal.events[String(input.eventId)]
      if (previous) return
      if (Object.keys(this.journal.events).length >= 10000) { this.current = { ...this.status(), state: 'journal-full', ready: false }; return }
      const generation = this.fileGeneration
      const deliveryEpoch = this.deliveryEpoch
      const raw = event as { message?: Array<{ type: string; data?: Record<string, unknown> }> }
      const segments = raw.message?.filter(segment => ['image', 'video', 'file', 'record'].includes(segment.type)).slice(0, 30) ?? []
      const attachments = input.attachments as Array<{ url?: string }>
      for (const [index, segment] of segments.entries()) {
        if (segment.type === 'image') { delete attachments[index]?.url; continue }
        if (attachments[index]?.url) continue
        const fileId = segment.data?.file_id ?? segment.data?.file
        if (typeof fileId !== 'string' || !/^[a-zA-Z0-9._-]{1,512}$/.test(fileId) || ['.', '..'].includes(fileId)) continue
        try {
          const result = await this.action('get_file', { file_id: fileId })
          const url = new URL(String((result?.data ?? result)?.url ?? ''))
          if (url.protocol === 'https:' && !url.username && !url.password) attachments[index]!.url = url.href
        } catch { /* 缺少安全下载地址时，后端保留不可读取说明。 */ }
      }
      if (this.stopped || generation !== this.fileGeneration || deliveryEpoch !== this.deliveryEpoch || this.journal.events[String(input.eventId)]) return
      if (await this.closedInput(event)) return
      if (this.stopped || generation !== this.fileGeneration || deliveryEpoch !== this.deliveryEpoch) return
      this.journal.events[String(input.eventId)] = { hash: hash(input), accepted: false }
      saveJournal(this.journalFile, this.journal)
      const response = await this.wire.request('qq.event.submit', input)
      if (this.stopped || generation !== this.fileGeneration || deliveryEpoch !== this.deliveryEpoch) return
      if (!response.success) {
        if (response.error?.code === 'BACKEND_STOPPING') {
          delete this.journal.events[String(input.eventId)]
          saveJournal(this.journalFile, this.journal)
          await this.closedInput(event)
        }
        this.ctx.logger.warn?.('QQ input submission rejected', {eventId: input.eventId, code: response.error?.code ?? 'unknown'}); return
      }
      this.journal.events[String(input.eventId)] = {
        hash: hash(input),
        accepted: Boolean((response.data as any)?.accepted),
      }
      saveJournal(this.journalFile, this.journal)
    } catch {
      this.ctx.logger.warn?.('QQ input admission unavailable')
    }
  }
  private async confirmDelivery(receipt: Record<string, unknown>): Promise<boolean> {
    if (this.journal.service?.phase === 'closing') return false
    if (receipt.status === 'unknown' && this.activeDeliveries.has(String(receipt.eventId))) return false
    const generation = this.fileGeneration
    const deliveryEpoch = this.deliveryEpoch
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.stopped || generation !== this.fileGeneration || deliveryEpoch !== this.deliveryEpoch) return false
      try {
        const response = await this.wire.request('qq.delivery.result', receipt)
        if (this.stopped || generation !== this.fileGeneration || deliveryEpoch !== this.deliveryEpoch) return false
        if (!response.success) throw new Error(`Confirmation rejected: ${response.error?.code ?? 'unknown'} ${response.error?.message ?? ''}`)
        const output=this.journal.outputs[String(receipt.eventId)]
        if(output && output.confirmation === receipt) {output.reported=true;saveJournal(this.journalFile,this.journal)}
        return true
      } catch {
        this.ctx.logger.warn?.('QQ confirmation retry', { eventId: receipt.eventId, attempt })
      }
    }
    return false
  }
  private async enqueueNotification(event: WireNotification): Promise<void> {
    if (this.stopped) return
    if (event?.type === 'qq.service.state') {
      const parsed = QQServiceStateNotificationSchema.safeParse(event)
      if (parsed.success) this.acceptServiceState(parsed.data.data)
      return
    }
    if (event?.type === 'qq.image.scope') { await this.images.accept(event.data); return }
    if (event?.type === 'qq.connection.state') { await this.notification(event); return }
    const key = `${event?.data?.selfId}:${event?.data?.conversationType}:${event?.data?.targetId}${event?.type === 'qq.message.ack' && event?.data?.conversationType === 'group' ? ':ack' : ['qq.waiting','qq.tool.icon'].includes(event?.type) ? ':progress' : ''}`
    const generation = this.fileGeneration
    const deliveryEpoch = this.deliveryEpoch
    const task = (this.queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      if (!this.stopped && generation === this.fileGeneration && deliveryEpoch === this.deliveryEpoch && this.journal.service?.phase !== 'closing') await this.notification(event)
    })
    this.queues.set(key, task)
    try { await task } finally { if (this.queues.get(key) === task) this.queues.delete(key) }
  }
  private async notification(event: WireNotification): Promise<void> {
    if (this.stopped) return
    if (event?.type === 'qq.connection.state' && event.data?.state === 'disconnected') {
      this.fileGeneration++
      this.images.reset()
      this.authenticated = false
      this.serviceInstance = undefined
      this.pendingService = undefined
      this.activeDeliveries.clear()
      this.queues.clear()
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
      this.journal.service?.phase === 'closing' ||
      event.kind !== 'notification' ||
      !this.selfId ||
      event.data?.selfId !== this.selfId
    )
      return
    if (event.type === 'qq.information.request') {
      let success=false, result='{}'
      const generation = this.fileGeneration
      try {
        const data = QQNotificationSchema.parse(event).data
        const call = (name: string, params: unknown) => this.action(name, params)
        result = JSON.stringify(await queryInformation(call, data))
        if (!this.authenticated || generation !== this.fileGeneration || this.selfId !== data.selfId) return
        success = true
      } catch { /* explicit failure without profile/error disclosure */ }
      if (!this.authenticated || generation !== this.fileGeneration) return
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
    const retryAck = !!previous?.retryEvent && previous.status === 'failed' && (event.type === 'qq.message.ack' || event.type === 'qq.request.failed')
    if (previous && !retryAck) {
      if (previous.hash && previous.hash !== hash(event)) return
      if (previous.confirmation) await this.confirmDelivery(previous.confirmation)
      return
    }
    const key = `${this.selfId}:${event.data.conversationType}:${target}`
    if (!previous && ['qq.waiting','qq.tool.icon'].includes(event.type) && Number(event.data.seq) <= (this.journal.progressSeq?.[key] ?? 0)) return
    if (!QQNotificationSchema.safeParse(event).success) {
      this.ctx.logger.warn?.('QQ invalid notification rejected', { eventId: outputId })
      return
    }
    if (previous?.hash && previous.hash !== hash(event)) return
    // Event identity prevents repeats. Sequence gaps are diagnostic, not a group lock.
    if (!retryAck && event.data.seq !== (this.journal.seq[key] ?? 0) + 1)
      this.ctx.logger.warn?.('QQ sequence discontinuity', { eventId: outputId, seq: event.data.seq })
    if (Object.keys(this.journal.outputs).length >= 10000 && !previous) { this.current = { ...this.status(), state: 'journal-full', ready: false }; return }
    const payload =
      event.type === 'qq.tool.icon'
        ? (/^[\p{Extended_Pictographic}\uFE0F\u200D]{1,12}$/u.test(String(event.data.icon ?? '')) ? String(event.data.icon) : '🔧')
        : String(event.data.text ?? '')
    // Persist a reportable unknown receipt before native work. Disconnect and
    // restart can settle the old transport without replaying physical sends.
    this.journal.outputs[outputId] = { status: 'unknown', hash: hash(event), confirmation: {
      eventId: outputId, requestId: event.data.requestId, selfId: this.selfId,
      conversationType: event.data.conversationType, targetId: target, seq: event.data.seq,
      status: 'unknown', messageIds: [], activity: false,
      terminal: (['qq.reply.action', 'qq.reply.file'].includes(event.type) && event.data.completeReply === true) || event.type === 'qq.request.failed' || event.type === 'qq.reply.video' || event.type === 'qq.reply.images' || (event.type === 'qq.reply.part' && event.data.partIndex === event.data.totalParts),
    } }
    this.activeDeliveries.add(outputId)
    this.journal.seq[key] = Math.max(this.journal.seq[key] ?? 0, Number(event.data.seq))
    delete this.journal.blocked[key]
    saveJournal(this.journalFile, this.journal)
    const fileGeneration = this.fileGeneration
    const deliveryEpoch = this.deliveryEpoch
    try {
      if (event.type === 'qq.reply.file') {
        const validate = () => { if (fileGeneration !== this.fileGeneration || deliveryEpoch !== this.deliveryEpoch) throw new Error('File delivery stopped') }
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
        this.journal.outputs[outputId] = { status: 'sent', hash: hash(event), confirmation: receipt, progress: ['qq.waiting','qq.tool.icon'].includes(event.type) }
        delete this.journal.blocked[key]
        saveJournal(this.journalFile, this.journal)
        await this.confirmDelivery(receipt)
        return
      }
      if (event.type === 'qq.reply.action') {
        if (event.data.conversationType !== 'group' && event.data.actionKind !== 'quote') throw Object.assign(new Error('Group reply only'), { definitelyFailed: true })
        let result: any
        const kind = event.data.actionKind
        if (kind === 'quote') result = await this.action('send_msg', { ...(event.data.conversationType === 'group' ? {group_id:target,message_type:'group'} : {user_id:target,message_type:'private'}), message: [{ type: 'reply', data: { id: event.data.messageId } }, ...(event.data.conversationType === 'group' && event.data.userId ? [{ type: 'at', data: { qq: event.data.userId } }] : []), { type: 'text', data: { text: payload } }] })
        else if (kind === 'reaction') result = await this.action('set_msg_emoji_like', { message_id: event.data.messageId, emoji_id: event.data.emojiId, set: true })
        else if (kind === 'poke') result = await this.action('group_poke', { group_id: target, user_id: event.data.userId })
        else if (kind === 'voice') result = await this.action('send_group_ai_record', { group_id: target, character: event.data.character, text: payload })
        else if (kind === 'mention') result = await this.action('send_msg', { group_id: target, message_type: 'group', message: [{ type: 'at', data: { qq: event.data.userId } }, { type: 'text', data: { text: payload } }] })
        else throw new Error('Unknown reply action')
        if (this.stopped || fileGeneration !== this.fileGeneration || deliveryEpoch !== this.deliveryEpoch) return
        if (result?.result === false || result?.status === 'failed' || (result?.retcode !== undefined && result.retcode !== 0)) throw Object.assign(new Error('Action rejected'), { definitelyFailed: true })
        if (result?.result !== undefined && typeof result.result === 'number' && result.result !== 0) throw Object.assign(new Error('Action rejected'), { definitelyFailed: true })
        const messageId = nativeMessageId(result?.message_id ?? result?.data?.message_id)
        if (['voice', 'mention', 'quote'].includes(String(kind)) && messageId === undefined) throw new Error('Delivery unknown')
        const receipt = { eventId: outputId, requestId: event.data.requestId, selfId: this.selfId, conversationType: event.data.conversationType, targetId: target, seq: event.data.seq, status: 'sent', messageIds: messageId === undefined ? [] : [String(messageId)], sentAt: Date.now(), activity: false, terminal: event.data.completeReply === true }
        this.journal.outputs[outputId] = { status: 'sent', hash: hash(event), confirmation: receipt, progress: ['qq.waiting','qq.tool.icon'].includes(event.type) }
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
          const id = nativeMessageId(result?.message_id ?? result?.data?.message_id)
          if (id === undefined) throw new Error('delivery unknown')
          messageIds.push(id)
          activity = true
        }
        if (
          event.data.conversationType === 'group' &&
          /^-?\d+$/.test(String(event.data.messageId ?? '')) &&
          /^\d+$/.test(String(event.data.emojiId ?? ''))
        ) {
          const result = await this.action('set_msg_emoji_like', {
            message_id: event.data.messageId,
            emoji_id: event.data.emojiId,
            set: true,
          })
          if (result?.retcode !== undefined && result.retcode !== 0)
            throw Object.assign(new Error('reaction rejected'), { definitelyFailed: true })
          if (
            result?.result !== undefined &&
            typeof result.result === 'number' &&
            result.result !== 0
          )
            throw Object.assign(new Error('reaction rejected'), { definitelyFailed: true })
          if (result?.result === false || result?.status === 'failed') throw Object.assign(new Error('reaction rejected'), { definitelyFailed: true })
          activity = true
          this.ctx.logger.info?.('QQ acknowledgement reaction applied')
        }
        if (event.data.conversationType === 'group' && !activity) throw new Error('Invalid acknowledgement target')
        if (this.stopped || fileGeneration !== this.fileGeneration || deliveryEpoch !== this.deliveryEpoch) return
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
        this.journal.outputs[outputId] = { status: 'sent', hash: hash(event), confirmation: receipt, progress: ['qq.waiting','qq.tool.icon'].includes(event.type) }
        delete this.journal.blocked[key]
        saveJournal(this.journalFile, this.journal)
        await this.confirmDelivery(receipt)
        return
      }
      if (event.type === 'qq.reply.video' && !/^\d+\.mp4$/.test(String(event.data.mediaFile ?? ''))) throw new Error('Invalid media file')
      if (event.type === 'qq.reply.video' && event.data.mediaScope && event.data.mediaScope !== `${event.data.conversationType === 'group' ? 'group' : 'user'}-${target}`) throw new Error('Invalid media scope')
      if (event.type === 'qq.reply.video' && event.data.uploadAsFile === true) {
        const isGroup = event.data.conversationType === 'group'
        const rawName = String(event.data.fileName ?? event.data.mediaFile).replace(/[\x00-\x1f\x7f/\\]/g, '_').slice(0, 180)
        const name = rawName && rawName !== '.' && rawName !== '..' ? rawName : String(event.data.mediaFile)
        const result = await this.action(isGroup ? 'upload_group_file' : 'upload_private_file', {
          ...(isGroup ? { group_id: target } : { user_id: target }),
          file: `/app/cherynyxus-media/${event.data.mediaScope ? `scoped/${event.data.mediaScope}/` : ''}${event.data.mediaFile}`,
          name,
          upload_file: true,
        })
        if (this.stopped || fileGeneration !== this.fileGeneration || deliveryEpoch !== this.deliveryEpoch) return
        if ((result?.retcode !== undefined && result.retcode !== 0) || result?.status === 'failed') throw Object.assign(new Error('File action rejected'), { definitelyFailed: true })
        const fileId = result?.file_id ?? result?.data?.file_id
        if (!(typeof fileId === 'string' && fileId.length && fileId.length <= 512) && !(result?.status === 'ok' && result.retcode === 0)) throw new Error('File delivery unknown')
        const receipt = {
          eventId: outputId,
          requestId: event.data.requestId,
          selfId: this.selfId,
          conversationType: event.data.conversationType,
          targetId: target,
          seq: event.data.seq,
          status: 'sent',
          messageIds: [],
          fileIds: typeof fileId === 'string' && fileId.length ? [fileId] : [],
          fileUploaded: true,
          sentAt: Date.now(),
          activity: false,
          terminal: true,
        }
        this.journal.outputs[outputId] = { status: 'sent', hash: hash(event), confirmation: receipt, progress: false }
        delete this.journal.blocked[key]
        saveJournal(this.journalFile, this.journal)
        await this.confirmDelivery(receipt)
        return
      }
      if (event.type === 'qq.reply.images' && (!Array.isArray(event.data.mediaFiles) || !event.data.mediaFiles.length || event.data.mediaFiles.length > 30 || event.data.mediaFiles.some((f: string) => !/^\d+-\d+\.(?:jpg|png|gif)$/.test(f)))) throw new Error('Invalid image files')
      const segments = event.type === 'qq.reply.images'
        ? (event.data.mediaFiles as string[]).map(file => ({type: 'image', data: {file: `file:///app/cherynyxus-media/${file}`}}))
        : event.type === 'qq.reply.video'
        ? [{type: 'video', data: {file: `file:///app/cherynyxus-media/${event.data.mediaScope ? `scoped/${event.data.mediaScope}/` : ''}${event.data.mediaFile}`}}]
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
        if (this.stopped || fileGeneration !== this.fileGeneration || deliveryEpoch !== this.deliveryEpoch) return
        if (result?.retcode !== undefined && result.retcode !== 0) throw Object.assign(new Error('Action rejected'),{definitelyFailed:true})
        const id = nativeMessageId(result?.message_id ?? result?.data?.message_id)
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
      this.journal.outputs[outputId] = { status: 'sent', hash: hash(event), confirmation: receipt, progress: ['qq.waiting','qq.tool.icon'].includes(event.type) }
      delete this.journal.blocked[key]
      saveJournal(this.journalFile, this.journal)
      await this.confirmDelivery(receipt)
    } catch (error) {
      this.ctx.logger.warn?.('QQ delivery stage failed', { eventId: outputId, type: event.type, stage: this.journal.outputs[outputId]?.status === 'sent' ? 'confirmation' : 'action' })
      if (this.stopped || fileGeneration !== this.fileGeneration || deliveryEpoch !== this.deliveryEpoch) return
      if (this.journal.outputs[outputId]?.status === 'sent') return
      const definitelyFailed = (error as { definitelyFailed?: boolean })?.definitelyFailed === true
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
      this.journal.outputs[outputId]!.status = receipt.status as 'failed' | 'unknown'
      if (definitelyFailed && ((event.type === 'qq.message.ack' && event.data.conversationType === 'group') || event.type === 'qq.request.failed')) {
        this.journal.outputs[outputId]!.retryEvent = event
        this.journal.outputs[outputId]!.retryAt = Date.now() + 60000
      }
      delete this.journal.blocked[key]
      if (definitelyFailed) delete this.journal.blocked[key]
      if (!definitelyFailed) this.current = {
        ...this.status(),
        ready: true,
        state: 'delivery-unknown',
        blockedTargets: Object.values(this.journal.blocked).filter(Boolean).length,
      }
      saveJournal(this.journalFile, this.journal)
      this.activeDeliveries.delete(outputId)
      await this.confirmDelivery(receipt)
    } finally {
      this.activeDeliveries.delete(outputId)
    }
    saveJournal(this.journalFile, this.journal)
  }
  close(): void {
    this.images.close()
    this.authenticated = false
    this.stopped = true
    this.fileGeneration++
    this.lifetime.abort()
    clearInterval(this.retryTimer)
    this.queues.clear()
    this.unsubscribe?.()
    this.wire.close()
    this.current = { ...this.status(), ready: false, state: 'stopped' }
  }
}
