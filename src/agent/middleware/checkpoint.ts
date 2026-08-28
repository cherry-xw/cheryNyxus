import type {
  MiddlewareContext,
  MiddlewareChunk,
  StreamChunk,
  StagedChunk,
  SenseTriggerChunk,
} from '@/core/middleware/types'
import { CheckpointState } from './checkpointState.js'
import { safeJsonParse } from '@/utils/json.js'

/**
 * Checkpoint Middleware
 * 职责：
 * 1. 处理 userInputs → messages（在 next() 调用前）
 * 2. 接收所有 chunk，归纳状态
 * 3. 收集 senseDelta，合并后 yield sense_end staged
 * 4. 构建 messages 放到 ctx.soul
 * 5. yield message/sense effect chunk，由 service observer 处理副作用
 * 6. yield consumed notification
 * 7. 边界检测：thinking_end / content_end / sense_end 三种 staged
 */
export async function* checkpointMiddleware(
  ctx: MiddlewareContext,
  next: () => AsyncGenerator<MiddlewareChunk>,
): AsyncGenerator<MiddlewareChunk> {
  // === 先处理 userInputs：转为 messages（在 next() 调用前）===
  const { messages: consumedMessages, consumedCount } = ctx.journal.appendUserMessages()

  if (consumedCount > 0) {
    for (const message of consumedMessages) {
      yield {
        type: 'message_created',
        message,
      } as MiddlewareChunk
    }

    const durableConsumedMessages = consumedMessages.filter(
      (message) => !message.ephemeral && message.role === 'user',
    )
    if (durableConsumedMessages.length > 0) {
      // 仅真实用户输入进入 consumed；模型专用注入不得伪装成用户消息。
      yield {
        type: 'consumed',
        count: durableConsumedMessages.length,
        messages: durableConsumedMessages,
      } as MiddlewareChunk
    }
  }

  const state = new CheckpointState()
  // Announce the preallocated assistant turn before the provider produces its
  // first token. The service mapper turns this empty checkpoint into
  // turn.started but suppresses an empty legacy stream chunk.
  yield {
    type: 'stream',
    thinkingDelta: '',
    contentDelta: '',
    msgId: state.getAssistantId(),
    createdAt: state.getTurnStartedAt(),
  } as StreamChunk
  const questionCandidates: Array<{
    questionId: string
    question: string
    header?: string
    options: Array<{ label: string; description?: string }>
    multiSelect: boolean
    createdAt: number
  }> = []
  // 三 delta 状态机标记
  let thinkingActive = false // thinkingDelta 是否活跃
  let contentActive = false // contentDelta 是否活跃

  // === 执行内层 handlers ===
  try {
    for await (const chunk of next()) {
      if (chunk.type === 'retry_reset') {
        const messageId = state.resetAttempt()
        thinkingActive = false
        contentActive = false
        questionCandidates.length = 0
        yield { ...chunk, messageId }
        continue
      }
      state.ingest(chunk)

      // 边界检测和 staged yield（三 delta 状态机）
      if (chunk.type === 'stream') {
        const streamChunk = chunk as StreamChunk

        // thinkingDelta 出现 → thinkingActive = true
        if (streamChunk.thinkingDelta) {
          thinkingActive = true
        }

        // contentDelta 出现 → thinking 结束，content 开始
        if (streamChunk.contentDelta) {
          // 如果 thinking 活跃，先 yield thinking_end staged
          if (thinkingActive) {
            thinkingActive = false
            const thinkingStaged: StagedChunk = {
              type: 'staged',
              stagedType: 'thinking_end',
              content: '',
              thinking: state.getThinking(),
              msgId: state.getAssistantId(),
              createdAt: state.getTurnStartedAt(),
            }
            yield thinkingStaged
          }
          contentActive = true
        }

        // senseDelta 出现 → content 结束，sense 开始
        if (streamChunk.senseDelta && streamChunk.senseDelta.length > 0) {
          // 如果 thinking 活跃，先 yield thinking_end staged
          if (thinkingActive) {
            thinkingActive = false
            const thinkingStaged: StagedChunk = {
              type: 'staged',
              stagedType: 'thinking_end',
              content: '',
              thinking: state.getThinking(),
              msgId: state.getAssistantId(),
              createdAt: state.getTurnStartedAt(),
            }
            yield thinkingStaged
          }

          // 如果 content 活跃，yield content_end staged
          if (contentActive) {
            contentActive = false
            const contentStaged: StagedChunk = {
              type: 'staged',
              stagedType: 'content_end',
              content: state.getContent(),
              thinking: '',
              msgId: state.getAssistantId(),
              role: 'assistant',
              createdAt: state.getTurnStartedAt(),
            }
            yield contentStaged
          }
        }
      }

      // sense_end 时重置状态标记
      if (chunk.type === 'sense_end') {
        const trigger = chunk as SenseTriggerChunk
        // yield sense_end staged
        const senseStaged: StagedChunk = {
          type: 'staged',
          stagedType: 'sense_end',
          content: '',
          thinking: '',
          senseName: trigger.name,
          senseArguments: trigger.arguments,
          id: trigger.id,
          msgId: state.getAssistantId(),
          createdAt: state.getTurnStartedAt(),
        }
        yield senseStaged

        // 先 flush 本轮 assistant（content/thinking/senseCalls 已完整），在 pending sense 前 push，
        // 保证消息顺序 [user, assistant, sense]；sense_end 在 for-await 循环内，abort 时 effect 已被
        // observer 消费落库（finally 的 yield 在 gen.return 下死锁，不可依赖）。
        const flushedAssistant = state.flushAssistant(ctx)
        if (flushedAssistant) {
          yield {
            type: 'message_created',
            message: flushedAssistant,
          } as MiddlewareChunk
        }

        // smart/manual 模式：创建 pending sense 消息（若不存在），并 yield effect 交给 service 持久化。
        // resume 续接时 pending 已存在（同 trigger.id）→ 跳过创建，仅注册审批避免重复落库。
        if (trigger.supervisionLevel > 0 /* SupervisionLevel.auto */) {
          const { created, message } = ctx.journal.appendPendingSense({
            id: trigger.id,
            name: trigger.name,
            arguments: trigger.arguments,
          })
          if (created) {
            yield {
              type: 'message_created',
              message,
            } as MiddlewareChunk
          }

          // 始终注册审批（resume 时 pending 已存在，仅注册 approvalManager）。
          // P1-11：approvalResolve/approvalReject 已移除，service observer 据 approvalId 调 core registry。
          yield {
            type: 'sense_pending',
            approvalId: trigger.id,
            senseName: trigger.name,
            arguments: trigger.arguments,
            supervisionLevel: trigger.supervisionLevel,
            security: trigger.security,
          } as MiddlewareChunk
        } else if (trigger.name === 'ask_user_question') {
          // 这里只收集候选题，不立即通知前端。必须等 finally 将 ask handler 返回的 placeholder
          // sense 全部写入 journal/DB 后，再发一个完整批次，消除“事件先到、sense 尚不可写”的竞态。
          const args = safeJsonParse<Record<string, unknown>>(trigger.arguments, {}) as {
            question?: string
            header?: string
            options?: Array<{ label: string; description?: string }>
            multiSelect?: boolean
          }
          questionCandidates.push({
            questionId: trigger.id,
            question: args.question ?? '',
            ...(args.header ? { header: args.header } : {}),
            options: args.options ?? [],
            multiSelect: args.multiSelect ?? false,
            createdAt: Date.now(),
          })
        }
      }

      // sense_accept/sense_reject 时不重置标记（本轮 thinking/content 已 yield）
      // 新一轮标记由新 CheckpointState 初始化

      if (chunk.type === 'stream') {
        yield {
          ...chunk,
          msgId: state.getAssistantId(),
          createdAt: state.getTurnStartedAt(),
        } as StreamChunk
      } else {
        yield chunk
      }
    }

    // === 流结束后 yield 最终 staged（仅正常完成时） ===
    if (thinkingActive) {
      yield {
        type: 'staged',
        stagedType: 'thinking_end',
        content: '',
        thinking: state.getThinking(),
        msgId: state.getAssistantId(),
        createdAt: state.getTurnStartedAt(),
      } as StagedChunk
      thinkingActive = false
    }
    if (contentActive) {
      yield {
        type: 'staged',
        stagedType: 'content_end',
        content: state.getContent(),
        thinking: '',
        msgId: state.getAssistantId(),
        role: 'assistant',
        createdAt: state.getTurnStartedAt(),
      } as StagedChunk
      contentActive = false
    }
  } finally {
    // === 追加消息 + yield effect，由外层 observer 统一处理副作用 ===
    const mutations = state.appendResponseMessages(ctx)
    for (const mutation of mutations) {
      if (mutation.type === 'created') {
        yield {
          type: 'message_created',
          message: mutation.message,
        } as MiddlewareChunk
      } else {
        yield {
          type: 'message_updated',
          id: mutation.id,
          patch: mutation.patch,
        } as MiddlewareChunk
      }
    }

    // 流式多 sense_call reconcile：首个 sense_end 时 senseDeltas 未累积完整，流结束后补充 last assistant 的 senseCalls
    // （见 CheckpointState.reconcileAssistantSenseCalls）。无补充则返回 null。
    const reconcile = state.reconcileAssistantSenseCalls()
    if (reconcile && reconcile.type === 'updated') {
      yield {
        type: 'message_updated',
        id: reconcile.id,
        patch: reconcile.patch,
      } as MiddlewareChunk
    }

    // ask_user_question 批次必须最后发：前面的 message_created/message_updated 已由 observer
    // 顺序落库，此时 answer RPC 可安全地在单事务中更新所有 sense placeholder。
    const assistantMessageId = state.getFlushedAssistantId()
    if (assistantMessageId && questionCandidates.length > 0) {
      const messages = ctx.journal.getMessages()
      const pendingQuestions = questionCandidates.filter((question) =>
        messages.some(
          (message) =>
            message.id === question.questionId &&
            message.role === 'sense' &&
            message.content === '(等待用户回答…)',
        ),
      )
      if (pendingQuestions.length > 0) {
        yield {
          type: 'question_batch_pending',
          batchId: assistantMessageId,
          assistantMessageId,
          createdAt: Math.min(...pendingQuestions.map((question) => question.createdAt)),
          questions: pendingQuestions.map((question, position) => ({ ...question, position })),
        } as MiddlewareChunk
      }
    }
  }

  // 不再 yield done（由 loop.ts 负责）
}

export default checkpointMiddleware
