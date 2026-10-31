import { createHash, randomUUID } from 'node:crypto'
import { readSourceManagement } from '@/db/sourceManagement.js'
import config from '@/utils/config.js'
import { getLLMAdapter } from '@/core/llm/adapter.js'
import { getMessageAdapter } from '@/core/message/adapter.js'
import { resolveBrainAdapterKey, resolveBrainProtocol } from '@/core/llm/routing.js'
import { resolveLlmProviderDefaultUrl } from '@chery/protocol'
import { resolvePresetSelection } from '@/agent/runtimeResolver.js'
import { getChat } from '@/db/chat.js'
import { chatRuntimes, getActiveChatRunId, getPendingChatInputs } from '../chat/runtimeCache.js'
import { listPendingInputs } from '@/db/pendingInput.js'
import { onPreparedChatEvent } from '@/db/delivery.js'
import { handleChatCreate } from '../chat/handler.js'
import { handleChatInputSubmit } from '../chat/input.js'
import { handleChatAbort } from '../chat/send.js'
import { saveSourceQuestions, sourceQuestionStatus, resumeSourceQuestions } from './sourceQuestions.js'
import { connectionManager } from '../websocket/connection.js'
import { transport } from '../websocket/transport.js'
import { logger } from '@/utils/logger/index.js'
import { ingressExecution } from './request.js'
import { immutableSnapshot, type IngressConnections, type IngressCoreAdapter } from './api.js'
import { getAssetStore } from '../media/store.js'
import { fileAccessForChat } from '../media/access.js'
import { identifyFile } from '../media/fileFormat.js'
import { downloadProviderResult } from '../fileServices/download.js'
import { boundedBody } from '../fileServices/adapters/http.js'
import { SourcePublicationStore } from '../media/sourcePublication.js'
import { getSoulDb } from '@/db/index.js'
import { ClassifiedError } from '@/utils/error.js'
import path from 'node:path'
import fs from 'node:fs'
import { createSourceConversationsAdapter } from './sourceConversations.js'
import { sourceExecutionAuthority, validateSourceInput } from './sourceExecution.js'
import { sourceMaintenanceCall } from './sourceMaintenanceCall.js'
import { ensureCurrentConfigRevision } from '@/service/config/revision.js'
import { getSenseRegistryVersion } from '@/core/sense/senseRegistry.js'
import { preflightModelInput } from '@/agent/provider/inputPreflight.js'
import { ErrorId } from '@chery/protocol'
import { SourceContextRepository, sourceContextError } from '@/db/sourceContext.js'

