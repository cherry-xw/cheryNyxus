<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Search } from '@element-plus/icons-vue'

const props = withDefaults(
  defineProps<{
    editorKey: string
    label: string
    modelValue?: string[]
    options: string[]
    tokenMap?: Record<string, number>
  }>(),
  { tokenMap: () => ({}) },
)

const emit = defineEmits<{
  (e: 'update:modelValue', value: string[]): void
  (e: 'close'): void
}>()

const search = ref('')
const page = ref(1)
const pageSize = 24
const selected = computed(() => props.modelValue ?? [])
const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  return props.options.filter(
    (name) => !selected.value.includes(name) && (!q || name.toLowerCase().includes(q)),
  )
})
const pageCount = computed(() => Math.max(1, Math.ceil(filtered.value.length / pageSize)))
const visible = computed(() =>
  filtered.value.slice((page.value - 1) * pageSize, page.value * pageSize),
)

watch(search, () => {
  page.value = 1
})
watch(
  () => props.editorKey,
  () => {
    search.value = ''
    page.value = 1
  },
)
watch(pageCount, (count) => {
  if (page.value > count) page.value = count
})

function add(name: string): void {
  if (selected.value.includes(name)) return
  emit('update:modelValue', [...selected.value, name])
}

function remove(name: string): void {
  emit(
    'update:modelValue',
    selected.value.filter((item) => item !== name),
  )
}
</script>

<template>
  <section class="equipment-editor">
    <header class="editor-head">
      <div>
        <b>整理{{ label }}</b>
        <small>已装备 {{ selected.length }} · 修改会随设置页统一保存</small>
      </div>
      <button type="button" class="close-editor" @click="emit('close')">完成</button>
    </header>

    <div class="selected-roster">
      <span v-if="!selected.length" class="editor-empty">尚未选择{{ label }}</span>
      <button
        v-for="name in selected"
        :key="name"
        type="button"
        class="selected-tag"
        :title="`移除 ${name}`"
        @click="remove(name)"
      >
        <span>{{ name }}</span
        ><small v-if="tokenMap[name]">≈{{ tokenMap[name] }}</small
        ><i>×</i>
      </button>
    </div>

    <div class="inventory-toolbar">
      <el-input v-model="search" clearable size="small" :placeholder="`搜索未装备${label}`">
        <template #prefix><Search class="search-icon" /></template>
      </el-input>
      <span>{{ filtered.length }} 个可选</span>
    </div>

    <div class="equipment-inventory">
      <button v-for="name in visible" :key="name" type="button" :title="name" @click="add(name)">
        <i>＋</i><b>{{ name }}</b
        ><small v-if="tokenMap[name]">≈{{ tokenMap[name] }}</small>
      </button>
      <div v-if="!visible.length" class="inventory-empty">没有匹配的未装备资源</div>
    </div>

    <div v-if="pageCount > 1" class="editor-pages">
      <button type="button" :disabled="page <= 1" @click="page--">‹</button>
      <span>{{ page }} / {{ pageCount }}</span>
      <button type="button" :disabled="page >= pageCount" @click="page++">›</button>
    </div>
  </section>
</template>

<style scoped lang="less">
@import '../config/shared.less';
.equipment-editor {
  display: flex;
  flex-direction: column;
  gap: 9px;
  margin-top: 2px;
  padding: 10px;
  border: 1px solid color-mix(in srgb, var(--tab-color, @accent) 36%, transparent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--tab-color, @accent) 5%, var(--surface));
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--ink) 10%, transparent);
}
.editor-head,
.inventory-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.editor-head > div {
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 7px;
}
.editor-head b {
  font-size: 12px;
  color: color-mix(in srgb, var(--tab-color, @accent) 76%, @ink);
}
.editor-head small,
.inventory-toolbar > span {
  font-size: 10px;
  color: color-mix(in srgb, var(--ink) 66%, transparent);
}
.close-editor {
  height: 24px;
  padding: 0 11px;
  border: 1px solid color-mix(in srgb, var(--tab-color, @accent) 46%, transparent);
  border-radius: 7px;
  background: color-mix(in srgb, var(--tab-color, @accent) 14%, var(--surface));
  color: color-mix(in srgb, var(--tab-color, @accent) 76%, @ink);
  font-size: 10px;
  font-weight: 600;
  cursor: pointer;
}
.selected-roster {
  min-height: 26px;
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.selected-tag {
  max-width: 100%;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 7px;
  border: 1px solid color-mix(in srgb, var(--tab-color, @accent) 30%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--tab-color, @accent) 13%, var(--surface));
  color: color-mix(in srgb, var(--tab-color, @accent) 76%, @ink);
  font-size: 10px;
  cursor: pointer;
}
.selected-tag > span {
  overflow-wrap: anywhere;
}
.selected-tag small {
  opacity: 0.68;
}
.selected-tag i {
  font-style: normal;
  font-weight: 900;
}
.editor-empty,
.inventory-empty {
  color: color-mix(in srgb, var(--ink) 62%, transparent);
  font-size: 10px;
  font-style: italic;
}
.inventory-toolbar :deep(.el-input) {
  width: min(320px, 70%);
}
.equipment-inventory {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
  gap: 5px;
}
.equipment-inventory > button {
  min-height: 34px;
  min-width: 0;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 5px;
  padding: 5px 8px;
  border: 1px solid color-mix(in srgb, var(--ink) 12%, transparent);
  border-radius: 8px;
  background: var(--surface);
  color: color-mix(in srgb, var(--ink) 74%, transparent);
  text-align: left;
  cursor: pointer;
}
.equipment-inventory > button:hover {
  border-color: color-mix(in srgb, var(--tab-color, @accent) 50%, transparent);
  box-shadow: 0 0 8px color-mix(in srgb, var(--tab-color, @accent) 14%, transparent);
}
.equipment-inventory b {
  overflow-wrap: anywhere;
  font-size: 10px;
}
.equipment-inventory i {
  color: var(--tab-color, @accent);
  font-style: normal;
  font-weight: 900;
}
.equipment-inventory small {
  font-size: 9px;
  color: color-mix(in srgb, var(--ink) 64%, transparent);
}
.inventory-empty {
  grid-column: 1 / -1;
  padding: 12px 4px;
  text-align: center;
}
.editor-pages {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: color-mix(in srgb, var(--ink) 55%, transparent);
  font-size: 10px;
}
.editor-pages button {
  width: 28px;
  height: 24px;
  border: 1px solid color-mix(in srgb, var(--ink) 14%, transparent);
  border-radius: 6px;
  background: var(--surface);
  cursor: pointer;
}
.editor-pages button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.search-icon {
  width: 12px;
}
</style>
