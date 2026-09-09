import type { ArchiveGroup, ArchiveListRequest, ArchiveListResponse } from '@chery/protocol'
import { deleteChats, getChatMetadata, getChatPreviews } from '@/db/chat.js'
import { getChatFamily, listChatFamilies, type ChatFamily } from '@/db/chatFamily.js'
import { archiveChatRows } from '../config/roleLifecycle.js'
import { clearChatRuntime, isChatRunning } from './runtime.js'
import { clearWaitedChild, clearWaitedChildrenByParent } from '@/agent/spawnBroker.js'
import type { HandlerContext } from '../message/router.js'
import { ErrorCode } from '../message/types.js'
import { broadcastChatLifecycle } from './lifecycleEvents.js'

function conflict(message: string): never {
  throw Object.assign(new Error(message), { code: ErrorCode.CONFLICT })
}

function assertGroupRoot(family: ChatFamily, chatId: string): void {
  const root = family.chats.find((chat) => chat.id === chatId)
  if (family.rootChatId !== chatId || root?.parent_chat_id) {
    conflict('请在归档列表中操作主会话，子 Agent 和关联分支不能单独删除或归档。')
  }
  if (family.chats.some((chat) => isChatRunning(chat.id))) {
    conflict('主会话或关联 Agent 仍在运行，请先停止运行后重试。')
  }
}

export async function handleChatArchive(_ctx: HandlerContext, data: { chatId: string }) {
  const family = getChatFamily(data.chatId)
  if (!family) throw Object.assign(new Error('这个会话不见了'), { code: ErrorCode.NOT_FOUND })
  assertGroupRoot(family, data.chatId)
  archiveChatRows(family.chats, '用户归档会话')
  const archivedChatIds = family.chats.map((chat) => chat.id)
  broadcastChatLifecycle({ action: 'archived', chatIds: archivedChatIds })
  return { chatId: data.chatId, archivedChatIds }
}

export async function handleChatDelete(_ctx: HandlerContext, data: { chatId: string }) {
  const family = getChatFamily(data.chatId)
  if (!family) return { chatId: data.chatId, deletedChatIds: [] }
  assertGroupRoot(family, data.chatId)
  if (family.chats.some((chat) => chat.lifecycle !== 'archived')) {
    conflict('请先归档整个主会话，再从设置的归档页彻底删除。')
  }
  const deletedChatIds = family.chats.map((chat) => chat.id)
  deleteChats(deletedChatIds)
  for (const id of deletedChatIds) {
    clearWaitedChild(id)
    clearWaitedChildrenByParent(id)
    clearChatRuntime(id)
  }
  broadcastChatLifecycle({ action: 'deleted', chatIds: deletedChatIds })
  return { chatId: data.chatId, deletedChatIds }
}

export async function handleArchiveList(
  _ctx: HandlerContext,
  data: ArchiveListRequest,
): Promise<ArchiveListResponse> {
  const families = listChatFamilies().filter((family) =>
    family.chats.some((chat) => chat.id === family.rootChatId && chat.lifecycle === 'archived'),
  )
  // Metadata only; message bodies remain in the existing lazy history viewer.
  const previews = getChatPreviews(families.flatMap((family) => family.chats))
  const groups: ArchiveGroup[] = families.map((family) => {
    const meta = getChatMetadata(family.rootChatId)
    return {
      rootChatId: family.rootChatId,
      archivedAt: typeof meta.archivedAt === 'number' ? meta.archivedAt : undefined,
      archiveReason: typeof meta.archiveReason === 'string' ? meta.archiveReason : undefined,
      chats: family.chats.map((chat) => {
        const metadata = getChatMetadata(chat.id)
        return {
          chatId: chat.id,
          parentChatId: chat.parent_chat_id ?? null,
          presetId: typeof metadata.presetId === 'string' ? metadata.presetId : undefined,
          preset: typeof metadata.preset === 'string' ? metadata.preset : undefined,
          agentType: typeof metadata.type === 'string' ? metadata.type : undefined,
          avatar: typeof metadata.avatar === 'string' ? metadata.avatar : undefined,
          preview: previews.get(chat.id)?.preview ?? '',
          messageCount: chat.message_count ?? 0,
          branchKind: family.branchKinds.get(chat.id),
        }
      }),
    }
  })
  const presetOptions = new Map<string, string>()
  const presetKey = (group: ArchiveGroup) => {
    const root = group.chats.find((chat) => chat.chatId === group.rootChatId)!
    return root.presetId ?? `name:${root.preset ?? ''}`
  }
  for (const group of groups) {
    const root = group.chats.find((chat) => chat.chatId === group.rootChatId)!
    presetOptions.set(presetKey(group), root.preset ?? '未命名预设')
  }
  const query = data.query?.trim().toLocaleLowerCase() ?? ''
  const filtered = groups
    .filter(
      (group) =>
        (!data.presetId || presetKey(group) === data.presetId) &&
        (!query ||
          group.chats.some((chat) =>
            [chat.chatId, chat.agentType, chat.preset, chat.preview].some((value) =>
              value?.toLocaleLowerCase().includes(query),
            ),
          )),
    )
    .sort(
      (a, b) =>
        (b.archivedAt ?? 0) - (a.archivedAt ?? 0) || a.rootChatId.localeCompare(b.rootChatId),
    )
  const pageSize = data.pageSize ?? 20
  const page = Math.min(data.page ?? 1, Math.max(1, Math.ceil(filtered.length / pageSize)))
  return {
    groups: filtered.slice((page - 1) * pageSize, page * pageSize),
    total: filtered.length,
    page,
    pageSize,
    presets: [...presetOptions].map(([id, label]) => ({ id, label })),
  }
}
