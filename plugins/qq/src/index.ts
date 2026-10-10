import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
const runFile = promisify(execFile)
export function douyinLink(content: string): string | undefined {
  for (const match of content.matchAll(/https:\/\/[^\s<>"']+/g)) {
    const value = match[0].replace(/[，。；）)]+$/, '')
    try { if (['v.douyin.com','www.douyin.com','www.iesdouyin.com','iesdouyin.com'].includes(new URL(value).hostname)) return value } catch {}
  }
}
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import fs from 'node:fs'
import type {
  IngressContext,
  IngressPlugin,
  IngressConfigSnapshot,
  IngressIdentityHandle,
} from '@chery/plugin-api'
import {
  QQDefaultConfig,
  QQConfigSchema,
  QQCapabilities,
  QQRequestSchemas,
  QQResponseSchemas,
  type QQConfig,
  type QQNotification,
  type QQEventSubmitRequest,
  type QQDeliveryResultRequest,
  type QQEntry,
  type QQStatus,
} from '../../../packages/protocol/src/qq.js'
import { atomicJson, readState, digest, targetOf, type Job, type Outbox } from './state.js'
import { createQQTools, QQ_MEMORY_CONTEXT_KEY } from './tools.js'
import { QQMemoryStore } from './memory.js'

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code })
}
const terminal = (job: Job) => job.state === 'completed' || job.state === 'failed'
export function createPlugin(context: IngressContext): IngressPlugin {
  return new QQPlugin(context)
}
export class QQPlugin implements IngressPlugin {
  readonly defaultConfig = QQDefaultConfig
  private snapshot!: Readonly<IngressConfigSnapshot<QQConfig>>
  private readonly file: string
  private state: ReturnType<typeof readState>
  private connection?: string
  private verifiedConnection?: string
  private readonly handles = new Map<string, IngressIdentityHandle>()
  private readonly operations = new Set<Promise<void>>()
  private readonly aborters = new Map<string, AbortController>()
  private recovered = false
  private stopped = true
  private timer?: ReturnType<typeof setInterval>
  private readonly busy = new Set<string>()
  private readonly cleanups: Array<() => void> = []
  private readonly paused: boolean
  private apply = { state: 'applied' as 'applied' | 'pending' | 'restart_required' | 'failed', revision: 0 }
  constructor(private readonly context: IngressContext) {
    this.file = path.join(context.dataDir, 'state.json')
    this.state = readState(this.file)
    this.paused =
      context.runtimeOptions.QQ_INGRESS_PAUSED === '1' ||
      context.runtimeOptions.QQ_INGRESS_PAUSED === true || process.env.QQ_INGRESS_PAUSED === '1'
  }
  validateConfig(config: unknown): QQConfig {
    return QQConfigSchema.parse(config)
  }
  applyConfig(next: Readonly<IngressConfigSnapshot>): void | 'restart_required' {
    const config = this.validateConfig(next.config)
    if (this.snapshot && config.selfId !== this.snapshot.config.selfId) {
      this.apply = { state: 'restart_required', revision: next.revision }
      return 'restart_required'
    }
    this.snapshot = structuredClone({ ...next, config })
    this.apply = { state: 'applied', revision: next.revision }
  }
  start(): void {
    this.stopped = false
    this.cleanups.push(this.context.ingress.register({ id: 'qq' }))
    this.cleanups.push(this.context.identity.registerChannel({
      channel: 'qq',
      verifyConnection: async ({ connectionId, credentialKind }) =>
        credentialKind === 'qq' && connectionId === this.connection &&
        connectionId === this.verifiedConnection && this.state.identityBinding
          ? { selfId: this.state.identityBinding.selfId } : null,
      verifyEvent: async input => {
        const job = this.state.jobs.find(j => j.input.eventId === input.eventId)
        if (!job || input.entryId !== 'qq' || input.connectionId !== this.verifiedConnection) return false
        const event = job.input, subject = input.subject, config = this.snapshot.config
        return subject.selfId === event.selfId && subject.userId === event.senderId &&
          subject.conversationType === event.conversationType &&
          subject.groupId === (event.conversationType === 'group' ? event.targetId : undefined) &&
          (event.conversationType === 'group' ? config.groups.includes(event.targetId) : config.users.includes(event.senderId))
      },
    }))
    const memory = new QQMemoryStore(this.context.dataDir)
    this.cleanups.push(this.context.hooks.register({
      event: 'RequestPrepare', required: true,
      handler: async (_payload, ctx) => {
        const identity = ctx.requestView?.identity
        if (identity?.ownerId !== this.context.id || identity.channel !== 'qq' || !identity.subject) return
        const revision = this.context.config.snapshot().revision
        return { contexts: [
          { key: 'qq.identity', configRevision: revision, content: JSON.stringify({
            channel: 'qq', subject: identity.subject, instruction: this.snapshot.config.systemPrompt,
          }) },
          ...(this.snapshot.config.memoryEnabled ? [{ key: QQ_MEMORY_CONTEXT_KEY,
            configRevision: revision, content: await memory.prepare(identity.subject) }] : []),
        ] }
      },
    }))
    const fileRoot = this.context.runtimeOptions.QQ_USER_FILES_ROOT ?? process.env.QQ_USER_FILES_ROOT
    for (const tool of createQQTools(this.context.dataDir,
      typeof fileRoot === 'string' && path.isAbsolute(fileRoot) ? fileRoot : path.join(this.context.dataDir, 'user-files')))
      this.cleanups.push(this.context.tools.register(tool))
    for (const output of this.state.outbox)
      if (output.status === 'inflight') output.status = 'unknown'
    for (const job of this.state.jobs) {
      if (job.state === 'running') {
        job.state = 'paused'
        job.reason = 'PROCESS_INTERRUPTED'
        delete job.nextWaitAt
      }
      if (
        this.state.outbox.some(
          (o) => o.frame.data.requestId === job.requestId && o.status === 'unknown',
        )
      ) {
        job.state = 'paused'
        job.reason = 'DELIVERY_UNKNOWN'
        delete job.nextWaitAt
      }
    }
    this.persist()
    this.cleanups.push(this.context.core.onEvent((key, event) => this.coreEvent(key, event)))
    this.cleanups.push(
      this.context.connections.onClose((id) => {
        if (this.connection !== id) return
        this.connection = undefined
        this.verifiedConnection = undefined
        this.handles.clear()
        this.recovered = false
        // Nothing is resent while disconnected. Pending physical sends stay ambiguous.
        for (const output of this.state.outbox)
          if (output.status === 'inflight') {
            const job = this.job(output)
            if (job) {
              job.reason = 'CONFIRMATION_PENDING'
              delete job.nextWaitAt
            }
          }
        this.persist()
      }),
    )
    this.register(false)
    if (!this.paused) this.timer = setInterval(() => this.tick(), 250)
  }
  async stop(): Promise<void> {
    this.stopped = true
    this.verifiedConnection = undefined
    this.handles.clear()
    for (const controller of this.aborters.values()) controller.abort()
    clearInterval(this.timer)
    this.timer = undefined
    this.recovered = false
    for (const cleanup of this.cleanups.splice(0).reverse()) cleanup()
    for (const job of this.state.jobs)
      if (job.state === 'running') {
        job.state = 'paused'
        job.reason = 'PROCESS_STOPPED'
        delete job.nextWaitAt
        this.persist()
        try {
          await this.context.core.abort(job.conversationKey)
        } catch {
          /* remain paused */
        }
      }
    await Promise.allSettled([...this.operations])
    this.persist()
  }
  prepareManagement(): void {
    this.snapshot = this.context.config.snapshot<QQConfig>()
    this.register(true)
    const routes: Parameters<IngressContext['management']['register']>[0]['routes'] = []
    for (const [name, rpcMethod] of [['config', 'qq.config.get'], ['status', 'qq.status.get'],
      ['queue', 'qq.queue.get'], ['history', 'qq.history.get']] as const) {
      const handler = async () => name === 'config' ? this.configView() : name === 'status' ? this.status() :
        { entries: name === 'queue' ? this.entries(false) : this.entries(true).slice(-this.context.config.snapshot<QQConfig>().config.historyLimit) }
      routes.push({ method: 'GET', path: name, rpcMethod,
        requestSchema: z.object({ pathParams: z.object({}).strict(), query: z.object({}).strict() }).strict(),
        responseSchema: QQResponseSchemas[rpcMethod], handler })
    }
    routes.push({ method: 'GET', path: 'memory', rpcMethod: 'qq.memory.stats',
      requestSchema: z.object({ pathParams: z.object({}).strict(), query: z.object({}).strict() }).strict(),
      responseSchema: z.array(z.object({ scope: z.enum(['personal', 'group', 'member']),
        files: z.number().int().nonnegative(), count: z.number().int().nonnegative(), unreadable: z.number().int().nonnegative() }).strict()),
      handler: async () => ['personal', 'group', 'member'].map(scope => {
        const dir = path.join(this.context.dataDir, 'memory', scope)
        let files = 0, count = 0, unreadable = 0
        if (fs.existsSync(dir)) {
          if (fs.lstatSync(dir).isSymbolicLink()) throw new Error('Invalid memory directory')
          for (const name of fs.readdirSync(dir)) {
            if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
            files++
            try {
              const file = path.join(dir, name), stat = fs.lstatSync(file)
              if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Invalid memory file')
              const data = JSON.parse(fs.readFileSync(file, 'utf8'))
              count += Object.keys(data.memories).length
            } catch { unreadable++ }
          }
        }
        return { scope, files, count, unreadable }
      }),
    })
    routes.push({ method: 'PUT', path: 'config', rpcMethod: 'qq.config.save',
      requestSchema: z.object({ pathParams: z.object({}).strict(), query: z.object({}).strict(),
        body: QQRequestSchemas['qq.config.save'] }).strict(), responseSchema: QQResponseSchemas['qq.config.save'],
      handler: async input => this.saveConfiguration(QQRequestSchemas['qq.config.save'].parse(input.body)) })
    this.context.management.register({ moduleId: 'qq', routes })
  }
  private persist(): void {
    atomicJson(this.file, this.state)
  }
  private assertChannel(
    connectionId: string,
    selfId: string,
    mode: 'hello' | 'bind' | 'business' = 'business',
  ): void {
    // Business activation requires the persisted NapCat-action binding; hello/bind may
    // still fall back to the configured identity so the first binding can be created.
    const bound = this.state.identityBinding?.selfId
    const expected = mode === 'business' ? bound : (bound ?? this.snapshot.config.selfId)
    if ((!expected && mode !== 'hello') || (expected && selfId !== expected))
      fail('INVALID_PARAMS', 'QQ身份未绑定或不匹配')
    if (mode !== 'hello' && this.connection !== connectionId) fail('INVALID_PARAMS', 'QQ连接未握手')
    if (mode === 'business' && this.verifiedConnection !== connectionId) fail('INVALID_PARAMS', 'QQ连接身份尚未重新验证')
  }
  private assertBusiness(): void {
    if (this.paused || this.stopped) fail('MAINTENANCE_MODE', 'QQ业务已暂停')
  }
  private register(management: boolean): void {
    const register = <K extends keyof typeof QQRequestSchemas>(
      method: K,
      handler: (
        connectionId: string,
        params: z.infer<(typeof QQRequestSchemas)[K]>,
      ) => Promise<z.infer<(typeof QQResponseSchemas)[K]>>,
    ) => {
      const transport = [
        'qq.plugin.hello',
        'qq.identity.bind',
        'qq.event.submit',
        'qq.delivery.result',
        'qq.request.recover',
      ].includes(method)
      if (transport === management) return
      const cleanup = this.context.rpc.register({
          scope: transport ? 'business' : 'management',
          method,
          request: QQRequestSchemas[method] as unknown as z.ZodType<
            z.infer<(typeof QQRequestSchemas)[K]>
          >,
          response: QQResponseSchemas[method] as unknown as z.ZodType<
            z.infer<(typeof QQResponseSchemas)[K]>
          >,
          authorize: (ctx) =>
            transport ? ctx.credentialKind === 'qq' : ctx.credentialKind === 'control',
          handler: (ctx, params) => handler(ctx.connectionId, params),
        })
      if (transport) this.cleanups.push(cleanup)
    }
    register('qq.plugin.hello', async (id, p) => {
      this.assertChannel(id, p.selfId, 'hello')
      if (QQCapabilities.some((c) => !p.capabilities.includes(c)))
        fail('INVALID_PARAMS', 'QQ插件能力不匹配')
      if (
        this.connection &&
        this.connection !== id &&
        this.context.connections.isOpen(this.connection)
      )
        fail('CONFLICT', '已有QQ连接')
      this.connection = id
      this.verifiedConnection = undefined
      this.handles.clear()
      this.recovered = false

      return {
        protocolVersion: 1,
        backendVersion: this.context.version,
        selfId: p.selfId,
        authenticated: true,
        capabilities: [...QQCapabilities],
      }
    })
    register('qq.identity.bind', async (id, p) => {
      this.assertChannel(id, p.selfId, 'bind')
      if (p.verifiedAt > Date.now() + 30000 || p.verifiedAt < Date.now() - 300000)
        fail('INVALID_PARAMS', 'QQ身份验证已过期')
      const existing = this.state.identityBinding
      if (existing && existing.selfId !== p.selfId) fail('CONFLICT', 'QQ身份发生变化')
      if (this.snapshot.config.selfId && this.snapshot.config.selfId !== p.selfId)
        fail('CONFLICT', 'QQ目标身份不匹配')
      if (!existing) {
        this.state.identityBinding = {
          selfId: p.selfId,
          sourceType: p.sourceType,
          verifiedAt: p.verifiedAt,
          sourceVersion: p.sourceVersion,
        }
        this.persist()
      }
      this.verifiedConnection = id
      return {
        bound: true as const,
        selfId: p.selfId,
        sourceType: 'napcat-action' as const,
        validation: 'accepted' as const,
      }
    })
    register('qq.request.recover', async (id, p) => {
      this.assertChannel(id, p.selfId)
      this.assertBusiness()
      const events = this.state.outbox
        .filter((o) => o.status === 'inflight')
        .map((o) => structuredClone(o.frame))
      for (const job of this.state.jobs.filter((j) => !terminal(j)))
        events.push({
          kind: 'notification',
          type: 'qq.request.recovered',
          data: {
            eventId: randomUUID(),
            requestId: job.requestId,
            selfId: job.input.selfId,
            conversationType: job.input.conversationType,
            targetId: job.input.targetId,
            seq: this.state.seq[`${job.input.selfId}:${job.target}`] ?? 1,
            state: job.reason ?? job.state,
          },
        })
      this.recovered = true
      for (const job of this.state.jobs.filter((j) => !terminal(j)))
        this.sendState(job, 'qq.connection.state', 'connected')
      // Resume only never-issued pending outputs after the recover response is on the wire.
      setImmediate(() => {
        if (!this.stopped && this.connection === id) this.tick()
      })
      return { events }
    })
    register('qq.event.submit', async (id, p) => {
      this.assertChannel(id, p.selfId)
      this.assertBusiness()
      if (!this.recovered) fail('CONFLICT', '请先恢复QQ连接')
      return this.submit(p)
    })
    register('qq.delivery.result', async (id, p) => {
      this.assertChannel(id, p.selfId)
      this.assertBusiness()
      return this.confirm(p)
    })
    register('qq.config.get', async () => this.configView())
    register('qq.config.save', async (_, p) => this.saveConfiguration(p))
    register('qq.status.get', async () => this.status())
    register('qq.queue.get', async () => ({ entries: this.entries(false) }))
    register('qq.history.get', async () => ({
      entries: this.entries(true).slice(-this.context.config.snapshot<QQConfig>().config.historyLimit),
    }))
  }
  private async saveConfiguration(p: z.infer<(typeof QQRequestSchemas)['qq.config.save']>) {
      const hash = digest(p),
        previous = this.state.configWrites[p.requestId]
      if (previous) {
        if (previous.hash !== hash) fail('CONFLICT', '保存请求标识已使用')
        return QQResponseSchemas['qq.config.save'].parse(previous.response)
      }
      const saved = await this.context.config.save(p.config, p.expectedBaseRevision)
      const response = {
        config: this.validateConfig(saved.snapshot.config),
        baseRevision: saved.snapshot.revision,
        saved: true as const,
        apply: saved.apply,
      }
      this.apply = {
        state: saved.apply.state,
        revision: saved.apply.revision,
      }
      this.state.configWrites[p.requestId] = { hash, response }
      this.persist()
      return response
  }
  private configView() {
    const saved = this.context.config.saved<QQConfig>()
    return { config: saved.config, baseRevision: saved.revision, apply: { ...this.apply } }
  }
  private entries(history: boolean): QQEntry[] {
    return this.state.jobs
      .filter((j) => terminal(j) === history)
      .map((j) => ({
        requestId: j.requestId,
        eventId: j.input.eventId,
        target: digest([j.input.selfId, j.target]),
        conversationType: j.input.conversationType,
        state: j.state,
        acceptedAt: j.acceptedAt,
        policyRevision: j.snapshot.revision,
        ...(j.reason ? { reason: j.reason } : {}),
      }))
  }
  private status(): QQStatus {
    const snapshot = this.context.config.snapshot<QQConfig>()
    const c = snapshot.config
    const missingBindings = [
      ...c.groups.map((id) => `group:${id}`),
      ...c.users.map((id) => `private:user:${id}`),
    ].filter((t) => !c.bindings[t])
    const missingResources = Object.entries(c.bindings)
      .filter(([, preset]) => {
        try {
          this.context.core.resolvePreset(preset)
          return false
        } catch {
          return true
        }
      })
      .map(([t]) => t)
    const connected = !!this.connection && this.context.connections.isOpen(this.connection)
    return {
      installed: true,
      enabled: this.context.isEnabled(),
      activeVersion: this.context.version,
      savedVersion: this.context.version,
      savedRevision: this.context.config.saved().revision,
      appliedRevision: snapshot.revision,
      apply: { ...this.apply },
      napcatConnected: connected,
      trustedIdentity:
        connected &&
        this.state.identityBinding?.selfId === c.selfId &&
        this.verifiedConnection === this.connection,
      qqOnline: null,
      paused: this.paused,
      pausedTargets:
        new Set(this.state.jobs.filter((j) => j.state === 'paused').map((j) => j.target)).size +
        (this.state.migrated.length ? 1 : 0),
      reasons: [
        ...(this.paused ? ['QQ_INGRESS_PAUSED'] : []),
        ...(!connected ? ['NAPCAT_DISCONNECTED'] : []),
        ...(!this.state.identityBinding || this.state.identityBinding.selfId !== c.selfId
          ? ['IDENTITY_UNBOUND']
          : []),
        ...(missingBindings.length ? ['BINDING_MISSING'] : []),
        ...(missingResources.length ? ['RESOURCE_MISSING'] : []),
        ...(this.state.migrated.length ? ['MIGRATION_REVIEW_REQUIRED'] : []),
      ],
      channels: {
        group: { enabled: !this.paused && connected && c.groups.length > 0 },
        private: { enabled: !this.paused && connected && c.users.length > 0 },
      },
      missingBindings,
      missingResources,
    }
  }
  private submit(input: QQEventSubmitRequest) {
    const hash = digest(input),
      receipt = this.state.receipts[input.eventId]
    if (receipt) {
      if (receipt.hash !== hash) fail('CONFLICT', 'QQ事件标识冲突')
      return { eventId: input.eventId, accepted: receipt.accepted }
    }
    if (Object.keys(this.state.receipts).length >= 10000) fail('INPUT_QUEUE_FULL', 'QQ收件记录已满')
    const target = targetOf(input),
      c = this.snapshot.config,
      now = Date.now()
    const windowKey = `${input.targetId}:${input.senderId}`,
      window = this.state.windows[windowKey]
    let accepted =
      input.content.trim().length > 0 &&
      (input.conversationType === 'group'
        ? c.groups.includes(input.targetId)
        : c.users.includes(input.senderId))
    const videoUrl = douyinLink(input.content)
    if (
      input.conversationType === 'group' &&
      !videoUrl &&
      !input.mentionedBot &&
      (!window || window.remaining < 1 || window.expiresAt <= now)
    )
      accepted = false
    const preset = c.bindings[target]
    let resource: ReturnType<IngressContext['core']['resolvePreset']> | undefined
    if (!preset) accepted = false
    else {
      try {
        resource = this.context.core.resolvePreset(preset)
      } catch {
        accepted = false
      }
    }
    if (
      this.state.jobs.filter((j) => j.target === target && !terminal(j)).length >= c.queueLimit ||
      this.state.migrated.some(() => true)
    )
      accepted = false
    this.state.receipts[input.eventId] = { hash, accepted }
    if (accepted && resource && preset) {
      if (input.conversationType === 'group' && !videoUrl)
        this.state.windows[windowKey] = {
          remaining: input.mentionedBot ? c.continuationMaxMessages : window!.remaining - 1,
          expiresAt: now + c.continuationTtlMs,
        }
      const job: Job = {
        requestId: randomUUID(),
        input,
        target,
        conversationKey: `${input.selfId}:${target}:${resource.presetId}`,
        snapshot: {
          revision: this.snapshot.revision,
          config: structuredClone(c),
          preset,
          presetId: resource.presetId,
          brain: resource.brain,
          senseGroup: resource.senseGroup,
        },
        state: 'queued',
        acceptedAt: now,
        reply: '',
        toolIds: [],
        pendingIcons: [],
        sentIcons: [],
        ...(videoUrl ? {douyinUrl: videoUrl} : {}),
        waits: 0,
      }
      this.state.jobs.push(job)
      this.output(job, 'qq.message.ack', {
        messageId: input.messageId,
        emojiId: [
          '268',
          '269',
          '270',
          '271',
          '272',
          '277',
          '307',
          '306',
          '281',
          '283',
          '284',
          '285',
          '286',
          '287',
          '289',
          '294',
          '297',
          '298',
          '299',
          '323',
          '475',
          '476',
          '477',
          '478',
          '479',
          '353',
          '356',
          '354',
          '352',
          '357',
          '428',
          '201',
          '317',
          '324',
          '341',
          '26',
          '27',
          '29',
          '427',
          '34',
          '38',
          '177',
          '33',
          '265',
          '264',
          '346',
          '262',
          '178',
        ][Math.floor(Math.random() * 48)]!,
        state: 'queued',
        queuePosition:
          this.state.jobs.filter((j) => j.target === target && !terminal(j)).length - 1,
      })
    }
    this.persist()
    setImmediate(() => this.tick())
    return { eventId: input.eventId, accepted }
  }
  private job(output: Outbox): Job | undefined {
    return this.state.jobs.find((j) => j.requestId === output.frame.data.requestId)
  }
  private output(
    job: Job,
    type: QQNotification['type'],
    data: Partial<QQNotification['data']>,
  ): void {
    const key = `${job.input.selfId}:${job.target}`
    const seq = (this.state.seq[key] ?? 0) + 1
    this.state.seq[key] = seq
    this.state.outbox.push({
      status: 'pending',
      frame: {
        kind: 'notification',
        type,
        data: {
          eventId: randomUUID(),
          requestId: job.requestId,
          selfId: job.input.selfId,
          conversationType: job.input.conversationType,
          targetId: job.input.targetId,
          seq,
          ...data,
        },
      },
    })
    this.persist()
  }
  private async confirm(p: QQDeliveryResultRequest) {
    const output = this.state.outbox.find((o) => o.frame.data.eventId === p.eventId)
    if (!output) fail('NOT_FOUND', 'QQ发送记录不存在')
    const d = output.frame.data,
      job = this.job(output)!
    const activity = ['qq.message.ack', 'qq.waiting', 'qq.tool.icon'].includes(output.frame.type)
    const isTerminal =
      output.frame.type === 'qq.request.failed' ||
      output.frame.type === 'qq.reply.video' ||
      output.frame.type === 'qq.reply.images' ||
      (output.frame.type === 'qq.reply.part' && d.partIndex === d.totalParts)
    if (
      p.requestId !== d.requestId ||
      p.selfId !== d.selfId ||
      p.targetId !== d.targetId ||
      p.conversationType !== d.conversationType ||
      p.seq !== d.seq ||
      p.terminal !== isTerminal ||
      (output.frame.type !== 'qq.message.ack' &&
        p.activity !== (p.status === 'sent' && activity)) ||
      (output.frame.type === 'qq.message.ack' && p.activity && p.status !== 'sent') ||
      (p.status === 'sent' &&
        ((output.frame.type !== 'qq.message.ack' && !p.messageIds.length) ||
          p.sentAt === undefined)) ||
      output.status === 'pending'
    )
      fail('INVALID_PARAMS', 'QQ发送确认不匹配')
    const hash = digest(p)
    if (output.resultHash) {
      if (output.resultHash === hash) return { eventId: p.eventId, recorded: true as const }
      if (output.status !== 'unknown' || p.status !== 'sent') fail('CONFLICT', 'QQ发送确认冲突')
    }
    output.resultHash = hash
    output.status = p.status
    output.confirmedAt = Date.now()
    if (p.status === 'unknown') {
      const running = job.state === 'running'
      job.state = 'paused'
      job.reason = 'DELIVERY_UNKNOWN'
      delete job.nextWaitAt
      if (running) void this.context.core.abort(job.conversationKey).catch(() => {})
    } else {
      if (job.reason === 'CONFIRMATION_PENDING') delete job.reason
      if (activity && (job.state === 'queued' || job.state === 'running'))
        job.nextWaitAt = Date.now() + job.snapshot.config.waitIntervalSeconds * 1000
      if (isTerminal) {
        job.state = p.status === 'sent' && job.outcome === 'completed' ? 'completed' : 'failed'
        delete job.nextWaitAt
        this.sendState(job, 'qq.reply.completed', job.state)
      }
    }
    this.persist()
    if (job.coreRequestId && this.connection) {
      const identity = await this.bindIdentity(job)
      this.handles.set(job.requestId, identity)
      await this.context.channels.reportSendResult({ connectionId: this.connection, entryId: 'qq',
        identity, requestId: job.coreRequestId, eventId: p.eventId, status: p.status, terminal: isTerminal })
    }
    if (!this.paused) setImmediate(() => this.tick())
    return { eventId: p.eventId, recorded: true as const }
  }
  private sendState(job: Job, type: QQNotification['type'], state: string): void {
    if (this.paused || !this.connection || !this.recovered) return
    this.context.connections.send(this.connection, {
      kind: 'notification',
      type,
      data: {
        eventId: randomUUID(),
        requestId: job.requestId,
        selfId: job.input.selfId,
        conversationType: job.input.conversationType,
        targetId: job.input.targetId,
        seq: this.state.seq[`${job.input.selfId}:${job.target}`] ?? 0,
        state,
      },
    })
  }
  private tick(): void {
    if (
      this.stopped ||
      this.paused ||
      !this.connection ||
      !this.recovered ||
      !this.context.connections.isOpen(this.connection)
    )
      return
    for (const target of new Set(
      this.state.jobs.filter((j) => !terminal(j)).map((j) => j.target),
    )) {
      const job = this.state.jobs.find((j) => j.target === target && !terminal(j))
      if (!job || job.state === 'paused' || this.busy.has(target)) continue
      const outputs = this.state.outbox.filter((o) => targetOf(o.frame.data) === target)
      const outstanding = outputs.find((o) => o.status === 'inflight')
      if (
        outstanding &&
        Date.now() - (outstanding.issuedAt ?? Date.now()) >= 15000 &&
        job.reason !== 'CONFIRMATION_PENDING'
      ) {
        job.reason = 'CONFIRMATION_PENDING'
        delete job.nextWaitAt
        this.persist()
      }
      if (outputs.some((o) => o.status === 'unknown' || o.status === 'inflight')) continue
      const next = outputs.find((o) => o.status === 'pending')
      if (next) {
        next.status = 'inflight'
        next.issuedAt = Date.now()
        this.persist()
        if (!this.context.connections.send(this.connection, next.frame)) {
          job.reason = 'CONFIRMATION_PENDING'
          delete job.nextWaitAt
          this.persist()
        }
        continue
      }
      if (job.state === 'queued') {
        this.busy.add(target)
        const operation = this.execute(job)
          .catch(() => this.finish(job, 'failed'))
          .finally(() => { this.busy.delete(target); this.operations.delete(operation); this.aborters.delete(job.requestId) })
        this.operations.add(operation)
      } else if (
        job.state === 'running' &&
        job.nextWaitAt !== undefined &&
        Date.now() >= job.nextWaitAt
      ) {
        const c = job.snapshot.config
        const index =
          c.waitMessageMode === 'random'
            ? Math.floor(Math.random() * c.waitMessages.length)
            : job.waits % c.waitMessages.length
        job.waits++
        delete job.nextWaitAt
        if (c.toolIconsEnabled) {
          const icons = job.pendingIcons ?? []
          if (icons.length) {
            this.output(job, 'qq.waiting', {
              text: icons.join(' '),
              policyRevision: job.snapshot.revision,
            })
            job.sentIcons = [...(job.sentIcons ?? []), ...icons]
            job.pendingIcons = []
          } else {
            job.nextWaitAt = Date.now() + c.waitIntervalSeconds * 1000
          }
          this.persist()
        } else this.output(job, 'qq.waiting', {
          text: c.waitMessages[index]!,
          policyRevision: job.snapshot.revision,
        })
      }
    }
  }
  private async execute(job: Job): Promise<void> {
    const controller = new AbortController()
    this.aborters.set(job.requestId, controller)
    const resource = this.context.core.resolvePreset(job.snapshot.preset)
    if (
      resource.presetId !== job.snapshot.presetId ||
      resource.brain !== job.snapshot.brain ||
      resource.senseGroup !== job.snapshot.senseGroup
    ) {
      job.state = 'paused'
      job.reason = 'RESOURCE_SNAPSHOT_CHANGED'
      delete job.nextWaitAt
      this.persist()
      return
    }
    if (job.douyinUrl) {
      job.state = 'running'
      this.persist()
      try {
        const {stdout} = await runFile(process.execPath, [this.context.resources.resolve('douyin-download-script'), job.douyinUrl], {timeout: 240000, maxBuffer: 1024 * 1024, signal: controller.signal})
        const result = JSON.parse(stdout.trim())
        if (!result.ok) throw new Error(result.error || 'Download failed')
        const images = result.kind === 'images'
        const files: string[] = images ? result.files : [result.file]
        if (!Array.isArray(files) || !files.length || files.length > 30 || files.some(f => typeof f !== 'string' || !(images ? /^\d+-\d+\.(?:jpg|png|gif)$/ : /^\d+\.mp4$/).test(path.basename(f)))) throw new Error('Invalid media manifest')
        if (this.stopped || this.paused) return
        job.state = 'sending'
        job.outcome = 'completed'
        delete job.nextWaitAt
        if (images) this.output(job, 'qq.reply.images', {mediaFiles: files.map(f => path.basename(f))})
        else this.output(job, 'qq.reply.video', {mediaFile: path.basename(result.file)})
        this.persist()
      } catch { this.finish(job, 'failed') }
      return
    }
    await this.context.core.ensureConversation(job.conversationKey, job.snapshot.preset)
    if (this.stopped || this.paused || job.state !== 'queued') return
    job.state = 'running'
    job.nextWaitAt ??= Date.now() + job.snapshot.config.waitIntervalSeconds * 1000
    this.persist()
    const identity = await this.bindIdentity(job)
    this.handles.set(job.requestId, identity)
    const response = await this.context.core.submit({
      entryId: 'qq', identity, signal: controller.signal,
      execution: { toolHistory: 'request', retry: 'never' },
      conversationKey: job.conversationKey,
      commandId: job.requestId,
      clientMessageId: job.input.eventId,
      messageId: `${job.requestId}:input`,
      content: job.input.content,
    })
    job.coreRequestId = response.runId
    this.persist()
  }
  private bindIdentity(job: Job): Promise<IngressIdentityHandle> {
    if (!this.connection) fail('IDENTITY_REJECTED', 'QQ连接已关闭')
    return this.context.identity.bind({ connectionId: this.connection, entryId: 'qq', channel: 'qq',
      eventId: job.input.eventId, subject: { selfId: job.input.selfId, userId: job.input.senderId,
        conversationType: job.input.conversationType,
        ...(job.input.conversationType === 'group' ? { groupId: job.input.targetId } : {}) } })
  }
  private coreEvent(key: string, event: Readonly<Record<string, unknown>>): void {
    if (this.stopped || this.paused) return
    const job = this.state.jobs.find((j) => j.conversationKey === key && j.state === 'running')
    if (!job) return
    const d = event.data as Record<string, unknown> | undefined
    if (!d) return
    if (event.type === 'sense_started') {
      const id = String(d.approvalId ?? d.id ?? '')
      if (!id || job.toolIds.includes(id)) return
      job.toolIds.push(id)
      if (job.snapshot.config.toolIconsEnabled) {
        const name =
          typeof d.senseName === 'string' && /^[a-zA-Z0-9_.-]{1,100}$/.test(d.senseName)
            ? d.senseName
            : 'unknown'
        const icon = job.snapshot.config.toolIcons[name] ?? '🔧'
        job.pendingIcons ??= []
        job.sentIcons ??= []
        if (!job.pendingIcons.includes(icon) && !job.sentIcons.includes(icon))
          job.pendingIcons.push(icon)
      }
    } else if (
      event.kind === 'chunk' &&
      event.type === 'staged' &&
      d.type === 'content_end' &&
      d.role === 'assistant' &&
      typeof d.content === 'string'
    )
      job.reply += (job.reply ? '\n\n' : '') + d.content
    else if (event.type === 'run.outcome')
      this.finish(
        job,
        d.status === 'failed' && JSON.stringify(d.feedback).includes('请求后端模型失败')
          ? 'model_failed'
          : String(d.status),
      )
    else if (event.type === 'done' && job.state === 'running') this.finish(job, 'completed')
    else if (event.type === 'error' && job.state === 'running')
      this.finish(job, JSON.stringify(d).includes('请求后端模型失败') ? 'model_failed' : 'failed')
    this.persist()
  }
  private finish(job: Job, outcome: string): void {
    if (this.stopped || this.paused || (job.state !== 'running' && job.state !== 'queued')) return
    job.outcome = outcome
    job.state = 'sending'
    delete job.nextWaitAt
    if (outcome !== 'completed')
      this.output(job, 'qq.request.failed', {
        text:
          outcome === 'model_failed'
            ? '请求后端模型失败，请稍后再试。'
            : '刚才处理失败了，请稍后再试。',
        state: outcome,
      })
    else {
      const chars = Array.from(job.reply.trim() || '这次没有生成可发送的内容。'),
        size = job.snapshot.config.maxMessageChars
      const totalParts = Math.ceil(chars.length / size)
      for (let i = 0; i < totalParts; i++)
        this.output(job, 'qq.reply.part', {
          text: chars.slice(i * size, (i + 1) * size).join(''),
          partIndex: i + 1,
          totalParts,
        })
    }
    this.persist()
  }
}
