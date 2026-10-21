import { pathToFileURL } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'
import { registerPluginResources } from './resources.js'
import { z } from 'zod'
import { getBackendLifecycle } from '../backendWork.js'
import {
  IngressRequestSchemas,
  IngressResponseSchemas,
  type IngressCapability,
} from '@chery/protocol'
import type { RpcRouter, HandlerContext } from '../message/router.js'
import { dispatch } from '@/agent/hooks/dispatch.js'
import { registerFunctionHook } from '@/agent/hooks/functions.js'
import { registerPluginSense, markPluginSensesUnavailable } from '@/core/sense/senseRegistry.js'
import {
  immutableSnapshot,
  type IngressConfigSnapshot,
  type IngressConnections,
  type IngressContext,
  type IngressCoreAdapter,
  type IngressPlugin,
  type IngressRegistration,
  type IngressStatus,
} from './api.js'
import { IngressStore, ingressError } from './store.js'
import { IngressIdentityAuthority } from './identity.js'

type Release = () => void | Promise<void>
type Prepare = () => Release
interface ActivePlugin {
  registration: IngressRegistration
  instance?: IngressPlugin
  snapshot?: Readonly<IngressConfigSnapshot>
  savedRevision: number | null
  apply: IngressStatus['apply']
  state: IngressStatus['state']
  reason?: string
  phase: 'factory' | 'management' | 'business' | 'idle'
  management: Release[]
  business: Release[]
  cleanup: Release[]
  pending: Prepare[]
  entries: Set<string>
  controller: AbortController
  order: number
  conversations: Set<string>
  requests: Map<
    string,
    {
      entryId: string
      eventId?: string
      channel?: string
      subject?: {
        selfId: string
        userId: string
        conversationType: 'private' | 'group'
        groupId?: string
      }
    }
  >
  receipts: Map<string, string>
}
type ManagementDefinition = Parameters<IngressContext['management']['register']>[0]
export interface IngressHostOptions {
  store: IngressStore
  router: RpcRouter
  core: IngressCoreAdapter
  connections: IngressConnections
  runtimeOptions?: Readonly<Record<string, string | boolean | number>>
  log?: IngressContext['log']
  coreCall?: (method: string, params: unknown) => Promise<unknown>
  stopTimeoutMs?: number
}
export class IngressHost {
  private active = new Map<string, ActivePlugin>()
  private modules = new Map<string, { owner: ActivePlugin; definition: ManagementDefinition }>()
  private starting?: Promise<void>
  private stopping?: Promise<void>
  private stopped = false
  private serial: Promise<unknown> = Promise.resolve()
  private authority: IngressIdentityAuthority
  private releaseConnectionObserver: () => void
  constructor(private readonly options: IngressHostOptions) {
    this.authority = new IngressIdentityAuthority(
      options.connections,
      (id) =>
        this.active.get(id)?.state === 'active' &&
        !this.active.get(id)?.controller.signal.aborted &&
        !this.stopped,
    )
    this.releaseConnectionObserver = options.connections.onClose((connectionId) =>
      this.authority.revokeConnection(connectionId),
    )
  }
  get extensions(): Readonly<Record<string, Readonly<IngressConfigSnapshot>>> {
    return Object.freeze(
      Object.fromEntries(
        [...this.active].flatMap(([id, active]) =>
          active.snapshot ? [[id, active.snapshot]] : [],
        ),
      ),
    )
  }
  start(): Promise<void> {
    if (this.stopped) throw ingressError('UNAVAILABLE')
    return (this.starting ??= this.startInstalled())
  }
  private async startInstalled(): Promise<void> {
    const registry = this.options.store.readRegistry()
    for (const registration of registry.plugins.sort((a, b) => a.id.localeCompare(b.id))) {
      const active: ActivePlugin = {
        registration,
        state: 'inactive',
        apply: 'pending',
        savedRevision: null,
        phase: 'factory',
        management: [],
        business: [],
        cleanup: [],
        pending: [],
        entries: new Set(),
        controller: new AbortController(),
        order: 0,
        conversations: new Set(),
        requests: new Map(),
        receipts: new Map(),
      }
      this.active.set(registration.id, active)
      try {
        const ledger = `data/${registration.id}/host-delivery.json`
        if (fs.existsSync(this.options.store.safe(ledger))) {
          const saved = deliverySchema.parse(this.options.store.readJson(ledger))
          active.requests = new Map(saved.requests)
          active.receipts = new Map(saved.receipts)
        }
        const entry = this.options.store.verify(registration)
        const module = await import(/* @vite-ignore */ pathToFileURL(entry).href)
        const instance: unknown = await module.createPlugin(this.context(active))
        if (!isPlugin(instance)) throw ingressError('INVALID_PARAMS')
        active.instance = instance
        if (active.pending.length || active.cleanup.length) throw ingressError('INVALID_PARAMS')
        const disk = this.options.store.readConfig(registration.id)
        const candidate = disk ?? {
          schemaVersion: 1 as const,
          revision: 0,
          config: instance.defaultConfig,
        }
        active.savedRevision = candidate.revision
        active.snapshot = immutableSnapshot({
          ...candidate,
          config: instance.validateConfig(candidate.config),
        })
        active.phase = 'management'
        await instance.prepareManagement?.()
        this.publish(active, active.management)
        active.phase = 'idle'
      } catch (error) {
        active.reason = safeCode(error)
        active.state = 'failed'
        active.apply = 'failed'
        await this.release(active.management)
        active.pending = []
        active.phase = 'idle'
      }
    }
    const visiting = new Set<string>()
    const visited = new Set<string>()
    let order = 0
    const activate = async (active: ActivePlugin): Promise<void> => {
      const id = active.registration.id
      if (visited.has(id)) return
      if (visiting.has(id)) throw ingressError('DEPENDENCY_CYCLE')
      visiting.add(id)
      try {
        if (!active.registration.enabled || active.state === 'failed' || this.stopped) return
        for (const dependency of [...active.registration.dependencies].sort((a, b) =>
          a.id.localeCompare(b.id),
        )) {
          const target = this.active.get(dependency.id)
          if (!target?.registration.enabled) throw ingressError('DEPENDENCY_UNAVAILABLE')
          if (target.registration.version !== dependency.version)
            throw ingressError('DEPENDENCY_VERSION_MISMATCH')
          await activate(target)
          if (target.state !== 'active')
            throw ingressError(
              target.reason === 'DEPENDENCY_CYCLE' ? 'DEPENDENCY_CYCLE' : 'DEPENDENCY_UNAVAILABLE',
            )
        }
        active.order = order++
        active.state = 'starting'
        active.phase = 'business'
        if ((await active.instance!.applyConfig(active.snapshot!)) === 'restart_required')
          throw ingressError('UNAVAILABLE')
        await active.instance!.start()
        if (this.stopped || active.controller.signal.aborted) throw ingressError('UNAVAILABLE')
        this.publish(active, active.business)
        active.state = 'active'
        active.business.push(registerPluginResources(active.registration,
          this.options.store.packageDirectory(active.registration)))
        active.apply = 'applied'
      } catch (error) {
        active.reason = safeCode(error)
        await this.stopBusiness(active)
        active.state = 'failed'
        active.apply = 'failed'
        markPluginSensesUnavailable(id, 'plugin_failed')
      } finally {
        active.phase = 'idle'
        visiting.delete(id)
        visited.add(id)
      }
    }
    for (const active of this.active.values()) await activate(active)
  }
  private publish(active: ActivePlugin, target: Release[]): void {
    try {
      for (const prepare of active.pending.splice(0)) target.push(prepare())
    } catch (error) {
      for (const release of target.splice(0).reverse()) void release()
      throw error
    }
  }
  private context(active: ActivePlugin): IngressContext {
    const { store, core, connections, router } = this.options
    const { id, version } = active.registration
    const requireCapability = (capability: IngressCapability) => {
      if (!active.registration.grantedCapabilities.includes(capability))
        throw ingressError('CAPABILITY_DENIED')
    }
    const requireActive = () => {
      if (active.state !== 'active' || this.stopped || active.controller.signal.aborted)
        throw ingressError('UNAVAILABLE')
    }
    const stage = (
      capability: IngressCapability,
      prepare: Prepare,
      management = false,
    ): (() => void) => {
      requireCapability(capability)
      if (active.phase !== (management ? 'management' : 'business'))
        throw ingressError('INVALID_PARAMS')
      let cancelled = false
      let release: Release | undefined
      active.pending.push(() => {
        if (cancelled) return () => {}
        release = prepare()
        return () => {
          if (!cancelled) {
            cancelled = true
            return release?.()
          }
        }
      })
      return () => {
        if (!cancelled) {
          cancelled = true
          void release?.()
        }
      }
    }
    const track = (release: Release): (() => void) => {
      if (active.phase !== 'business' && active.state !== 'active')
        throw ingressError('INVALID_PARAMS')
      let live = true
      const once = () => {
        if (!live) return
        live = false
        return release()
      }
      active.cleanup.push(once)
      return () => {
        void once()
      }
    }
    store.directory('config')
    return Object.freeze({
      id,
      version,
      resources: {
        resolve: (resourceId: string) => {
          if (this.stopped || active.controller.signal.aborted ||
              (active.state !== 'active' && active.phase !== 'business'))
            throw ingressError('UNAVAILABLE')
          const resource = active.registration.resources?.find(item => item.id === resourceId)
          if (!resource) throw ingressError('INVALID_PARAMS')
          return path.join(store.packageDirectory(active.registration), resource.path)
        },
      },
      configDir: store.safe('config'),
      dataDir: store.directory(`data/${id}`),
      runtimeOptions: immutableSnapshot(this.options.runtimeOptions ?? {}),
      lifecycle: (() => {
        const lifecycle = getBackendLifecycle()
        if (!lifecycle) return undefined
        return {
          snapshot: lifecycle.snapshot,
          subscribe: (listener: Parameters<typeof lifecycle.subscribe>[0]) => track(lifecycle.subscribe(listener)),
          blockers: (provider: Parameters<typeof lifecycle.blockers>[0]) => track(lifecycle.blockers(() =>
            provider().map((item) => ({ ...item, id: `${id}:${item.id}` })))),
        }
      })(),
      isEnabled: () =>
        this.options.store.readRegistry().plugins.some((entry) => entry.id === id && entry.enabled),
      defer: (cleanup: Release) => {
        track(cleanup)
      },
      log: (event: string, fields?: Record<string, string | number | boolean | null>) => {
        if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(event)) return
        const metadata: Record<string, string | number | boolean | null> = { pluginId: id, version }
        for (const key of ['revision', 'count']) {
          const value = fields?.[key]
          if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) metadata[key] = value
        }
        for (const key of ['enabled', 'paused', 'success']) {
          const value = fields?.[key]
          if (typeof value === 'boolean') metadata[key] = value
        }
        // Attachment diagnostics are an explicit contract, not arbitrary plugin strings.
        if (event === 'qq.attachment.unavailable' && id === 'cherynyxus-qq-module') {
          if (typeof fields?.stage === 'string' && ['import', 'validate', 'refresh', 'download', 'invalid', 'permission'].includes(fields.stage)) metadata.stage = fields.stage
          if (typeof fields?.code === 'string' && (/^HTTP_[45][0-9]{2}$/.test(fields.code) || ['UNAVAILABLE', 'REMOTE_ADDRESS_REJECTED', 'EAI_ADDRFAMILY', 'ENOTFOUND', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ERR_INVALID_IP_ADDRESS', 'IDENTITY_REJECTED', 'FILE_DOWNLOAD_FAILED', 'FILE_INVALID', 'FILE_PERMISSION_DENIED'].includes(fields.code))) metadata.code = fields.code
          if (typeof fields?.messageId === 'string' && /^(?:[0-9]{1,20}|redacted)$/.test(fields.messageId)) metadata.messageId = fields.messageId
          if (typeof fields?.requestId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(fields.requestId)) metadata.requestId = fields.requestId
          if (typeof fields?.attachmentIndex === 'number' && Number.isSafeInteger(fields.attachmentIndex) && fields.attachmentIndex >= 0 && fields.attachmentIndex <= 10000) metadata.attachmentIndex = fields.attachmentIndex
        }
        this.options.log?.(event, metadata)
      },
      config: {
        snapshot: <T = unknown>() => {
          if (!active.snapshot) throw ingressError('UNAVAILABLE')
          return active.snapshot as Readonly<IngressConfigSnapshot<T>>
        },
        saved: <T = unknown>() => {
          const value = store.readConfig(id) ?? active.snapshot
          if (!value) throw ingressError('UNAVAILABLE')
          return immutableSnapshot(value) as Readonly<IngressConfigSnapshot<T>>
        },
        save: (config: unknown, expectedBaseRevision: number) =>
          this.saveConfig(id, config, expectedBaseRevision),
      },
      core: {
        sourceReferences: async key=>{requireActive();if(!active.conversations.has(key))throw ingressError('IDENTITY_REJECTED');return core.sourceReferences?core.sourceReferences(id,key):{}},
        abortSources: async keys=>{if(core.abortSources)await core.abortSources(id,keys)},
        restrictSources: async keys => {if(core.restrictSources)await core.restrictSources(id,keys)},
        publishSource: async (input) => {
          requireActive()
          if (!core.publishSource || !active.entries.has(input.entryId) || !active.conversations.has(input.conversationKey)) throw ingressError('IDENTITY_REJECTED')
          const {conversationKey,identity,signal,...params}=input
          const record=this.authority.validate(id,params.entryId,identity)
          if(record.purpose!=='source' || record.eventId!==params.sourceKey) throw ingressError('IDENTITY_REJECTED')
          const requestIdentity=this.authority.project(id,params.entryId,identity)
          return core.publishSource(id,conversationKey,{...params,requestIdentity,signal,
            validateIdentity:()=>{requireActive();this.authority.validate(id,params.entryId,identity)}})
        },
        importFile: async (input: Parameters<NonNullable<IngressContext['core']['importFile']>>[0]) => {
          requireActive()
          if (!core.importFile || !active.entries.has(input.entryId) || !active.conversations.has(input.conversationKey)) throw ingressError('IDENTITY_REJECTED')
          const { conversationKey, identity, signal, ...params } = input
          this.authority.validate(id, params.entryId, identity)
          if (this.authority.validate(id,params.entryId,identity).purpose === 'source') throw ingressError('IDENTITY_REJECTED')
          const requestIdentity = this.authority.project(id, params.entryId, identity)
          const combined = signal ? AbortSignal.any([signal, active.controller.signal]) : active.controller.signal
          combined.throwIfAborted()
          const result = await core.importFile(id, conversationKey, { ...params, requestIdentity, signal: combined,
            validateIdentity: () => { requireActive(); this.authority.project(id, params.entryId, identity) } })
          requireActive()
          this.authority.project(id, params.entryId, identity)
          return result
        },
        readFileChunk: async (input: Parameters<NonNullable<IngressContext['core']['readFileChunk']>>[0]) => {
          requireActive()
          if (!core.readFileChunk || !active.entries.has(input.entryId) || !active.conversations.has(input.conversationKey)) throw ingressError('IDENTITY_REJECTED')
          const { conversationKey, identity, signal, ...params } = input
          this.authority.validate(id, params.entryId, identity)
          if(this.authority.validate(id,params.entryId,identity).purpose==='source')throw ingressError('IDENTITY_REJECTED')
          const requestIdentity = this.authority.project(id, params.entryId, identity)
          const combined = signal ? AbortSignal.any([signal, active.controller.signal]) : active.controller.signal
          combined.throwIfAborted()
          const result = await core.readFileChunk(id, conversationKey, { ...params, requestIdentity, signal: combined,
            validateIdentity: () => { requireActive(); this.authority.project(id, params.entryId, identity) } })
          requireActive()
          this.authority.project(id, params.entryId, identity)
          return result
        },
        recentConversationMessages: async (key: string, count: number) => {
          requireActive()
          if (!active.conversations.has(key) || !core.recentConversationMessages) throw ingressError('IDENTITY_REJECTED')
          if (!Number.isInteger(count) || count < 1 || count > 100) throw ingressError('INVALID_PARAMS')
          const result = await core.recentConversationMessages(id, key, count)
          requireActive()
          return result
        },
        conversationHistory: async (key: string) => {
          requireActive()
          if (!active.conversations.has(key) || !core.conversationHistory) throw ingressError('IDENTITY_REJECTED')
          const result = await core.conversationHistory(id, key)
          requireActive()
          return result
        },
        commitSummary: async (key: string, summary: string) => {
          requireActive()
          if (!active.conversations.has(key) || !core.commitSummary) throw ingressError('IDENTITY_REJECTED')
          await core.commitSummary(id, key, summary)
          requireActive()
        },
        internalText: async (input: Parameters<NonNullable<IngressContext['core']['internalText']>>[0]) => {
          requireActive()
          if (!core.internalText) throw ingressError('NOT_SUPPORTED')
          if (input.instruction.length > 20000 || input.content.length > 200000) throw ingressError('INVALID_PARAMS')
          const text = await core.internalText(id, { ...input, signal: input.signal ? AbortSignal.any([input.signal, active.controller.signal]) : active.controller.signal })
          requireActive()
          return text
        },
        listPresets: () => immutableSnapshot(core.listPresets()),
        resolvePreset: (name: string) => immutableSnapshot(core.resolvePreset(name)),
        ensureConversation: async (key: string, preset: string) => {
          requireActive()
          const result = await core.ensureConversation(id, key, preset)
          requireActive()
          active.conversations.add(key)
          return result
        },
        answerQuestions: async (input) => {
          requireActive()
          input = z.object({conversationKey:z.string().min(1).max(512),entryId:z.string().min(1),identity:z.custom<import('./api.js').IngressIdentityHandle>(),
            runId:z.string().min(1).max(200),batchId:z.string().min(1).max(200),commandId:z.string().uuid(),signal:z.custom<AbortSignal>().optional(),
            answers:z.array(z.object({questionId:z.string().min(1).max(200),selectedLabels:z.array(z.string().max(1000)).max(4),freeText:z.string().max(20000).optional(),cancelled:z.boolean().optional()}).strict()).min(1).max(16)}).strict().parse(input)
          if (!core.answerQuestions || !active.entries.has(input.entryId) || !active.conversations.has(input.conversationKey)) throw ingressError('IDENTITY_REJECTED')
          const record = this.authority.validate(id, input.entryId, input.identity)
          const original = active.requests.get(input.runId)
          if (record.purpose === 'source' || record.channel !== 'qq' || original?.channel !== 'qq' ||
            original.entryId !== input.entryId || !original.subject || ['selfId','userId','conversationType','groupId'].some(field => original.subject![field as keyof typeof original.subject] !== record.subject[field as keyof typeof record.subject])) throw ingressError('IDENTITY_REJECTED')
          const { conversationKey, identity, ...params } = input
          const requestIdentity = this.authority.project(id, input.entryId, identity)
          const result = await core.answerQuestions(id, conversationKey, { ...params, requestIdentity,
            validateIdentity: () => { requireActive(); this.authority.validate(id, input.entryId, identity) } })
          active.requests.set(result.runId, original)
          this.persistDelivery(active)
          return result
        },
        submit: async (input: Parameters<IngressContext['core']['submit']>[0]) => {
          requireActive()
          if (
            !active.entries.has(input.entryId) ||
            !active.conversations.has(input.conversationKey) ||
            'platformIdentity' in input ||
            'contextLimit' in input ||
            (input.execution !== undefined &&
              (input.execution.toolHistory !== 'request' ||
                input.execution.retry !== 'never' ||
                Object.keys(input.execution).some(
                  (key) => !['toolHistory', 'retry'].includes(key),
                )))
          )
            throw ingressError('IDENTITY_REJECTED')
          const { conversationKey, identity, signal, ...params } = input
          const requestIdentity = this.authority.project(id, params.entryId, identity)
          const record = identity
            ? this.authority.validate(id, params.entryId, identity)
            : undefined
          if (record?.purpose === 'source') throw ingressError('IDENTITY_REJECTED')
          const combined = signal
            ? AbortSignal.any([signal, active.controller.signal])
            : active.controller.signal
          combined.throwIfAborted()
          const response = await core.submit(id, conversationKey, {
            ...params,
            requestIdentity,
            signal: combined,
            validateIdentity: () => {
              requireActive()
              if (record?.channel === 'qq' && identity)
                this.authority.validateExecution(id, params.entryId, identity)
              else this.authority.project(id, params.entryId, identity)
            },
          })
          requireActive()
          active.requests.set(response.runId, {
            entryId: params.entryId,
            eventId: record?.eventId,
            channel: record?.channel,
            subject: record?.subject,
          })
          this.persistDelivery(active)
          return response
        },
        abort: (key: string) => core.abort(id, key),
        onEvent: (listener: Parameters<IngressContext['core']['onEvent']>[0]) =>
          track(
            core.onEvent(id, (key, event) => {
              if (active.state === 'active' && !this.stopped)
                listener(key, immutableSnapshot(event))
            }),
          ),
      },
      connections: {
        credentialKind: (connectionId: string) => connections.credentialKind(connectionId),
        isOpen: (connectionId: string) => connections.isOpen(connectionId),
        send: (connectionId: string, event: unknown) => {
          requireActive()
          return connections.send(connectionId, event)
        },
        onClose: (listener: (connectionId: string) => void) =>
          track(
            connections.onClose((connectionId) => {
              if (active.state === 'active') listener(connectionId)
            }),
          ),
      },
      rpc: {
        register: <P, R>(
          definition: import('./api.js').IngressRpcRegistration<P, R> & {
            scope: 'business' | 'management'
          },
        ) => {
          if (!definition.method.startsWith(`${active.registration.rpcNamespace ?? id}.`))
            throw ingressError('CAPABILITY_DENIED')
          const management = definition.scope === 'management'
          return stage(
            management ? 'rpc.management' : 'rpc.business',
            () =>
              router.registerExtension({
                ...definition,
                authorize: (ctx) =>
                  (management
                    ? ctx.credentialKind === 'control'
                    : active.state === 'active' && !active.controller.signal.aborted) &&
                  definition.authorize(ctx),
              }),
            management,
          )
        },
      },
      tools: {
        register: (definition: Parameters<IngressContext['tools']['register']>[0]) =>
          stage('tools', () =>
            registerPluginSense(definition.sense, {
              source: 'plugin',
              pluginId: id,
              pluginVersion: version,
              channels: active.registration.channelGrants.map((grant) => grant.channel),
              metadata: immutableSnapshot(definition.metadata),
              available: () => active.state === 'active' && !active.controller.signal.aborted,
            }),
          ),
      },
      hooks: {
        register: <E extends import('@/agent/hooks/types.js').HookEvent>(
          definition: import('@/agent/hooks/types.js').IngressHookRegistration<E>,
        ) =>
          stage('hooks', () =>
            registerFunctionHook(
              id,
              active.order,
              active.registration.channelGrants.map((grant) => grant.channel),
              active.controller.signal,
              definition as import('@/agent/hooks/types.js').IngressHookRegistration,
            ),
          ),
      },
      ingress: {
        register: ({ id: entryId }: { id: string }) =>
          stage('ingress', () => {
            if (!/^[a-z][a-z0-9_.-]{0,127}$/.test(entryId) || active.entries.has(entryId))
              throw ingressError('REGISTRATION_CONFLICT')
            active.entries.add(entryId)
            return () => {
              active.entries.delete(entryId)
            }
          }),
      },
      identity: {
        registerChannel: (
          definition: Parameters<IngressContext['identity']['registerChannel']>[0],
        ) =>
          stage('channel.identity', () => this.authority.register(active.registration, definition)),
        bind: (input: Parameters<IngressContext['identity']['bind']>[0]) => {
          requireActive()
          if (!active.entries.has(input.entryId)) throw ingressError('IDENTITY_REJECTED')
          return this.authority.bind(active.registration, input)
        },
      },
      channels: {
        reportSendResult: async (
          input: Parameters<IngressContext['channels']['reportSendResult']>[0],
        ) => {
          requireActive()
          requireCapability('channel.identity')
          const identity = this.authority.validate(id, input.entryId, input.identity)
          const request = active.requests.get(input.requestId)
          if (
            !request ||
            request.entryId !== input.entryId ||
            request.eventId !== identity.eventId ||
            request.channel !== identity.channel ||
            JSON.stringify(request.subject) !== JSON.stringify(identity.subject) ||
            identity.connectionId !== input.connectionId ||
            !input.eventId
          )
            throw ingressError('IDENTITY_REJECTED')
          const key = `${input.requestId}:${input.eventId}`
          const previous = active.receipts.get(key)
          if (previous === input.status || previous === 'sent') return
          active.receipts.set(key, input.status)
          this.persistDelivery(active)
          await dispatch(
            'ChannelSendResult',
            {
              requestId: input.requestId,
              eventId: input.eventId,
              channel: identity.channel,
              status: input.status,
              terminal: input.terminal,
              recordedAt: Date.now(),
            },
            { brain: '', requestId: input.requestId },
          )
        },
      },
      appNotifications: id === 'qq' ? {
        claim: async (selfId: string) => {
          const { ControllerSocketClient } = await import('../managedApp/socketRpc.js')
          return new ControllerSocketClient().call<Awaited<ReturnType<NonNullable<IngressContext['appNotifications']>['claim']>>>('claimAppNotifications', { selfId }, 5000)
        },
        report: async (selfId: string, notificationId: string, status: 'sent' | 'failed' | 'unknown') => {
          const { ControllerSocketClient } = await import('../managedApp/socketRpc.js')
          await new ControllerSocketClient().call('reportAppNotification', { selfId, notificationId, status }, 5000)
        },
      } : undefined,
      management: {
        register: (definition: ManagementDefinition) => {
          requireCapability('manager.ui')
          return stage(
            'rpc.management',
            () => {
              const descriptor = active.registration.ui?.find((ui) => ui.id === definition.moduleId)
              if (!descriptor || this.modules.has(definition.moduleId))
                throw ingressError('REGISTRATION_CONFLICT')
              const paths = new Set<string>()
              for (const route of definition.routes) {
                if (
                  !/^(?:[a-z][a-z0-9-]*|:kind)(?:\/(?:[a-z][a-z0-9-]*|:kind))*$/.test(route.path) ||
                  !route.rpcMethod.startsWith(`${active.registration.rpcNamespace ?? id}.`) ||
                  paths.has(`${route.method}:${route.path}`)
                )
                  throw ingressError('INVALID_PARAMS')
                paths.add(`${route.method}:${route.path}`)
              }
              const item = { owner: active, definition }
              this.modules.set(definition.moduleId, item)
              return () => {
                if (this.modules.get(definition.moduleId) === item)
                  this.modules.delete(definition.moduleId)
              }
            },
            true,
          )
        },
        coreCall: (method: string, params: unknown) => {
          requireCapability('rpc.management')
          if (!CORE_MANAGEMENT.has(method) || !this.options.coreCall)
            throw ingressError('CAPABILITY_DENIED')
          return this.options.coreCall(method, params)
        },
      },
    })
  }
  private persistDelivery(active: ActivePlugin): void {
    this.options.store.directory(`data/${active.registration.id}`)
    this.options.store.atomicJson(`data/${active.registration.id}/host-delivery.json`, {
      requests: [...active.requests],
      receipts: [...active.receipts],
    })
  }
  private queue<T>(action: () => Promise<T>): Promise<T> {
    const work = this.serial.then(action)
    this.serial = work.catch(() => {})
    return work
  }
  saveConfig(id: string, config: unknown, expectedBaseRevision: number) {
    return this.queue(async () => {
      const active = this.active.get(id)
      if (!active?.instance || this.stopped || active.state === 'stopping')
        throw ingressError('UNAVAILABLE')
      const saved = immutableSnapshot(
        this.options.store.saveConfig(
          id,
          active.instance.validateConfig(config),
          expectedBaseRevision,
        ),
      )
      active.savedRevision = saved.revision
      active.apply = 'pending'
      if (active.state === 'active') {
        try {
          const signal = active.controller.signal
          const result = await new Promise<void | 'restart_required'>((resolve, reject) => {
            const cancelled = () => reject(ingressError('UNAVAILABLE'))
            signal.addEventListener('abort', cancelled, { once: true })
            if (signal.aborted) cancelled()
            else {
              Promise.resolve()
                .then(() => active.instance!.applyConfig(saved))
                .then(resolve, reject)
                .finally(() => signal.removeEventListener('abort', cancelled))
            }
          })
          if (signal.aborted || this.stopped || this.active.get(id) !== active)
            throw ingressError('UNAVAILABLE')
          if (result === 'restart_required') active.apply = 'restart_required'
          else {
            active.snapshot = saved
            active.apply = 'applied'
            delete active.reason
          }
        } catch {
          if (!active.controller.signal.aborted && !this.stopped) {
            active.apply = 'failed'
            active.reason = 'CONFIG_APPLY_FAILED'
          }
        }
      }
      return {
        snapshot: saved,
        apply: {
          state: active.apply,
          revision: saved.revision,
          ...(active.reason ? { reason: active.reason } : {}),
        },
      }
    })
  }
  disable(id: string): Promise<void> {
    this.fence(id)
    return this.queue(() => this.disableNow(id))
  }
  private fence(id: string): void {
    const affected = new Set([id])
    let added = true
    while (added) {
      added = false
      for (const active of this.active.values())
        if (
          active.registration.dependencies.some((dep) => affected.has(dep.id)) &&
          !affected.has(active.registration.id)
        ) {
          affected.add(active.registration.id)
          added = true
        }
    }
    for (const active of this.active.values())
      if (affected.has(active.registration.id)) {
        active.controller.abort()
        active.apply = 'pending'
        this.authority.revoke(active.registration.id)
      }
  }
  private async disableNow(id: string): Promise<void> {
    const affected = new Set([id])
    let added = true
    while (added) {
      added = false
      for (const active of this.active.values())
        if (
          active.registration.dependencies.some((dep) => affected.has(dep.id)) &&
          !affected.has(active.registration.id)
        ) {
          affected.add(active.registration.id)
          added = true
        }
    }
    for (const active of [...this.active.values()]
      .filter((item) => affected.has(item.registration.id))
      .sort((a, b) => b.order - a.order)) {
      await this.options.core.restrictSources?.(active.registration.id,[])
      await this.stopBusiness(active)
      if (active.registration.id !== id) active.reason = 'DEPENDENCY_UNAVAILABLE'
    }
  }
  async uninstall(id: string, expectedRevision?: number): Promise<void> {
    this.fence(id)
    return this.queue(async () => {
      if (
        expectedRevision !== undefined &&
        this.options.store.readRegistry().revision !== expectedRevision
      )
        throw ingressError('REVISION_CONFLICT')
      await this.disableNow(id)
      const active = this.active.get(id)
      if (active?.reason === 'STOP_TIMEOUT') throw ingressError('STOP_TIMEOUT')
      if (active) await this.release(active.management)
      this.options.store.uninstall(id, expectedRevision)
      this.active.delete(id)
      markPluginSensesUnavailable(id, 'plugin_uninstalled')
    })
  }
  status(): IngressStatus[] {
    const registry = this.options.store.readRegistry()
    return [...new Set([...registry.plugins.map((item) => item.id), ...this.active.keys()])]
      .sort()
      .map((id) => {
        const saved = registry.plugins.find((item) => item.id === id)
        const active = this.active.get(id)
        return {
          id,
          apiVersion: 2,
          installed: !!saved,
          enabled: saved?.enabled ?? false,
          savedVersion: saved?.version ?? null,
          activeVersion: active?.state === 'active' ? active.registration.version : null,
          state: active?.state ?? 'inactive',
          requiresRestart:
            (!!saved &&
              (!active ||
                saved.version !== active.registration.version ||
                (saved.enabled && active.state !== 'active'))) ||
            active?.apply === 'restart_required',
          savedRevision: active?.savedRevision ?? null,
          appliedRevision: active?.snapshot?.revision ?? null,
          apply: active?.apply ?? 'pending',
          grantedCapabilities: saved?.grantedCapabilities ?? [],
          dependencies: saved?.dependencies ?? [],
          ...(active?.reason ? { reason: active.reason } : {}),
        }
      })
  }
  uiList() {
    return [...this.modules.values()].map(({ owner, definition }) => ({
      pluginId: owner.registration.id,
      pluginVersion: owner.registration.version,
      apiVersion: 2 as const,
      descriptor: owner.registration.ui!.find((ui) => ui.id === definition.moduleId)!,
      enabled: this.status().find((item) => item.id === owner.registration.id)!.enabled,
      businessState: owner.state,
      routes: definition.routes.map(({ method, path }) => ({ method, path })),
    }))
  }
  uiRegistration(pluginId: string, moduleId: string, resourceVersion: string) {
    const module = this.modules.get(moduleId)
    const registration = module?.owner.registration
    if (!registration || registration.id !== pluginId) throw ingressError('UNAVAILABLE')
    const descriptor = registration.ui?.find(
      (ui) => ui.id === moduleId && ui.resourceVersion === resourceVersion,
    )
    if (!descriptor) throw ingressError('UNAVAILABLE')
    return { registration, descriptor }
  }
  async managementCall(
    input: import('zod').infer<(typeof IngressRequestSchemas)['ingress.management.call']>,
    ctx: HandlerContext,
  ) {
    if (ctx.credentialKind !== 'control' && ctx.credentialKind !== 'machine') throw ingressError('CAPABILITY_DENIED')
    const module = this.modules.get(input.moduleId)
    if (!module) throw ingressError('UNAVAILABLE')
    const route = module.definition.routes.find(
      (route) => route.method === input.method && route.path === input.path,
    )
    if (!route) throw ingressError('INVALID_PARAMS')
    const parsed = route.requestSchema.safeParse({
      pathParams: input.pathParams,
      query: input.query,
      ...(input.body !== undefined ? { body: input.body } : {}),
    })
    if (!parsed.success) throw ingressError('INVALID_PARAMS')
    let result: unknown
    try {
      result = await route.handler(parsed.data as Parameters<typeof route.handler>[0], ctx)
    } catch (error) {
      const failure = error as { code?: unknown; status?: unknown }
      if (
        typeof failure.code === 'string' &&
        /^[a-z][a-z0-9_]+$/.test(failure.code) &&
        typeof failure.status === 'number' &&
        failure.status >= 400 &&
        failure.status <= 599
      ) {
        return IngressResponseSchemas['ingress.management.call'].parse({
          contractVersion: 2,
          status: failure.status,
          body: {
            error: { code: failure.code, message: '管理操作未完成，请核对输入、版本与后端状态' },
          },
        })
      }
      throw error
    }
    return IngressResponseSchemas['ingress.management.call'].parse({
      contractVersion: 2,
      status: 200,
      body: { data: route.responseSchema.parse(result) },
    })
  }
  stop(): Promise<void> {
    return (this.stopping ??= (async () => {
      this.stopped = true
      this.releaseConnectionObserver()
      for (const active of this.active.values()) this.fence(active.registration.id)
      await this.starting
      for (const active of [...this.active.values()].sort((a, b) => b.order - a.order)) {
        await this.stopBusiness(active)
        await this.release(active.management)
      }
    })())
  }
  private async release(items: Release[]): Promise<void> {
    for (const cleanup of items.splice(0).reverse()) {
      try {
        await cleanup()
      } catch {}
    }
  }
  private async stopBusiness(active: ActivePlugin): Promise<void> {
    if (active.reason === 'STOP_TIMEOUT') return
    if (active.state === 'stopped' || (active.state === 'inactive' && !active.cleanup.length))
      return
    active.state = 'stopping'
    active.controller.abort()
    this.authority.revoke(active.registration.id)
    await this.release(active.business)
    active.pending = []
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const cleanup = (async () => {
          await Promise.all(
            [...active.conversations].map((key) =>
              this.options.core.abort(active.registration.id, key).catch(() => {}),
            ),
          )
          try {
            await active.instance?.stop()
          } finally {
            await this.release(active.cleanup)
          }
        })()
      // Ordinary Backend cleanup has no hidden kill/timeout. User force-stop is bounded by its parents.
      if (getBackendLifecycle()?.snapshot().desiredState === 'stopped') await cleanup
      else await Promise.race([cleanup, new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(ingressError('STOP_TIMEOUT')),
            Math.min(30000, this.options.stopTimeoutMs ?? 30000),
          )
        })])
      active.state = 'stopped'
    } catch {
      active.state = 'failed'
      active.reason = 'STOP_TIMEOUT'
    } finally {
      if (timer) clearTimeout(timer)
      markPluginSensesUnavailable(active.registration.id, 'plugin_disabled')
    }
  }
}
const CORE_MANAGEMENT = new Set([
  'config.preview',
  'config.get',
  'config.save',
  'config.apply.status',
  'brain.list',
  'sense.list',
  'sense.tools',
  'utils.models',
  'utils.modelRecommendation',
  'prompts.preset.get',
  'prompts.preset.save',
  'search.test',
  'search.settings.get',
  'search.settings.save',
])
const deliverySchema = z
  .object({
    requests: z.array(
      z.tuple([
        z.string(),
        z
          .object({
            entryId: z.string(),
            eventId: z.string().optional(),
            channel: z.string().optional(),
            subject: z
              .object({
                selfId: z.string(),
                userId: z.string(),
                conversationType: z.enum(['private', 'group']),
                groupId: z.string().optional(),
              })
              .strict()
              .optional(),
          })
          .strict(),
      ]),
    ),
    receipts: z.array(z.tuple([z.string(), z.enum(['sent', 'unknown'])])),
  })
  .strict()
function safeCode(error: unknown): string {
  const code = (error as { code?: string })?.code
  return code &&
    /^(?:DEPENDENCY_[A-Z_]+|REGISTRATION_CONFLICT|CAPABILITY_DENIED|INVALID_PARAMS|API_VERSION_MISMATCH)$/.test(
      code,
    )
    ? code
    : 'PLUGIN_START_FAILED'
}
function isPlugin(value: unknown): value is IngressPlugin {
  return (
    !!value &&
    typeof value === 'object' &&
    Object.hasOwn(value, 'defaultConfig') &&
    ['validateConfig', 'applyConfig', 'start', 'stop'].every(
      (key) => typeof (value as Record<string, unknown>)[key] === 'function',
    )
  )
}
