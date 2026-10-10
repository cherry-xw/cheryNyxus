import { createHash, randomUUID } from 'node:crypto'
import config from '@/utils/config.js'
import { resolvePresetSelection } from '@/agent/runtimeResolver.js'
import { getChat } from '@/db/chat.js'
import { onPreparedChatEvent } from '@/db/delivery.js'
import { handleChatCreate } from '../chat/handler.js'
import { handleChatInputSubmit } from '../chat/input.js'
import { handleChatAbort } from '../chat/send.js'
import { connectionManager } from '../websocket/connection.js'
import { transport } from '../websocket/transport.js'
import { logger } from '@/utils/logger/index.js'
import { ingressExecution } from './request.js'
import { immutableSnapshot, type IngressConnections, type IngressCoreAdapter } from './api.js'

function conversationId(owner: string, key: string): string {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(owner) || !key || key.length > 512)
    throw new Error('Invalid ingress conversation key')
  return `ingress-${owner}-${createHash('sha256').update(key).digest('hex')}`
}
/** This adapter never accepts a caller-selected core chat ID or arbitrary RPC. */
export function createIngressCoreAdapter(): IngressCoreAdapter {
  const owned = new Map<string, Map<string, string>>()
  const pending = new Map<string, Promise<{ chatId: string }>>()
  const context = (owner: string) => ({
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
