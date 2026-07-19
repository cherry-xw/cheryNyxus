<template>
  <div class="tag-select">
    <span class="lbl">
      {{ label }}
      <span
        v-if="tokenEstimate != null && tokenEstimate > tokenWarning"
        class="token-badge"
        :class="tokenEstimate > 10000 ? 'danger' : 'warn'"
      >
        约 {{ tokenEstimate }} token
      </span>
    </span>
    <div class="tag-select-tags">
      <el-tag
        v-for="item in displayed"
        :key="item"
        size="small"
        type="info"
        closable
        @close="remove(item)"
      >
        {{ item }}
      </el-tag>
      <span v-if="overflow > 0" v-popover:more class="tag-select-more"> +{{ overflow }} 更多 </span>
      <el-popover ref="more" :width="200" trigger="hover">
        <div style="display: flex; flex-wrap: wrap; gap: 4px">
          <el-tag
            v-for="item in modelValue"
            :key="item"
            size="small"
            type="info"
            closable
            @close="remove(item)"
          >
            {{ item }}
          </el-tag>
        </div>
      </el-popover>
    </div>
    <div class="tag-select-input">
      <el-select
        :model-value="[]"
        filterable
        multiple
        size="small"
        placeholder="添加..."
        @change="onAdd"
      >
        <el-option v-for="opt in unselected" :key="opt" :label="opt" :value="opt" />
      </el-select>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    modelValue: string[]
    options: string[]
    label: string
    maxDisplay?: number
    tokenEstimate?: number
    tokenWarning?: number
  }>(),
  {
    maxDisplay: 5,
    tokenWarning: 5000,
  },
)

const emit = defineEmits<{
  'update:modelValue': [val: string[]]
}>()

const displayed = computed(() => props.modelValue.slice(0, props.maxDisplay))
const overflow = computed(() => Math.max(0, props.modelValue.length - props.maxDisplay))
const unselected = computed(() => props.options.filter((o) => !props.modelValue.includes(o)))

function remove(item: string) {
  emit(
    'update:modelValue',
    props.modelValue.filter((v) => v !== item),
  )
}

function onAdd(vals: string[]) {
  emit('update:modelValue', [...props.modelValue, ...vals])
}
</script>

<style scoped lang="less">
@import '@/features/agent/settings/config/shared.less';
</style>
