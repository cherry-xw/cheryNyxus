import type { z } from 'zod'
export interface HandlerContext { requestId?: string; connectionId: string; credentialKind?: string; log: { event(type: string, data?: Record<string, unknown>, level?: number): void; debug(...args: unknown[]): void; info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void } }
import type { ChatInputSubmitRequest as ChatInputSubmitRequestData, ChatInputSubmitResponse as ChatInputSubmitResponseData } from '@chery/protocol'
import type { Sense, SenseFunction } from './sense.js'
import type { IngressHookRegistration } from './hooks.js'
import type { AssetRecord, IngressCapability, IngressStatus, IngressUiDescriptor } from '@chery/protocol'
export type { IngressCapability, IngressStatus, IngressUiDescriptor, IngressHookRegistration }

export interface IngressResource {
  id: string
  kind: 'skill' | 'script'
  path: string
  channel?: string
}
export interface IngressManifest {
  resources?: IngressResource[]
  id: string
  version: string
  apiVersion: 2
  entry: string
  dependencies: Array<{ id: string; version: string }>
  capabilities: IngressCapability[]
  ui?: IngressUiDescriptor[]
  /** Protocol namespace may differ from the package identity (for example qq.*). */
  rpcNamespace?: string
}
export interface IngressRegistration extends IngressManifest {
  enabled: boolean
  packageDigest: string
  grantedCapabilities: IngressCapability[]
  channelGrants: Array<{ channel: string; credentialKind: string }>
}
export interface IngressRegistry {
  schemaVersion: 2
  revision: number
  plugins: IngressRegistration[]
}
export interface IngressConfigSnapshot<T = unknown> {
  schemaVersion: 1
  revision: number
  config: T
}
export type IngressApplyState = 'applied' | 'pending' | 'failed' | 'restart_required'
declare const identityBrand: unique symbol
export interface IngressIdentityHandle {
  readonly [identityBrand]: true
}
export interface IngressSubject {
  selfId: string
  userId: string
  conversationType: 'private' | 'group'
  groupId?: string
}
export interface IngressRequestIdentity {
  source: 'web' | 'plugin'
  ownerId?: string
  entryId?: string
  channel?: string
  subject?: IngressSubject
}
export interface IngressUnavailableTool {
  name: string
  source?: 'builtin' | 'custom' | 'mcp' | 'plugin'
  pluginId?: string
  reason:
    'plugin_disabled' | 'plugin_uninstalled' | 'plugin_failed' | 'not_found' | 'identity_required'
}
export interface IngressRequestTool {
  name: string
  source: 'builtin' | 'custom' | 'mcp' | 'plugin'
  pluginId?: string
  pluginVersion?: string
  definition: SenseFunction
  supervisionLevel: number
}
export interface IngressRequestContext {
  ownerId: string
  key: string
  content: string
  configRevision: number
}
export interface IngressRequestView {
  requestId: string
  inputId: string
  chatId: string
  preparedAt: number
  configRevision: string
  registryVersion: number
  identity: IngressRequestIdentity
  tools: IngressRequestTool[]
  unavailableTools: IngressUnavailableTool[]
  contexts: IngressRequestContext[]
}
export type IngressSubmit = Omit<
  ChatInputSubmitRequestData,
  'chatId' | 'platformIdentity' | 'contextLimit'
