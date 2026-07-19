<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Search } from '@element-plus/icons-vue'
import { computeSelectionTokens } from '../shared'

const props = withDefaults(
  defineProps<{
    modelValue?: string[]
    options: string[]
    tokenMap?: Record<string, number>
    label: string
    inheritLabel?: string
    /** 隐藏内联已选清单（仅留模式按钮 + 整理装备入口）；调用方自行渲染统一清单。 */
    hideInlineRoster?: boolean
  }>(),
  { tokenMap: () => ({}), inheritLabel: '继承全部', hideInlineRoster: false },
)
const emit = defineEmits<{ (e: 'update:modelValue', value: string[] | undefined): void }>()
const open = ref(false)
const search = ref('')
const page = ref(1)
const pageSize = 36
const draft = ref<string[]>([])
const mode = computed(() =>
  props.modelValue === undefined ? 'inherit' : props.modelValue.length ? 'custom' : 'none',
)
const selected = computed(() => props.modelValue ?? props.options)
const tokens = computed(() =>
  computeSelectionTokens(props.modelValue, props.options, props.tokenMap),
)
const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  return props.options.filter(
    (name) => !draft.value.includes(name) && (!q || name.toLowerCase().includes(q)),
  )
})
const pageCount = computed(() => Math.max(1, Math.ceil(filtered.value.length / pageSize)))
const visible = computed(() =>
  filtered.value.slice((page.value - 1) * pageSize, page.value * pageSize),
)
watch(search, () => {
  page.value = 1
})

function edit(): void {
  draft.value = props.modelValue?.slice() ?? []
  open.value = true
}
function add(name: string): void {
  if (!draft.value.includes(name)) draft.value.push(name)
}
function remove(name: string): void {
  draft.value = draft.value.filter((item) => item !== name)
}
function confirm(): void {
  emit('update:modelValue', draft.value.length ? draft.value.slice() : [])
  open.value = false
}
</script>

<template>
  <section class="equipment-slot" :class="{ overloaded: tokens > 5000 }">
    <header>
      <span
        ><b>{{ label }}</b
        ><small>{{
          mode === 'inherit'
            ? inheritLabel
            : mode === 'none'
              ? '全不使用'
              : `已装备 ${modelValue?.length ?? 0}`
        }}</small></span
      >
      <span class="equipment-token">≈ {{ tokens }} token</span>
    </header>
    <div class="equipment-mode">
      <button
        type="button"
        :class="{ active: mode === 'inherit' }"
        @click="emit('update:modelValue', undefined)"
      >
        继承全部
      </button>
      <button type="button" :class="{ active: mode === 'custom' }" @click="edit">自选装备</button>
      <button
        type="button"
        :class="{ active: mode === 'none' }"
        @click="emit('update:modelValue', [])"
      >
        全不使用
      </button>
    </div>
    <div v-if="mode === 'custom'" class="equipment-selected">
      <template v-if="!hideInlineRoster">
        <span v-for="name in modelValue" :key="name"
          >{{ name }}<small v-if="tokenMap[name]"> ≈{{ tokenMap[name] }}</small></span
        >
      </template>
      <button type="button" class="manage-btn" @click="edit">整理装备</button>
    </div>
    <p v-if="tokens > 5000" class="equipment-warning">
      装备较多会增加每次对话的默认系统提示词体积。
    </p>
  </section>

  <el-drawer v-model="open" :title="`整理${label}`" size="480px" append-to-body>
    <div class="equipment-drawer">
      <div class="drawer-selected">
        <b>已装备 {{ draft.length }}</b>
        <div>
          <el-tag v-for="name in draft" :key="name" closable size="small" @close="remove(name)"
            >{{ name }}<small v-if="tokenMap[name]"> ≈{{ tokenMap[name] }}</small></el-tag
          >
        </div>
      </div>
      <el-input v-model="search" clearable placeholder="搜索未装备资源">
        <template #prefix><Search class="search-icon" /></template>
      </el-input>
      <div class="equipment-inventory">
        <button v-for="name in visible" :key="name" type="button" @click="add(name)">
          <span>＋</span><b>{{ name }}</b
          ><small v-if="tokenMap[name]">≈{{ tokenMap[name] }}</small>
        </button>
      </div>
      <div v-if="pageCount > 1" class="drawer-pages">
        <button type="button" :disabled="page <= 1" @click="page--">‹</button
        ><span>{{ page }} / {{ pageCount }}</span
        ><button type="button" :disabled="page >= pageCount" @click="page++">›</button>
      </div>
    </div>
    <template #footer
      ><button type="button" class="ghost-btn" @click="open = false">取消</button
      ><button type="button" class="primary-btn" @click="confirm">保存装备</button></template
    >
  </el-drawer>
</template>

<style scoped lang="less">
@import '../shared.less';
.equipment-slot {
  padding: 9px;
  border: 1px solid rgba(36, 38, 45, 0.12);
  border-radius: 9px;
  background: rgba(255, 255, 255, 0.5);
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.equipment-slot.overloaded {
  border-color: rgba(190, 132, 28, 0.45);
}
.equipment-slot header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.equipment-slot header span:first-child {
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.equipment-slot b {
  font-size: 12px;
}
.equipment-slot small {
  font-size: 10px;
  color: fade(@ink, 48%);
}
.equipment-token {
  font-size: 10px;
  font-weight: 700;
  color: color-mix(in srgb, var(--tab-color, @accent) 75%, @ink);
}
.equipment-mode {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 4px;
}
.equipment-mode button {
  height: 25px;
  border: 1px solid rgba(36, 38, 45, 0.13);
  border-radius: 7px;
  background: #fff;
  color: fade(@ink, 62%);
  font-size: 10px;
  cursor: pointer;
}
.equipment-mode button.active {
  background: linear-gradient(120deg, rgba(59, 130, 246, 0.11), rgba(168, 85, 247, 0.12));
  border-color: rgba(99, 102, 241, 0.38);
  color: #4338ca;
  font-weight: 800;
  box-shadow: 0 0 8px rgba(99, 102, 241, 0.08);
}
.equipment-selected {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.equipment-selected span {
  padding: 2px 7px;
  border-radius: 999px;
  background: rgba(99, 102, 241, 0.1);
  font-size: 10px;
  color: #4338ca;
}
.manage-btn {
  border: 1px dashed color-mix(in srgb, var(--tab-color, @accent) 50%, transparent);
  border-radius: 999px;
  background: transparent;
  color: color-mix(in srgb, var(--tab-color, @accent) 75%, @ink);
  font-size: 10px;
  cursor: pointer;
}
.equipment-warning {
  margin: 0;
  font-size: 10px;
  color: #92590a;
}
.equipment-drawer {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.drawer-selected > div {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 6px;
}
.equipment-inventory {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 5px;
}
.equipment-inventory button {
  min-height: 38px;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 5px;
  border: 1px solid rgba(36, 38, 45, 0.12);
  border-radius: 8px;
  background: #fff;
  text-align: left;
  cursor: pointer;
}
.equipment-inventory button:hover {
  .neon-border(@neon-indigo);
}
.equipment-inventory b {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.drawer-pages {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 8px;
}
.drawer-pages button {
  width: 28px;
  height: 25px;
}
.search-icon {
  width: 13px;
}
.primary-btn {
  margin-left: 6px;
  padding: 6px 14px;
  border: 0;
  border-radius: 6px;
  background: var(--tab-color, @accent);
  font-weight: 800;
  cursor: pointer;
}
</style>
