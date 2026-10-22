import { ModelInputNeedsCompaction } from '@/agent/provider/modelBudget.js'
import { createHash } from 'node:crypto'
import type { LLMAdapter, LLMOptions } from '@/core/llm/adapter.js'
import type { LLMResponse } from '@/core/message/adapter.js'
import type { MiddlewareContext } from '@/core/middleware/types.js'
import { ErrorId } from '@chery/protocol'
import { getChatMetadata, updateChatMetadata } from '@/db/chat.js'
import { classifyBrainError } from '@/agent/provider/fetchBase.js'
import { applyContextCheckpoint, prepareContextCheckpoint } from './contextCheckpoint.js'
import { preflightModelInput } from '@/agent/provider/inputPreflight.js'

/** Recovery wraps model-start admission only, never stream consumption or tool execution. */
export function contextRecoveryAdapter(ctx: MiddlewareContext, source: () => LLMResponse[], build: (history: LLMResponse[]) => unknown[],
  recoverSources?: (options: LLMOptions) => Promise<unknown[]>): LLMAdapter {
  const raw = ctx.runtime!.adapters.llmAdapter
  const invoke = async (stream: boolean, messages: unknown[], tools: Parameters<LLMAdapter['chat']>[1], options?: LLMOptions): Promise<any> => {
    const call = async () => {
      if (options?.sourceCall && (options.provider === 'mock' || options.protocol === 'mock')) {
        const body = { model: options.model, messages, tools }
        await preflightModelInput(body, options, 'mock')
        options.sourceCall.prepare(body, 'mock'); options.observation?.start(options.model)
      }
      return stream ? raw.chatStream(messages, tools, options) : raw.chat(messages, tools, options)
    }
    // Key the actual current step, not the initial input: later tool results are different steps.
    const input = ctx.requestView?.inputId ?? ctx.requestView?.requestId ?? source().findLast(m => m.role === 'user')?.id
    const currentSource = source()
    const latestUser = currentSource.findLastIndex(m => m.role === 'user')
    const stepMessageIds = currentSource.slice(latestUser).filter(m => !m.id.startsWith('context-checkpoint:')).map(m => m.id)
    const key = createHash('sha256').update(JSON.stringify({ input, model: options?.model, stepMessageIds, tools })).digest('hex')
    try { return await call() } catch (error) {
      const local = error instanceof ModelInputNeedsCompaction
      if (!input || !options || (!local && classifyBrainError(error).errorId !== ErrorId.BRAIN_CONTEXT_OVERFLOW)) throw error
      options?.signal?.throwIfAborted()
      const saved = getChatMetadata(ctx.soul.chatId).contextOverflowRecovery as { attempts?: string[] } | undefined
      const attempts = (saved as { input?: string } | undefined)?.input === input ? saved?.attempts ?? [] : []
      if (attempts.includes(key)) throw error
      updateChatMetadata(ctx.soul.chatId, { contextOverflowRecovery: { input, attempts: [...attempts, key], attemptedAt: Date.now() } })
      if (recoverSources) {
        const rebuilt = await recoverSources(options)
        options.signal?.throwIfAborted()
        if (options.inputPreflight) options.inputPreflight = { ...options.inputPreflight, compactIfNeeded: false,
          forcePreparation: false, afterCompaction: true, accepted: undefined }
        messages = rebuilt
        return call()
      }
      const current = applyContextCheckpoint(ctx.soul.chatId, source())
      const recovered = await prepareContextCheckpoint(ctx, current, options, true, true)
      const candidate = getChatMetadata(ctx.soul.chatId).contextMaintenance as import('./contextCheckpoint.js').ContextCheckpoint | undefined
      if (options.inputPreflight) options.inputPreflight = { ...options.inputPreflight, compactIfNeeded: false, forcePreparation: false, afterCompaction: true, accepted() {
        const active = getChatMetadata(ctx.soul.chatId).contextMaintenance as import('./contextCheckpoint.js').ContextCheckpoint | undefined
        if (candidate?.status === 'completed' && candidate.chatId === ctx.soul.chatId && active?.operationId === candidate.operationId) updateChatMetadata(ctx.soul.chatId, { contextCheckpoint: candidate })
      } }
      options?.signal?.throwIfAborted()
      const rebuilt = build(recovered)
      // Keep request-local execution history intact; replace only the rejected wire input.
      messages = rebuilt
      return call()
    }
  }
  return {
    chat: (messages, tools, options) => invoke(false, messages, tools, options),
    chatStream: (messages, tools, options) => invoke(true, messages, tools, options),
  }
}