> & {
  conversationKey: string
  entryId: string
  identity?: IngressIdentityHandle
  signal?: AbortSignal
  execution?: { toolHistory: 'request'; retry: 'never' }
}
export interface IngressPreset {
  name: string
  presetId: string
  leaderName: string
  brain: string
  senseGroup: string
  mcpServers: readonly string[]
}
export interface IngressInternalTextInput { preset: string; instruction: string; content: string; signal?: AbortSignal }
export interface IngressFileContext {
  conversationKey: string
  entryId: string
  identity: IngressIdentityHandle
  signal?: AbortSignal
}
export interface IngressFileImport extends IngressFileContext {
  originalName: string
  mimeType: string
  source: { data: Uint8Array } | { url: string }
}
export interface IngressFileRead extends IngressFileContext {
  assetId: string
  assetVersionId: string
  offset: number
}
export interface IngressFileChunk {
  asset: AssetRecord
  offset: number
  dataBase64: string
  eof: boolean
}
export interface IngressFileAuthorization {
  requestIdentity: IngressRequestIdentity
  validateIdentity(): void
}
export interface IngressCore {
  importFile?(input: IngressFileImport): Promise<AssetRecord>
  readFileChunk?(input: IngressFileRead): Promise<IngressFileChunk>
  internalText?(input: IngressInternalTextInput): Promise<string>
  listPresets(): readonly { name: string; presetId: string }[]
  resolvePreset(name: string): Readonly<IngressPreset>
  ensureConversation(key: string, preset: string): Promise<{ chatId: string }>
  submit(input: IngressSubmit): Promise<ChatInputSubmitResponseData>
  recentConversationMessages?(conversationKey: string, count: number): Promise<string>
  conversationHistory?(conversationKey: string): Promise<string>
  commitSummary?(conversationKey: string, summary: string): Promise<void>
  abort(conversationKey: string): Promise<void>
  onEvent(
    listener: (conversationKey: string, event: Readonly<Record<string, unknown>>) => void,
  ): () => void
}
/** Host adapters are injectable without giving a plugin access to arbitrary RPCs. */
export interface IngressCoreAdapter {
  importFile?(ownerId: string, key: string, input: Omit<IngressFileImport, 'conversationKey' | 'identity'> & IngressFileAuthorization): Promise<AssetRecord>
  readFileChunk?(ownerId: string, key: string, input: Omit<IngressFileRead, 'conversationKey' | 'identity'> & IngressFileAuthorization): Promise<IngressFileChunk>
  internalText?(ownerId: string, input: IngressInternalTextInput): Promise<string>
  listPresets(): readonly { name: string; presetId: string }[]
  resolvePreset(name: string): Readonly<IngressPreset>
  ensureConversation(ownerId: string, key: string, preset: string): Promise<{ chatId: string }>
  submit(
    ownerId: string,
    key: string,
    input: Omit<IngressSubmit, 'conversationKey' | 'identity'> & {
      requestIdentity: IngressRequestIdentity
      validateIdentity(): void
    },
  ): Promise<ChatInputSubmitResponseData>
  recentConversationMessages?(ownerId: string, key: string, count: number): Promise<string>
  conversationHistory?(ownerId: string, key: string): Promise<string>
  commitSummary?(ownerId: string, key: string, summary: string): Promise<void>
  abort(ownerId: string, key: string): Promise<void>
  onEvent(
    ownerId: string,
    listener: (key: string, event: Readonly<Record<string, unknown>>) => void,
  ): () => void
}
export interface IngressRpcRegistration<P, R> {
  scope?: 'business' | 'management'
  method: string
  request: z.ZodType<P>
  response: z.ZodType<R>
  authorize(ctx: HandlerContext): boolean | Promise<boolean>
  handler(ctx: HandlerContext, params: P): Promise<R>
}
export interface IngressConnections {
  credentialKind(connectionId: string): string | undefined
  isOpen(connectionId: string): boolean
  send(connectionId: string, event: unknown): boolean
  onClose(listener: (connectionId: string) => void): () => void
}
export interface IngressConfigApi {
  snapshot<T = unknown>(): Readonly<IngressConfigSnapshot<T>>
  /** Saved file view can differ from the applied request snapshot after failure. */
  saved<T = unknown>(): Readonly<IngressConfigSnapshot<T>>
  save(
    config: unknown,
    expectedBaseRevision: number,
  ): Promise<{
    snapshot: Readonly<IngressConfigSnapshot>
    apply: { state: IngressApplyState; revision: number; reason?: string }
  }>
}
export interface IngressContext {
  readonly id: string
  readonly version: string
  readonly resources: { resolve(id: string): string }
  readonly configDir: string
  readonly dataDir: string
  readonly runtimeOptions: Readonly<Record<string, string | boolean | number>>
  /** Saved registry state; may differ from the still-running package until restart. */
  readonly isEnabled: () => boolean
  readonly core: IngressCore
  readonly connections: IngressConnections
  readonly config: IngressConfigApi
  readonly rpc: {
    register<P, R>(
      definition: IngressRpcRegistration<P, R> & { scope: 'business' | 'management' },
    ): () => void
  }
  readonly tools: {
    register(definition: {
      sense: Sense<z.ZodType>
      metadata: { label: string; description: string; icon: string; doc: string }
    }): () => void
  }
  readonly hooks: {
    register<E extends import('./hooks.js').HookEvent>(
      definition: IngressHookRegistration<E>,
    ): () => void
  }
  readonly ingress: { register(definition: { id: string }): () => void }
  readonly identity: {
    registerChannel(definition: {
      channel: string
      verifyConnection(
        connection: Readonly<{ connectionId: string; credentialKind: string }>,
      ): Promise<{ selfId: string } | null>
      verifyEvent(
        input: Readonly<{
          connectionId: string
          entryId: string
          eventId: string
          subject: IngressSubject
        }>,
      ): Promise<boolean>
    }): () => void
    bind(input: {
      connectionId: string
      entryId: string
      channel: string
      eventId: string
      subject: IngressSubject
    }): Promise<IngressIdentityHandle>
  }
  /** Trusted QQ lifecycle notification transport; absent for other plugins. */
  readonly appNotifications?: {
    claim(selfId: string): Promise<Array<{ id: string; userId: string; appId: string; text: string; creatorChannel: { selfId: string; userId: string; conversationType: 'private' | 'group'; groupId?: string } }>>
    report(selfId: string, notificationId: string, status: 'sent' | 'failed' | 'unknown'): Promise<void>
  }
  readonly channels: {
    reportSendResult(input: {
      connectionId: string
      entryId: string
      identity: IngressIdentityHandle
      requestId: string
      eventId: string
      status: 'sent' | 'unknown'
      terminal: boolean
    }): Promise<void>
  }
  readonly management: {
    register(definition: {
      moduleId: string
      routes: Array<{
        method: 'GET' | 'POST' | 'PUT' | 'DELETE'
        path: string
        rpcMethod: string
        requestSchema: z.ZodType
        responseSchema: z.ZodType
        handler(
          input: {
            pathParams: Record<string, string>
            query: Record<string, string>
            body?: unknown
          },
          ctx: HandlerContext,
        ): Promise<unknown>
      }>
    }): () => void
    coreCall(method: string, params: unknown): Promise<unknown>
  }
  /** Metadata only: never pass tokens, input, output or arbitrary Error messages. */
  readonly log: (event: string, fields?: Record<string, string | number | boolean | null>) => void
  readonly defer: (cleanup: () => void | Promise<void>) => void
}
export interface IngressPlugin {
  readonly defaultConfig: unknown
  validateConfig(config: unknown): unknown
  /** Must be transactional: on rejection leave the previous runtime policy unchanged. */
  applyConfig(
    snapshot: Readonly<IngressConfigSnapshot>,
  ): void | 'restart_required' | Promise<void | 'restart_required'>
  start(): void | Promise<void>
  prepareManagement?(): void | Promise<void>
  stop(): void | Promise<void>
}
export interface IngressPluginModule {
  createPlugin(context: IngressContext): IngressPlugin | Promise<IngressPlugin>
}
export function immutableSnapshot<T>(value: T): Readonly<T> {
  const copy = structuredClone(value)
  function freeze(item: unknown): void {
    if (!item || typeof item !== 'object' || Object.isFrozen(item)) return
    Object.values(item).forEach(freeze)
    Object.freeze(item)
  }
  freeze(copy)
  return copy
}

export type * from './sense.js'
export type * from './hooks.js'
export type * from './config.js'
