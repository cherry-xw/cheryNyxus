import { createHash, randomUUID } from 'node:crypto'
import config from '@/utils/config.js'
import { getLLMAdapter } from '@/core/llm/adapter.js'
import { getMessageAdapter } from '@/core/message/adapter.js'
import { resolveBrainAdapterKey, resolveBrainProtocol } from '@/core/llm/routing.js'
import { resolveLlmProviderDefaultUrl } from '@chery/protocol'
import { resolvePresetSelection } from '@/agent/runtimeResolver.js'
import { getChat } from '@/db/chat.js'
import { addMessage, getMessages, getRecentConversationMessages } from '@/db/message.js'
import { clearChatRuntime } from '../chat/runtime.js'
import { getActiveChatRunId } from '../chat/runtimeCache.js'
import { onPreparedChatEvent } from '@/db/delivery.js'
import { handleChatCreate } from '../chat/handler.js'
import { handleChatInputSubmit } from '../chat/input.js'
import { handleChatAbort, launchDetachedResume } from '../chat/send.js'
import { resolveQuestionBatch } from '../chat/wake.js'
import { getInteraction } from '@/db/interaction.js'
import { getExecutionActiveRun, listLatestExecutionRuns, listExecutionNodes } from '@/db/executionGraph.js'
import { claimRequest, completeRequest, abandonRequest } from '@/db/delivery.js'
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

function conversationId(owner: string, key: string): string {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(owner) || !key || key.length > 512)
    throw new Error('Invalid ingress conversation key')
  return `ingress-${owner}-${createHash('sha256').update(key).digest('hex')}`
}
/** This adapter never accepts a caller-selected core chat ID or arbitrary RPC. */
export function createIngressCoreAdapter(): IngressCoreAdapter {
  const owned = new Map<string, Map<string, string>>()
  const pending = new Map<string, Promise<{ chatId: string }>>()
  const answering = new Set<string>()
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
    answerQuestions: async (owner, key, input) => {
      const chatId = requireOwned(owner, key)
      input.validateIdentity()
      const interaction = getInteraction(input.batchId)
      const latest = listLatestExecutionRuns(chatId).find(run => run.chatId === chatId)
      const saved = JSON.parse(getChat(chatId)?.metadata ?? '{}').managedRequestIdentity
      if (saved?.ownerId !== owner || !saved.subject || !input.requestIdentity.subject || ['selfId','userId','conversationType','groupId'].some(field => saved.subject[field] !== input.requestIdentity.subject![field as keyof typeof input.requestIdentity.subject])) throw new Error('Question identity rejected')
      const fingerprint = { chatId, batchId: input.batchId, runId: input.runId, answers: input.answers }
      const replay = getSoulDb().prepare('SELECT status,response_json FROM request_journal WHERE request_id=?').get(input.commandId) as {status:string;response_json:string}|undefined
      if (replay?.status === 'completed') {
        const check = claimRequest(input.commandId, 'ingress.question.answer', fingerprint)
        if (check.state !== 'completed') throw new Error('Question command conflict')
        return JSON.parse(check.responseJson) as {runId:string}
      }
      const cancelled = listExecutionNodes(chatId).some(node => node.runId === input.runId && (node.termination as {code?:string} | undefined)?.code === 'user_abort')
      if (!interaction || interaction.chatId !== chatId || interaction.kind !== 'question_batch' || !(interaction.status === 'pending' || interaction.status === 'completed' && replay?.status === 'active') || cancelled ||
        (interaction.deadlineAt !== undefined && interaction.deadlineAt <= Date.now()) ||
        latest?.runId !== input.runId || !['paused','waiting'].includes(getExecutionActiveRun(chatId, input.runId)?.status ?? '')) throw new Error('Question is no longer answerable')
      let claim = claimRequest(input.commandId, 'ingress.question.answer', fingerprint)
      if (claim.state === 'active' && !answering.has(input.commandId) && !getActiveChatRunId(chatId)) {
        abandonRequest(input.commandId)
        claim = claimRequest(input.commandId, 'ingress.question.answer', fingerprint)
      }
      if (claim.state === 'completed') return JSON.parse(claim.responseJson) as { runId: string }
      if (claim.state !== 'new') throw new Error('Question command conflict')
      answering.add(input.commandId)
      try {
        input.validateIdentity()
        if (interaction.status === 'pending') await resolveQuestionBatch(chatId, input.batchId, input.answers)
        input.validateIdentity()
        const runId = input.runId
        await ingressExecution.run({ identity: immutableSnapshot(input.requestIdentity), signal: input.signal,
          execution: { toolHistory: 'request', retry: 'never' }, validate: input.validateIdentity },
          () => launchDetachedResume({ ...context(owner), requestId: runId }, chatId, runId))
        completeRequest(input.commandId, { runId })
        return { runId }
      } catch (error) { if (getInteraction(input.batchId)?.status === 'pending') abandonRequest(input.commandId); throw error }
      finally { answering.delete(input.commandId) }
    },
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
      let response
      try {
        response = await llm.chat(messages.buildMessages(history), [], {
        model: brain.model, provider: brain.provider, protocol,
        url: brain.url ?? resolveLlmProviderDefaultUrl(brain.provider, protocol), key: brain.key,
        fullUrl: brain.fullUrl === true, brain: selection.selection.brain,
        signal: input.signal,
        continuous: _owner === 'cherynyxus-qq-module',
        thinking: 'off',
        })
      } catch (cause) {
        input.signal?.throwIfAborted()
        const code = cause instanceof ClassifiedError
          ? ({ auth: 'AUTH_REQUIRED', validation: 'INVALID_PARAMS', network: 'ECONNRESET', timeout: 'ETIMEDOUT', provider: 'MODEL_UNAVAILABLE', unknown: 'SUMMARY_MODEL_FAILED' } as const)[cause.category]
          : 'SUMMARY_MODEL_FAILED'
        throw Object.assign(new Error('Internal text generation failed', { cause }), { code })
      }
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
        validateIdentity,
        entryId: _entryId,
        ...params
      } = input
      validateIdentity()
      return ingressExecution.run(
        {
          identity: immutableSnapshot(requestIdentity),
          signal,
          execution,
          validate: validateIdentity,
        },
        () => handleChatInputSubmit(context(owner), { ...params, chatId }),
      )
    },
    recentConversationMessages: async (owner, key, count) => JSON.stringify(getRecentConversationMessages(requireOwned(owner, key), count)),
    conversationHistory: async (owner, key) => {
      const messages = getMessages(requireOwned(owner, key)).filter(m => !m.revoked && !m.model_excluded)
      let boundary = -1
      for (let i = 0; i < messages.length; i++) if (messages[i]!.context_compaction) boundary = i
      const selected = boundary >= 0 ? messages.slice(boundary) : messages
      const text = JSON.stringify(selected.map(m => ({ id: m.id, role: m.role, content: m.content, time: m.created_at })))
      if (text.length > 180000) throw new Error('Discussion history exceeds maintenance budget; original history retained')
      return text
    },
    commitSummary: async (owner, key, summary) => {
      const chatId = requireOwned(owner, key)
      if (!summary.trim() || summary.length > 12000 || getActiveChatRunId(chatId)) throw new Error('Summary commit requires an idle conversation and validated text')
      addMessage(randomUUID(), chatId, { role: 'assistant', content: summary, contextCompaction: true })
      clearChatRuntime(chatId)
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
