import type { z } from 'zod'
export interface HandlerContext { requestId?: string; connectionId: string; credentialKind?: string; log: { event(type: string, data?: Record<string, unknown>, level?: number): void; debug(...args: unknown[]): void; info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void } }
import type { ChatInputSubmitRequest as ChatInputSubmitRequestData, ChatInputSubmitResponse as ChatInputSubmitResponseData } from '@chery/protocol'
import type { Sense, SenseFunction } from './sense.js'
import type { IngressHookRegistration } from './hooks.js'
import type { AssetRecord, IngressCapability, IngressStatus, IngressUiDescriptor } from '@chery/protocol'
import type { SourceRecord, SourceRecordRef, SourceScope, SourceReceipt, SourceReceiptResult, SourceReceiptStatus,
  SourceHandling, SourceAttachmentVersion, SourceSnapshot, SourceReadSelection, SourceReadResult, SourceSummary, SourceSummaryEvidence } from '@chery/protocol'
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
  kind?: 'rules' | 'data'
  ownerId: string
  key: string
  content: string
  configRevision: number
}
export interface IngressRequestView {
  fileCapabilities?: readonly {
    operation: string
    availability: 'available' | 'requires_approval' | 'selection_required' | 'unavailable' | 'unknown'
    mode: 'auto' | 'native' | 'tool' | 'role' | 'disabled'
    targetId?: string
    inputConstraints: { mimeTypes?: readonly string[]; maxBytes?: number; maxAssets?: number; maxPages?: number }
    delegationPath?: readonly string[]
    candidates?: readonly { mode: 'native' | 'tool' | 'role'; targetId: string }[]
    configRevision: string
    reasonCode: string
    reason: string
  }[]
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
  sourceInput?: import('@chery/protocol').SourceInput
  sourceCapacity?: IngressSourceCapacity
}
/** In-process maintenance continuation, never a public chat field or a stored authority. */
export type IngressSourceCapacity = (input: { operationId: string; parentSnapshotId: string }, signal?: AbortSignal) => Promise<void>
export interface IngressPreset {
  name: string
  presetId: string
  leaderName: string
  brain: string
  senseGroup: string
  tools?: readonly string[]
  mcpServers: readonly string[]
}
export interface IngressInternalTextInput { preset: string; instruction: string; content: string; signal?: AbortSignal
  sourceMaintenance?: IngressSourceMaintenanceContext & { operationId: string }
}
export type IngressInternalTextAuthorization = Omit<IngressInternalTextInput, 'sourceMaintenance'> & {
  sourceMaintenance?: IngressSourceMaintenanceAuthorization & { operationId: string }
}
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
export interface IngressSourceContext {
  entryId: string
  identity: IngressIdentityHandle
  scopeId: string
}
export interface IngressSourceReceiptInput {
  eventId: string; messageId: string; sender: SourceRecord['sender']; parts: SourceRecord['parts']
  platformSentAt?: number; sourceOrder?: SourceRecord['sourceOrder']
  attachments?: Array<Pick<SourceAttachmentVersion, 'originalName' | 'declaredMimeType' | 'mediaKind'> & { partId: string }>
}
export interface IngressSourcePolicy {
  historyLimit: number; backgroundMaxAgeMs: number; backgroundMaxChars: number; qqConfigRevision: number
}
export interface IngressSourceTarget {
  conversationType: 'group' | 'private'; targetId: string; presetId: string; qqContextEpoch: string
}
export interface IngressSourceAuthorization {
  requestIdentity: IngressRequestIdentity
  eventId: string
  purpose: 'record' | 'execution'
  validateIdentity(): void
}
export interface IngressSourceAttachmentPublication {
  attachmentId: string; operation: 'reserve' | 'begin' | 'chunk' | 'status' | 'commit' | 'cancel'
  size?: number; sha256?: string; uploadId?: string; offset?: number; dataBase64?: string
}
export interface IngressSourceAttachmentImport {
  attachmentId: string; url: string; signal?: AbortSignal
}
export interface IngressSourceDelivery {
  scopeId: string
  frame: import('@chery/protocol').QQNotification
  result?: import('@chery/protocol').QQDeliveryResultRequest
  confirmedAt?: number
}
export interface IngressSourceMaintenanceContext {
  entryId: string; channel: string; connectionId: string; scopeId: string
}
export interface IngressSourceMaintenanceAuthorization {
  channel: string; selfId: string; scopeId: string; validateIdentity(): void
}
export interface IngressSourceSummaryOperation {
  operationId: string; scopeId: string; purpose: 'capacity' | 'discussion'; snapshotId: string
  baseSummaryId?: string; baseSelectionRevision: number; permissionRevision: number; evidence: SourceSummaryEvidence[]
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  phase: 'history' | 'memory' | 'summary' | 'commit'; version: number; summaryId?: string; reasonCode?: string
}
export interface IngressSourceSummaryPreparation {
  operation: IngressSourceSummaryOperation; snapshot: SourceSnapshot; records: SourceRecord[]; baseSummary?: SourceSummary
  attachments: SourceAttachmentVersion[]
  deliveries: Array<{ deliveryId: string; purpose: string; kind: string; frame: import('@chery/protocol').QQNotification;
    source?: SourceRecordRef; result?: import('@chery/protocol').QQDeliveryResultRequest; revision: number }>
}
export interface IngressSourceSummaryCommit {
  operationId: string; expectedBaseSummaryId?: string; text: string; prerequisiteReceipt: string
  validatePrerequisite(receipt: string, operationId: string): boolean
}
export interface IngressSourceSummaryProgress {
  operationId: string; expectedVersion: number; status: 'running' | 'failed' | 'cancelled'
  phase: IngressSourceSummaryOperation['phase']; reasonCode?: string
}
/** No method here is a public RPC or accepts a caller-selected owner. */
export interface IngressSourceConversations {
  history(input: IngressSourceContext & { runId: string; count?: number; cursor?: string }): Promise<import('@chery/protocol').SourceHistoryResult>
  readText(input: IngressSourceContext & { runId: string; textRefId: string; cursor?: string }): Promise<import('@chery/protocol').SourceTextPage>
  prepareSummary(input: IngressSourceMaintenanceContext & { operationId: string; purpose: 'capacity' | 'discussion'; qqConfigRevision: number; parentSnapshotId?: string }): Promise<IngressSourceSummaryPreparation>
  summaryStatus(input: IngressSourceMaintenanceContext & { operationId: string }): Promise<IngressSourceSummaryOperation>
  updateSummaryProgress(input: IngressSourceMaintenanceContext & IngressSourceSummaryProgress): Promise<IngressSourceSummaryOperation>
  commitSummary(input: IngressSourceMaintenanceContext & IngressSourceSummaryCommit): Promise<SourceSummary>
  recordDelivery(input: IngressSourceDelivery & { entryId: string; channel: string; connectionId: string }): Promise<void>
  lookupReceipt(input: { entryId: string; channel: string; connectionId: string; eventId: string }): Promise<SourceReceiptStatus>
  scope(input: IngressSourceContext): Promise<SourceScope>
  receiptAttachments(input: IngressSourceContext): Promise<SourceAttachmentVersion[]>
  configure(input: { entryId: string; channel: string; connectionId: string; revision: number; targets: IngressSourceTarget[] }): Promise<SourceScope[]>
  ensureScope(input: Omit<IngressSourceContext, 'scopeId'> & { presetId: string; qqContextEpoch: string }): Promise<SourceScope>
  beginReceipt(input: IngressSourceContext & { message: IngressSourceReceiptInput }): Promise<SourceReceipt>
  completeReceipt(input: IngressSourceContext & { receiptId: string; expectedVersion: number; handling: SourceHandling }): Promise<SourceReceiptResult>
  receiptStatus(input: Omit<IngressSourceContext, 'scopeId'> & { eventId: string }): Promise<SourceReceiptStatus>
  freeze(input: IngressSourceContext & { requestId: string; actorRecord: SourceRecordRef; inputRecords: SourceRecordRef[];
    expectedSelectionRevision: number; policy: IngressSourcePolicy }): Promise<SourceSnapshot>
  read(input: IngressSourceContext & { selection: SourceReadSelection }): Promise<SourceReadResult>
  snapshot(input: IngressSourceContext & { snapshotId: string }): Promise<SourceSnapshot>
  attachment(input: IngressSourceContext & { attachmentId: string; version?: number }): Promise<SourceAttachmentVersion>
  updateAttachment(input: IngressSourceContext & { attachmentId: string; expectedVersion: number; state: SourceAttachmentVersion['state'] }): Promise<SourceAttachmentVersion>
  linkImage(input: IngressSourceContext & { attachmentId: string; nativeSourceId: string }): Promise<SourceAttachmentVersion>
  registerWorkspace(input: IngressSourceContext & { attachmentId: string; version: number; mount: import('@chery/protocol').SourceWorkspaceMount }): Promise<void>
  publishAttachment(input: IngressSourceContext & IngressSourceAttachmentPublication): Promise<IngressSourceResult>
  importAttachment(input: IngressSourceContext & IngressSourceAttachmentImport): Promise<SourceAttachmentVersion>
  readAttachmentChunk(input: IngressSourceContext & { attachmentId: string; version: number; offset: number }): Promise<IngressFileChunk>
}
export interface IngressSourceConversationsAdapter {
  history(ownerId: string, input: IngressSourceAuthorization & { scopeId: string; runId: string; count?: number; cursor?: string }): Promise<import('@chery/protocol').SourceHistoryResult>
  readText(ownerId: string, input: IngressSourceAuthorization & { scopeId: string; runId: string; textRefId: string; cursor?: string }): Promise<import('@chery/protocol').SourceTextPage>
  prepareSummary(ownerId: string, input: IngressSourceMaintenanceAuthorization & { operationId: string; purpose: 'capacity' | 'discussion'; qqConfigRevision: number; parentSnapshotId?: string }): Promise<IngressSourceSummaryPreparation>
  summaryStatus(ownerId: string, input: IngressSourceMaintenanceAuthorization & { operationId: string }): Promise<IngressSourceSummaryOperation>
  updateSummaryProgress(ownerId: string, input: IngressSourceMaintenanceAuthorization & IngressSourceSummaryProgress): Promise<IngressSourceSummaryOperation>
  commitSummary(ownerId: string, input: IngressSourceMaintenanceAuthorization & IngressSourceSummaryCommit): Promise<SourceSummary>
  recordDelivery(ownerId: string, input: IngressSourceDelivery & { channel: string; selfId: string; validateIdentity(): void }): Promise<void>
  lookupReceipt(ownerId: string, input: { channel: string; selfId: string; eventId: string; validateIdentity(): void }): Promise<SourceReceiptStatus>
  scope(ownerId: string, input: IngressSourceAuthorization & { scopeId: string }): Promise<SourceScope>
  receiptAttachments(ownerId: string, input: IngressSourceAuthorization & { scopeId: string }): Promise<SourceAttachmentVersion[]>
  configure(ownerId: string, input: { channel: string; selfId: string; revision: number; targets: IngressSourceTarget[]; validateIdentity(): void }): Promise<SourceScope[]>
  ensureScope(ownerId: string, input: IngressSourceAuthorization & { presetId: string; qqContextEpoch: string }): Promise<SourceScope>
  beginReceipt(ownerId: string, input: IngressSourceAuthorization & { scopeId: string; message: IngressSourceReceiptInput }): Promise<SourceReceipt>
  completeReceipt(ownerId: string, input: IngressSourceAuthorization & { scopeId: string; receiptId: string; expectedVersion: number; handling: SourceHandling }): Promise<SourceReceiptResult>
  receiptStatus(ownerId: string, input: IngressSourceAuthorization & { eventId: string }): Promise<SourceReceiptStatus>
  freeze(ownerId: string, input: IngressSourceAuthorization & { scopeId: string; requestId: string; actorRecord: SourceRecordRef;
    inputRecords: SourceRecordRef[]; expectedSelectionRevision: number; policy: IngressSourcePolicy }): Promise<SourceSnapshot>
  read(ownerId: string, input: IngressSourceAuthorization & { scopeId: string; selection: SourceReadSelection }): Promise<SourceReadResult>
  snapshot(ownerId: string, input: IngressSourceAuthorization & { scopeId: string; snapshotId: string }): Promise<SourceSnapshot>
  attachment(ownerId: string, input: IngressSourceAuthorization & { scopeId: string; attachmentId: string; version?: number }): Promise<SourceAttachmentVersion>
  updateAttachment(ownerId: string, input: IngressSourceAuthorization & { scopeId: string; attachmentId: string; expectedVersion: number; state: SourceAttachmentVersion['state'] }): Promise<SourceAttachmentVersion>
  linkImage(ownerId: string, input: IngressSourceAuthorization & { scopeId: string; attachmentId: string; nativeSourceId: string }): Promise<SourceAttachmentVersion>
  registerWorkspace(ownerId: string, input: IngressSourceAuthorization & { scopeId: string; attachmentId: string; version: number; mount: import('@chery/protocol').SourceWorkspaceMount }): Promise<void>
  publishAttachment(ownerId: string, input: IngressSourceAuthorization & { scopeId: string } & IngressSourceAttachmentPublication): Promise<IngressSourceResult>
  importAttachment(ownerId: string, input: IngressSourceAuthorization & { scopeId: string } & IngressSourceAttachmentImport): Promise<SourceAttachmentVersion>
  readAttachmentChunk(ownerId: string, input: IngressSourceAuthorization & { scopeId: string; attachmentId: string; version: number; offset: number }): Promise<IngressFileChunk>
}
export interface IngressSourcePublication extends IngressFileContext {
  sourceKey: string; sourceIdentity: string; targetKey: string
  limits: { singleBytes: number; totalBytes: number; perTargetBytes: number }
  operation: 'reserve' | 'begin' | 'chunk' | 'status' | 'commit' | 'cancel'
  size?: number; sha256?: string; mimeType?: string; uploadId?: string; offset?: number; dataBase64?: string
}
export interface IngressSourceResult {
  state?: 'registered' | 'uploading' | 'committed' | 'aborted'
  nextOffset?: number; uploadId?: string; assetId?: string; assetVersionId?: string; cancelled?: boolean
}
export interface IngressQuestionAnswer extends IngressFileContext {
  sourceCapacity?: IngressSourceCapacity
  runId: string
  batchId: string
  commandId: string
  answers: Array<{ questionId: string; selectedLabels: string[]; freeText?: string; cancelled?: boolean }>
  sourceAnswers?: { snapshotId: string; records: Array<{ questionId: string; record: SourceRecordRef }> }
}
export interface IngressQuestionResume extends IngressFileContext {
  runId: string
  commandId: string
  sourceCapacity?: IngressSourceCapacity
}
export interface IngressQuestionResumeResult {
  runId: string
  commandId: string
  status: 'saving' | 'saved' | 'started' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'unknown'
  canQueue: boolean
  reasonCode?: string
  sourceSnapshot?: SourceSnapshot
}
export type IngressQuestionAnswerResult = IngressQuestionResumeResult
export interface IngressCore {
  sourceConversations?: IngressSourceConversations
  answerQuestions?(input: IngressQuestionAnswer): Promise<IngressQuestionAnswerResult>
  questionResumeStatus?(input: IngressQuestionResume): Promise<IngressQuestionResumeResult>
  resumeQuestions?(input: IngressQuestionResume): Promise<IngressQuestionResumeResult>
  sourceReferences?(conversationKey:string): Promise<Record<string, import('@chery/protocol').MessagePart>>
  abortSources?(sourceKeys:readonly string[]): Promise<void>
  restrictSources?(conversationKeys: readonly string[]): Promise<void>
  publishSource?(input: IngressSourcePublication): Promise<IngressSourceResult>
  importFile?(input: IngressFileImport): Promise<AssetRecord>
  readFileChunk?(input: IngressFileRead): Promise<IngressFileChunk>
  internalText?(input: IngressInternalTextInput): Promise<string>
  listPresets(): readonly { name: string; presetId: string }[]
  resolvePreset(name: string): Readonly<IngressPreset>
  ensureConversation(key: string, preset: string): Promise<{ chatId: string }>
  submit(input: IngressSubmit): Promise<ChatInputSubmitResponseData>
  abort(conversationKey: string): Promise<void>
  onEvent(
    listener: (conversationKey: string, event: Readonly<Record<string, unknown>>) => void,
  ): () => void
}
/** Host adapters are injectable without giving a plugin access to arbitrary RPCs. */
export interface IngressCoreAdapter {
  readSourceManagement?(ownerId: string, input: { principal: string; query: import('@chery/protocol').SourceManagementQuery; generatedReply?: string; validateIdentity(): void }): Promise<import('@chery/protocol').SourceManagementResult>
  sourceConversations?: IngressSourceConversationsAdapter
  answerQuestions?(ownerId: string, key: string, input: Omit<IngressQuestionAnswer, 'conversationKey' | 'identity'> & IngressFileAuthorization): Promise<IngressQuestionAnswerResult>
  questionResumeStatus?(ownerId: string, key: string, input: Omit<IngressQuestionResume, 'conversationKey' | 'identity'> & IngressFileAuthorization): Promise<IngressQuestionResumeResult>
  resumeQuestions?(ownerId: string, key: string, input: Omit<IngressQuestionResume, 'conversationKey' | 'identity'> & IngressFileAuthorization): Promise<IngressQuestionResumeResult>
  sourceReferences?(ownerId:string,key:string): Promise<Record<string, import('@chery/protocol').MessagePart>>
  abortSources?(ownerId:string,sourceKeys:readonly string[]): Promise<void>
  restrictSources?(ownerId:string,conversationKeys:readonly string[]): Promise<void>
  publishSource?(ownerId: string, key: string, input: Omit<IngressSourcePublication, 'conversationKey' | 'identity'> & IngressFileAuthorization): Promise<IngressSourceResult>
  importFile?(ownerId: string, key: string, input: Omit<IngressFileImport, 'conversationKey' | 'identity'> & IngressFileAuthorization): Promise<AssetRecord>
  readFileChunk?(ownerId: string, key: string, input: Omit<IngressFileRead, 'conversationKey' | 'identity'> & IngressFileAuthorization): Promise<IngressFileChunk>
  internalText?(ownerId: string, input: IngressInternalTextAuthorization): Promise<string>
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
  admitHeader?(ctx: HandlerContext, params: unknown): boolean
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
  /** Read-only Backend lifecycle. Providers describe actual unfinished work, not queued new tasks. */
  readonly lifecycle?: {
    snapshot(): import('@chery/protocol').BackendStopSnapshot
    subscribe(listener: (state: import('@chery/protocol').BackendStopSnapshot) => void): () => void
    blockers(provider: () => import('@chery/protocol').BackendStopBlocker[]): () => void
  }
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
      verifySource?(input: Readonly<{ connectionId: string; entryId: string; eventId: string; subject: IngressSubject }>): Promise<boolean>
      validateSource?(input: Readonly<{ connectionId: string; entryId: string; eventId: string; subject: IngressSubject }>): boolean
      verifyRecord?(input: Readonly<{ connectionId: string; entryId: string; eventId: string; subject: IngressSubject }>): Promise<boolean>
      validateRecord?(input: Readonly<{ connectionId: string; entryId: string; eventId: string; subject: IngressSubject }>): boolean
      validateExecution?(input: Readonly<{ connectionId: string; entryId: string; eventId: string; subject: IngressSubject }>): boolean
    }): () => void
    bind(input: {
      connectionId: string
      entryId: string
      channel: string
      eventId: string
      subject: IngressSubject
      purpose?: 'source' | 'record'
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
    readSource?(query: import('@chery/protocol').SourceManagementQuery, generatedReply?: string): Promise<import('@chery/protocol').SourceManagementResult>
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