function conversationId(owner: string, key: string): string {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(owner) || !key || key.length > 512)
    throw new Error('Invalid ingress conversation key')
  return `ingress-${owner}-${createHash('sha256').update(key).digest('hex')}`
}
/** This adapter never accepts a caller-selected core chat ID or arbitrary RPC. */
export function createIngressCoreAdapter(): IngressCoreAdapter {
  const owned = new Map<string, Map<string, string>>()
  const pending = new Map<string, Promise<{ chatId: string }>>()
  const submitting = new Map<string, number>()
  let publications: SourcePublicationStore | undefined
  const context = (owner: string) => ({
    authenticatedUserId: owner,
    connectionId: `ingress:${owner}`,
    requestId: randomUUID(),
    log: logger,
  })
  function requireOwned(owner: string, key: string): string {
    const chatId = owned.get(owner)?.get(key)
    if (!chatId) throw new Error('Conversation must be opened by this plugin before execution')
    return chatId
  }
  return {
    readSourceManagement: async (ownerId, input) => readSourceManagement(new SourceContextRepository(getSoulDb()),
      { ownerId, principal: input.principal, validate: input.validateIdentity }, input.query, input.generatedReply),
    sourceConversations: createSourceConversationsAdapter(chatId => Boolean(submitting.has(chatId) || getActiveChatRunId(chatId) ||
      chatRuntimes.get(chatId)?.builder.isRunning() || getPendingChatInputs(chatId).length || listPendingInputs(chatId).length)),
    answerQuestions: (owner, key, input) => saveSourceQuestions(owner, requireOwned(owner, key), input),
    questionResumeStatus: async (owner, key, input) => sourceQuestionStatus(owner, requireOwned(owner, key), input),
    resumeQuestions: (owner, key, input) => resumeSourceQuestions(owner, requireOwned(owner, key), input),
    sourceReferences: async (owner,key)=>{
      const chatId=requireOwned(owner,key),db=getSoulDb()
      if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ingress_image_sources'").get())return {}
      const rows=db.prepare("SELECT source_key,identity_json,asset_id,version_id FROM ingress_image_sources WHERE owner_id=? AND chat_id=? AND permitted=1 AND state='committed'").all(owner,chatId) as {source_key:string;identity_json:string;asset_id:string;version_id:string}[]
      const refs:Record<string,import('@chery/protocol').MessagePart>={}
      for(const r of rows){try{const [self,s]=JSON.parse(r.identity_json);const asset=getAssetStore().get(r.asset_id,fileAccessForChat(chatId,owner),r.version_id);refs[JSON.stringify([self,s.conversationType,s.targetId,s.messageId,s.elementOrdinal])]={type:'asset',partId:r.source_key,assetId:asset.id,assetVersionId:asset.versionId,variant:'original',usage:'content',kind:'image',mimeType:asset.mimeType}}catch{/* Missing or revoked sources remain unavailable; unrelated text still proceeds. */}}
      return refs
    },
    abortSources: async (owner,keys)=>{
      const db=getSoulDb()
      if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ingress_image_sources'").get())return
      for(const key of keys){const r=db.prepare("SELECT upload_id FROM ingress_image_sources WHERE owner_id=? AND source_key=? AND state='uploading'").get(owner,key) as {upload_id:string}|undefined;if(!r)continue
        db.prepare("UPDATE ingress_image_sources SET state='aborted' WHERE owner_id=? AND source_key=? AND state='uploading'").run(owner,key)
        if(/^[0-9a-f-]{36}$/.test(r.upload_id)){const filename=path.resolve(process.env.CHERY_DIR||process.cwd(),'.chery','image-staging',r.upload_id);try{const s=fs.lstatSync(filename);if(s.isFile()&&!s.isSymbolicLink())fs.unlinkSync(filename)}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}}
      }
    },
    restrictSources: async (owner,keys) => {
      const db=getSoulDb()
      if (!keys.length && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_owner_access'").get())
        db.prepare('UPDATE source_owner_access SET enabled=0 WHERE owner_id=?').run(owner)
      if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ingress_image_sources'").get())return
      const allowed=new Set(keys.map(key=>conversationId(owner,key)))
      db.transaction(()=>{
        const rows=db.prepare('SELECT source_key,chat_id,upload_id,state FROM ingress_image_sources WHERE owner_id=?').all(owner) as {source_key:string;chat_id:string;upload_id:string;state:string}[]
        for(const r of rows) {
          db.prepare("UPDATE ingress_image_sources SET permitted=?,state=CASE WHEN ?=0 AND state='uploading' THEN 'aborted' ELSE state END WHERE source_key=?").run(allowed.has(r.chat_id)?1:0,allowed.has(r.chat_id)?1:0,r.source_key)
          if(!allowed.has(r.chat_id) && r.state==='uploading' && /^[0-9a-f-]{36}$/.test(r.upload_id)) {
            const filename=path.resolve(process.env.CHERY_DIR||process.cwd(),'.chery','image-staging',r.upload_id)
            try{const s=fs.lstatSync(filename);if(s.isFile()&&!s.isSymbolicLink())fs.unlinkSync(filename)}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}
          }
        }
      })()
    },
    publishSource: async (owner,key,input) => {
      const chatId=requireOwned(owner,key)
      const validate=()=>{input.validateIdentity();input.signal?.throwIfAborted();fileAccessForChat(chatId,owner)}
      validate()
      if (!publications) { publications=new SourcePublicationStore(getSoulDb(),path.resolve(process.env.CHERY_DIR || process.cwd(),'.chery','image-staging'),getAssetStore());publications.recover() }
      const store=publications
      const c={ownerId:owner,chatId,sourceKey:input.sourceKey,sourceIdentity:input.sourceIdentity,targetKey:input.targetKey,limits:input.limits,validate}
      switch(input.operation) {
        case 'reserve': return store.reserve(c,input.size!)
        case 'begin': return store.begin(c,{size:input.size!,sha256:input.sha256!,mimeType:input.mimeType!})
        case 'chunk': return store.chunk(c,{uploadId:input.uploadId!,offset:input.offset!,dataBase64:input.dataBase64!})
        case 'commit': return store.commit(c,{uploadId:input.uploadId!,size:input.size!,sha256:input.sha256!})
        case 'cancel': return store.cancel(c,input.uploadId!)
        case 'status': return store.status(c)
      }
    },
    importFile: async (owner, key, input) => {
      let stage = 'permission'
      try {
        const chatId = requireOwned(owner, key)
        input.validateIdentity()
        const access = fileAccessForChat(chatId, owner)
        const limit = config.files?.maxUploadBytes ?? 100 * 1024 * 1024
        let declaredMime = input.mimeType
        let data: Buffer
        stage = 'invalid'
        if ('data' in input.source) {
          if (!input.source.data.byteLength || input.source.data.byteLength > limit) throw new Error('文件为空或超过上传大小限制')
          data = Buffer.from(input.source.data)
        }
        else {
          stage = 'download'
          const response = await downloadProviderResult(input.source.url, input.signal)
          data = await boundedBody(response, limit, input.signal ?? new AbortController().signal)
          if (declaredMime === 'application/octet-stream') declaredMime = response.headers.get('content-type') ?? declaredMime
        }
        stage = 'permission'
        input.signal?.throwIfAborted()
        input.validateIdentity()
        fileAccessForChat(chatId, owner)
        stage = 'invalid'
        const format = identifyFile(data, declaredMime)
        const store = getAssetStore()
        const asset = await store.save(data, { ownerId: owner, originalName: input.originalName, ...format, source: 'upload', maxBytes: limit })
        stage = 'permission'
        input.validateIdentity()
        input.signal?.throwIfAborted()
        fileAccessForChat(chatId, owner)
        store.attachOwned([{ type: 'asset', partId: `ingress:${asset.id}`, assetId: asset.id, assetVersionId: asset.versionId, variant: 'original', usage: 'content' }], access, 'branch', chatId)
        return asset
      } catch (cause) {
        input.signal?.throwIfAborted()
        const transportCode = (cause as { code?: unknown } | null)?.code
        const code = stage === 'download' && (/^HTTP_[45][0-9]{2}$/.test(String(transportCode)) || ['REMOTE_ADDRESS_REJECTED', 'EAI_ADDRFAMILY', 'ENOTFOUND', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ERR_INVALID_IP_ADDRESS'].includes(String(transportCode))) ? String(transportCode) : stage === 'download' ? 'FILE_DOWNLOAD_FAILED' : stage === 'invalid' ? 'FILE_INVALID' : 'FILE_PERMISSION_DENIED'
        throw Object.assign(new Error('附件导入失败', { cause }), { stage, code })
      }
    },
    readFileChunk: async (owner, key, input) => {
      input.validateIdentity()
      input.signal?.throwIfAborted()
      const chatId = requireOwned(owner, key)
      const result = await getAssetStore().readChunk(input.assetId, fileAccessForChat(chatId, owner), input.assetVersionId, input.offset)
      input.validateIdentity()
      input.signal?.throwIfAborted()
      fileAccessForChat(chatId, owner)
      return result
    },
    internalText: async (_owner, input) => {
      const selection = resolvePresetSelection(input.preset)
      const brain = config.llm.brain[selection.selection.brain]
      if (!brain) throw new Error('Internal text model unavailable')
      const key = resolveBrainAdapterKey(brain)
      const llm = getLLMAdapter(key), messages = getMessageAdapter(key)
      if (!llm || !messages) throw new Error('Internal text adapter unavailable')
      const now = Date.now()
      const history = [
        { id: randomUUID(), role: 'system' as const, content: input.instruction, createdAt: now, updateAt: now },
        { id: randomUUID(), role: 'user' as const, content: input.content, createdAt: now, updateAt: now },
      ]
      const protocol = resolveBrainProtocol(brain)
      input.signal?.throwIfAborted()
      const maintenance = input.sourceMaintenance
      const repo = maintenance ? new SourceContextRepository(getSoulDb()) : undefined
      const auth = maintenance ? repo!.maintenanceAuthority({ ownerId: _owner, channel: maintenance.channel,
        selfId: maintenance.selfId, validate: maintenance.validateIdentity }, maintenance.scopeId) : undefined
      if (maintenance && repo!.scope(auth!, maintenance.scopeId).presetId !== selection.presetId) sourceContextError('SUMMARY_DESTINATION_CHANGED')
      const tracking = maintenance ? sourceMaintenanceCall(repo!, auth!, { scopeId: maintenance.scopeId, operationId: maintenance.operationId,
        contentMessageId: history[1]!.id, content: input.content, runtimeConfigRevision: ensureCurrentConfigRevision().revisionId,
        registryVersion: getSenseRegistryVersion(), signal: input.signal }) : undefined
      const options: import('@/core/llm/adapter.js').LLMOptions = {
        model: brain.model, provider: brain.provider, protocol,
        url: brain.url ?? resolveLlmProviderDefaultUrl(brain.provider, protocol), key: brain.key,
        fullUrl: brain.fullUrl === true, brain: selection.selection.brain, signal: input.signal,
        continuous: !!maintenance || _owner === 'cherynyxus-qq-module', thinking: 'off', ...tracking,
        ...(maintenance ? { inputPreflight: { contextLimit: brain.contextLimit, safetyMargin: config.global.command?.safety_margin,
          afterCompaction: true, report() {} } } : {}),
      }
      let response
      let completed = false
      try {
        const built = messages.buildMessages(history, undefined, { protocol })
        if (tracking && protocol === 'mock') {
          const body = { model: brain.model, messages: built, tools: [] }
          await preflightModelInput(body, options, protocol)
          tracking.sourceCall!.prepare(body, protocol); tracking.observation!.start(brain.model)
        }
        response = await llm.chat(built, [], options)
        tracking?.observation?.response(response)
        completed = true
      } catch (cause) {
        input.signal?.throwIfAborted()
        const code = cause instanceof ClassifiedError && cause.errorId === ErrorId.REQUEST_INPUT_TOO_LARGE ? 'SUMMARY_BUDGET_FAILED' : cause instanceof ClassifiedError
          ? ({ auth: 'AUTH_REQUIRED', validation: 'INVALID_PARAMS', network: 'ECONNRESET', timeout: 'ETIMEDOUT', provider: 'MODEL_UNAVAILABLE', unknown: 'SUMMARY_MODEL_FAILED' } as const)[cause.category]
          : 'SUMMARY_MODEL_FAILED'
        throw Object.assign(new Error('Internal text generation failed', { cause }), { code })
      } finally { tracking?.observation?.finish(completed ? 'completed' : input.signal?.aborted ? 'cancelled' : 'failed') }
      input.signal?.throwIfAborted()
      if (maintenance) repo!.scope(auth!, maintenance.scopeId, ['maintenance'])
      const text = messages.content(response)
      if (!text || text.length > 100000) throw new Error('Invalid internal text output')
      return text
    },
    listPresets: () =>
      immutableSnapshot(
        Object.entries(config.presets ?? {}).map(([name, preset]) => ({
          name,
          presetId: preset.id!,
        })),
      ),
    resolvePreset: (name) => {
      const resolved = resolvePresetSelection(name)
      return immutableSnapshot({
        name,
        presetId: resolved.presetId,
        leaderName: resolved.leaderName,
        ...resolved.selection,
      })
    },
    ensureConversation: (owner, key, preset) => {
      const chatId = conversationId(owner, key)
      const previous = pending.get(chatId)
      if (previous) return previous
      const work = (async () => {
        const resolved = resolvePresetSelection(preset)
        const existing = getChat(chatId)
        if (existing) {
          const metadata = JSON.parse(existing.metadata || '{}') as Record<string, unknown>
          if (metadata.presetId !== resolved.presetId)
            throw new Error(
              'Existing conversation uses a different preset; open a new conversation key',
            )
        } else await handleChatCreate(context(owner), { chatId, preset, skipBlankReuse: true })
        let conversations = owned.get(owner)
        if (!conversations) {
          conversations = new Map()
          owned.set(owner, conversations)
        }
        conversations.set(key, chatId)
        return { chatId }
      })().finally(() => pending.delete(chatId))
      pending.set(chatId, work)
      return work
    },
    submit: async (owner, key, input) => {
      const chatId = requireOwned(owner, key)
      const {
        requestIdentity,
        signal,
        execution,
        sourceInput,
        sourceCapacity,
        validateIdentity,
        entryId: _entryId,
        ...params
      } = input
      validateIdentity()
      if (sourceInput) {
        const source = validateSourceInput(sourceInput, sourceExecutionAuthority(requestIdentity, validateIdentity))
        const chat = getChat(chatId)!
        if (!chat.active_epoch_id) throw new Error('SOURCE_CONTEXT_UNAVAILABLE')
        source.repo.bindCore(sourceExecutionAuthority(requestIdentity, validateIdentity), sourceInput.scopeId,
          { chatId, epochId: chat.active_epoch_id })
      }
      submitting.set(chatId, (submitting.get(chatId) ?? 0) + 1)
      try {
        return await ingressExecution.run(
          {
            identity: immutableSnapshot(requestIdentity),
            signal,
            execution,
            sourceInput,
            sourceCapacity,
            validate: validateIdentity,
          },
          () => handleChatInputSubmit(context(owner), { ...params, chatId }),
        )
      } finally {
        const count = submitting.get(chatId)! - 1
        if (count) submitting.set(chatId, count)
        else submitting.delete(chatId)
      }
    },
    abort: async (owner, key) => {
      await handleChatAbort(context(owner), { chatId: requireOwned(owner, key) })
    },
    onEvent: (owner, listener) =>
      onPreparedChatEvent((chatId, event) => {
        const conversations = owned.get(owner)
        if (!conversations) return
        for (const [key, ownedId] of conversations) {
          if (ownedId === chatId) {
            listener(key, immutableSnapshot(event))
            return
          }
        }
      }),
  }
}
export function createIngressConnections(): IngressConnections {
  return {
    credentialKind: (id) => connectionManager.getCredentialKind(id),
    isOpen: (id) => {
      const ws = connectionManager.getWsByConnectionId(id)
      return !!ws && ws.readyState === ws.OPEN
    },
    send: (id, event) => {
      const ws = connectionManager.getWsByConnectionId(id)
      if (!ws || ws.readyState !== ws.OPEN) return false
      try {
        ws.send(transport.serializeMessage(event))
        return true
      } catch {
        return false
      }
    },
    onClose: (listener) => connectionManager.onClose(listener),
  }
}
