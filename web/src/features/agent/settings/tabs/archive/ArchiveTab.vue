<script setup lang="ts">
import TabShell from '../../components/TabShell.vue'
import ConfirmPopover from '@/components/confirm/ConfirmPopover.vue'
import ArchiveNode from './ArchiveNode.vue'
import { useArchiveTab } from './useArchiveTab'

const {
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
} = useArchiveTab()
</script>

<template>
  <TabShell tab-key="archive">
    <template #hints>
      <p>
        会话归档后保留全部历史，不能继续执行或恢复。子 Agent
        和继续、解释分支归属于同一主会话；彻底删除主会话会一并删除它们。
      </p>
      <p>归档长期保留，不会自动清空。这里的操作立即生效，无需点击设置保存。</p>
    </template>
    <template #toolbar>
      <div class="archive-toolbar">
        <label class="archive-search"
          >搜索归档
          <input v-model="query" :disabled="deleting" placeholder="预设、Agent、会话摘要或 ID"
        /></label>
        <label
          >预设
          <select v-model="presetId" :disabled="deleting">
            <option value="">全部预设</option>
            <option v-for="preset in result.presets" :key="preset.id" :value="preset.id">
              {{ preset.label }}
            </option>
          </select></label
        >
        <button type="button" :disabled="busy" @click="refresh">刷新</button>
      </div>
      <div class="archive-actions">
        <label
          ><input
            type="checkbox"
            :checked="allSelected"
            :disabled="busy || !groups.length"
            @change="toggleAll"
          />
          选择本页主会话</label
        >
        <span>已选 {{ selected.length }} 组 · 共 {{ result.total }} 组</span>
        <ConfirmPopover
          title="彻底删除所选归档？"
          :impact="deletionImpact(selectedGroups)"
          confirm-text="彻底删除"
          @confirm="remove([...selectedGroups])"
        >
          <template #trigger
            ><button type="button" class="danger" :disabled="busy || !selected.length">
              彻底删除所选
            </button></template
          >
        </ConfirmPopover>
      </div>
      <p class="archive-note">已归档 · 仅供查看。删除操作立即生效，无需保存设置。</p>
    </template>
    <div class="archive-body" :aria-busy="busy">
      <p v-if="error" class="archive-error" role="alert">
        {{ error }} <button type="button" :disabled="busy" @click="refresh">重试加载</button>
      </p>
      <p v-if="feedback" role="status">{{ feedback }}</p>
      <p v-if="loading" role="status">正在读取归档…</p>
      <p v-else-if="!groups.length && !error">
        {{
          query || presetId
            ? '没有匹配的归档，试试其他关键词或预设。'
            : '暂无归档。在会话列表中选择归档后，可在这里查看历史。'
        }}
      </p>
      <article v-for="group in groups" :key="group.rootChatId" class="archive-group">
        <header>
          <label
            ><input
              v-model="selected"
              type="checkbox"
              :value="group.rootChatId"
              :disabled="busy"
              :aria-label="`选择主会话 ${group.tree.label}`"
            />
            <span class="archive-title">{{ group.tree.label }}</span></label
          >
          <span>{{ group.date }} · {{ group.chats.length - 1 }} 个关联会话</span>
          <ConfirmPopover
            :title="`彻底删除「${group.tree.label}」？`"
            :impact="deletionImpact([group])"
            confirm-text="彻底删除"
            @confirm="remove([group])"
          >
            <template #trigger
              ><button type="button" class="danger" :disabled="busy">彻底删除</button></template
            >
          </ConfirmPopover>
        </header>
        <p v-if="group.archiveReason" class="archive-reason">{{ group.archiveReason }}</p>
        <ul class="archive-tree">
          <ArchiveNode :node="group.tree" @view="viewChat" />
        </ul>
      </article>
      <nav v-if="result.total" class="archive-pagination" aria-label="归档分页">
        <button type="button" :disabled="busy || page <= 1" @click="changePage(page - 1)">
          上一页
        </button>
        <span>{{ page }} / {{ Math.max(1, Math.ceil(result.total / 20)) }} 页 · 每页 20 组</span>
        <button
          type="button"
          :disabled="busy || page * 20 >= result.total"
          @click="changePage(page + 1)"
        >
          下一页
        </button>
      </nav>
    </div>
  </TabShell>
</template>

<style scoped>
.archive-toolbar,
.archive-actions,
header,
.archive-pagination {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}
.archive-toolbar,
.archive-actions {
  width: 100%;
}
.archive-toolbar label,
header label {
  display: flex;
  align-items: center;
  gap: 8px;
}
.archive-search {
  flex: 1;
  min-width: 220px;
}
.archive-search input {
  flex: 1;
  min-width: 100px;
}
input:not([type='checkbox']),
select,
button {
  border: 1px solid var(--border);
  border-radius: 0;
  background: var(--surface);
  color: var(--ink);
  padding: 6px 9px;
  font: inherit;
}
select {
  max-width: 200px;
}
input[type='checkbox'] {
  accent-color: var(--accent);
}
button {
  cursor: pointer;
  color: var(--accent);
}
button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
button:focus-visible,
input:focus-visible,
select:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.danger {
  color: var(--el-color-danger);
}
.archive-note,
.archive-reason,
header > span {
  font-size: 12px;
  margin: 4px 0;
}
.archive-body {
  padding: 12px;
  color: var(--ink);
  font-weight: 400;
}
.archive-group {
  border: 1px solid var(--border);
  background: var(--panel);
  padding: 12px;
  margin-bottom: 12px;
}
header label {
  flex: 1;
  min-width: 160px;
}
.archive-title {
  font-weight: 600;
  overflow-wrap: anywhere;
}
.archive-tree {
  padding: 0;
  margin: 10px 0 0;
}
.archive-error {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--el-color-danger);
}
.archive-pagination {
  justify-content: center;
  padding: 12px 0;
}
</style>
