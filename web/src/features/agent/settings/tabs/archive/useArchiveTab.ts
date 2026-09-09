import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { ArchiveGroup, ArchiveListResponse } from '@chery/protocol'
import { agentApi } from '@/application/backend/public'
import {
  archiveRevision,
  useAgentsStore,
  useConnectionStore,
  useWorkspaceStore,
} from '@/application/public'
import { desktopBridge } from '@/features/desktop/desktopBridge'
import { archiveTree, deletionImpact } from './model'

export function useArchiveTab() {
  const workspace = useWorkspaceStore()
  const agents = useAgentsStore()
  const connection = useConnectionStore()
  const query = ref('')
  const presetId = ref('')
  const page = ref(1)
  const result = ref<ArchiveListResponse>({
    groups: [],
    total: 0,
    page: 1,
    pageSize: 20,
    presets: [],
  })
  const selected = ref<string[]>([])
  const loading = ref(false)
  const deleting = ref(false)
  const error = ref('')
  const feedback = ref('')
  let sequence = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  async function refresh() {
    if (disposed || connection.status !== 'connected') return
    const request = ++sequence
    loading.value = true
    error.value = ''
    try {
      const response = await agentApi.listArchives({
        query: query.value,
        presetId: presetId.value,
        page: page.value,
        pageSize: 20,
      })
      if (request !== sequence || disposed) return
      result.value = response
      page.value = response.page
      selected.value = selected.value.filter((id) =>
        response.groups.some((group) => group.rootChatId === id),
      )
    } catch (cause) {
      if (request === sequence && !disposed)
        error.value = cause instanceof Error ? cause.message : '归档加载失败，请重试'
    } finally {
      if (request === sequence && !disposed) loading.value = false
    }
  }
  function filterChanged() {
    selected.value = []
    page.value = 1
    sequence += 1
    clearTimeout(timer)
    timer = setTimeout(() => void refresh(), 250)
  }
  watch([query, presetId], filterChanged)
  watch(
    [archiveRevision, () => connection.status],
    () => {
      if (!deleting.value) void refresh()
    },
    { immediate: true },
  )
  function changePage(next: number) {
    selected.value = []
    page.value = next
    void refresh()
  }
  const groups = computed(() =>
    result.value.groups.map((group) => ({
      ...group,
      tree: archiveTree(group, query.value),
      date: group.archivedAt ? new Date(group.archivedAt).toLocaleString() : '历史归档，时间未知',
    })),
  )
  const selectedGroups = computed(() =>
    result.value.groups.filter((group) => selected.value.includes(group.rootChatId)),
  )
  const busy = computed(() => loading.value || deleting.value || connection.status !== 'connected')
  const allSelected = computed(
    () => groups.value.length > 0 && selected.value.length === groups.value.length,
  )
  function toggleAll() {
    selected.value = allSelected.value ? [] : groups.value.map((group) => group.rootChatId)
  }
  function viewChat(chatId: string) {
    const bridge = desktopBridge()
    if (bridge) bridge.openWindow({ kind: 'history', chatId, source: 'history' })
    else workspace.openHistoryRoot(chatId)
  }
  async function remove(groupsToDelete: ArchiveGroup[]) {
    if (busy.value || !groupsToDelete.length) return
    deleting.value = true
    sequence += 1
    clearTimeout(timer)
    error.value = ''
    feedback.value = ''
    const failures: string[] = []
    let removed = 0
    for (const group of groupsToDelete) {
      try {
        const response = await agentApi.destroyAgent(group.rootChatId)
        removed += 1
        result.value.groups = result.value.groups.filter(
          (item) => item.rootChatId !== group.rootChatId,
        )
        selected.value = selected.value.filter((id) => id !== group.rootChatId)
        await agents.purgeDeletedChats(response.deletedChatIds)
      } catch (cause) {
        failures.push(
          `${group.chats.find((chat) => chat.chatId === group.rootChatId)?.preset || group.rootChatId}：${cause instanceof Error ? cause.message : '删除失败'}`,
        )
      }
    }
    deleting.value = false
    await refresh()
    feedback.value = removed ? `已彻底删除 ${removed} 组归档。` : ''
    if (failures.length) error.value = failures.join('\n')
  }
  onBeforeUnmount(() => {
    disposed = true
    sequence += 1
    clearTimeout(timer)
  })
  return {
    query,
    presetId,
    page,
    result,
    groups,
    selected,
    selectedGroups,
    busy,
    loading,
    deleting,
    error,
    feedback,
    allSelected,
    toggleAll,
    refresh,
    changePage,
    viewChat,
    remove,
    deletionImpact,
  }
}
