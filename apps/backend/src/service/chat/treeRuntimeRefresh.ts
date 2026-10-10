import { AgentBuilder } from '@/agent/builder.js'
import type { RuntimeSelection } from '@/agent/runtimeResolver.js'
import { resolveSelectionIssues } from '@/agent/runtimeResolver.js'
import { getChat, getChatMetadata } from '@/db/chat.js'
import { getActiveChatEpoch } from '@/db/epoch.js'
import { getMessages } from '@/db/message.js'
import { listPendingInputs } from '@/db/pendingInput.js'
import { treeChatIds } from '@/service/config/treeBoundary.js'
import { buildLivePromptSnapshot } from './promptSnapshot.js'
import { chatRuntimes, type ChatRuntime } from './runtimeCache.js'
import {
  configureRuntime,
  resolveEffectiveSelection,
  loadHistory,
  chatInitOptions,
} from './runtime.js'

/** Build replacement engines without touching the live map. Caller owns the
 * synchronous config/metadata transaction and publishes only after all succeed. */
export function prepareTreeRuntimeRefresh(rootId: string): {
  snapshots: Array<{
    chatId: string
    selection: RuntimeSelection
    systemPrompt: string
    tools: ReturnType<typeof buildLivePromptSnapshot>['tools']
    resourceSummary: ReturnType<typeof buildLivePromptSnapshot>['resourceSummary']
  }>
  publish(epochId: string): void
  dispose(): void
} {
  const replacements = new Map<string, ChatRuntime>()
  const snapshots: Array<{
    chatId: string
    selection: RuntimeSelection
    systemPrompt: string
    tools: ReturnType<typeof buildLivePromptSnapshot>['tools']
    resourceSummary: ReturnType<typeof buildLivePromptSnapshot>['resourceSummary']
  }> = []
  const builders: AgentBuilder[] = []
  try {
    for (const chatId of treeChatIds(rootId)) {
      if (getChat(chatId)?.lifecycle !== 'active') continue
      const old = chatRuntimes.get(chatId)
      let effective = resolveEffectiveSelection(chatId)
      const metadata = getChatMetadata(chatId)
      if (
        (!effective || effective.status === 'invalid') &&
        old?.selection &&
        !metadata.roleId &&
        !metadata.type &&
        !metadata.presetId &&
        !metadata.preset &&
        !resolveSelectionIssues(old.selection).length
      ) {
        effective = { status: 'followed', selection: old.selection, issues: [] }
      }
      if (!effective || effective.status === 'invalid') {
        if (old) throw new Error('受影响会话无法关联新运行配置')
        continue
      }
      const builder = new AgentBuilder().build()
      builders.push(builder)
      const runtime: ChatRuntime = { builder }
      configureRuntime(runtime, chatId, effective.selection, false)
      const live = buildLivePromptSnapshot(chatId, effective.selection)
      const epoch = getActiveChatEpoch(chatId)
      builder.init(
        chatId,
        chatInitOptions(chatId, epoch ? loadHistory(chatId, epoch) : undefined, live.systemPrompt),
      )
      const pendingIds = new Set<string>()
      for (const entry of old?.builder.getPendingInputs() ?? []) {
        builder.enqueueInput(entry.content, entry)
        if (entry.inputId) pendingIds.add(entry.inputId)
      }
      const messageIds = new Set(getMessages(chatId).map((message) => message.id))
      for (const entry of listPendingInputs(chatId)) {
        if (pendingIds.has(entry.input_id) || messageIds.has(entry.message_id)) continue
        builder.enqueueInput(entry.content, {
          inputId: entry.input_id,
          messageId: entry.message_id,
          clientMessageId: entry.client_message_id ?? undefined,
          commandId: entry.command_id,
        })
      }
      snapshots.push({ chatId, selection: effective.selection, ...live })
      if (old) replacements.set(chatId, runtime)
      else builder.dispose()
    }
  } catch (error) {
    for (const builder of builders) builder.dispose()
    throw error
  }
  return {
    snapshots,
    dispose() {
      for (const builder of builders) builder.dispose()
    },
    publish(epochId) {
      for (const [chatId, runtime] of replacements) {
        runtime.epochId = epochId
        chatRuntimes.get(chatId)?.builder.dispose()
        chatRuntimes.set(chatId, runtime)
      }
    },
  }
}
