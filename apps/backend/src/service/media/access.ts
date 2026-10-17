import { getChat, getRootChatId, updateChatMetadata } from '@/db/chat.js'
import type { HandlerContext } from '../message/router.js'
import { ingressExecution } from '../ingress/request.js'
import type { AssetAccess } from './assetStore.js'

export function requireFileOwner(ctx: Pick<HandlerContext, 'authenticatedUserId'>): string {
  const identity = ingressExecution.getStore()?.identity
  const owner = identity?.source === 'plugin' ? identity.ownerId : ctx.authenticatedUserId
  if (!owner) throw Object.assign(new Error('文件操作需要已验证的身份'), { code: 'IDENTITY_REJECTED' })
  return owner
}

/** 文件沿既有会话入口授权，并额外核对持久所有者；旧归属不明会话不能静默认领。 */
export function fileAccessForChat(chatId: string, ownerId?: string): AssetAccess {
  const chat = getChat(chatId)
  if (!chat) throw new Error('会话不存在')
  const root = getChat(getRootChatId(chatId)) ?? chat
  const metadata = JSON.parse(root.metadata ?? '{}') as Record<string, unknown>
  const stored = typeof metadata.fileOwnerId === 'string' ? metadata.fileOwnerId : undefined
  if (ownerId && stored && stored !== ownerId) throw new Error('无权访问此会话的文件')
  const owner = ownerId ?? stored
  if (!owner || owner === 'migration:unclaimed') throw new Error('历史文件归属尚未确认，请先认领此会话文件')
  return { ownerId: owner, chatId }
}

export function bindNewChatFileOwner(chatId: string, ownerId: string): AssetAccess {
  const chat = getChat(chatId)
  if (!chat) throw new Error('会话不存在')
  const metadata = JSON.parse(chat.metadata ?? '{}') as Record<string, unknown>
  if (!metadata.fileOwnerId) updateChatMetadata(chatId, { fileOwnerId: ownerId })
  return fileAccessForChat(chatId, ownerId)
}
