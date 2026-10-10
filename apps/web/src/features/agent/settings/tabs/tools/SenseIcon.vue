<script setup lang="ts">
/**
 * SenseIcon：感官能力的统一图标入口。
 * 图标元数据来自 sense.tools 协议；未知的自定义 / MCP 感官先共用 ⚙，
 * 让设置、角色名片及之后的任何入口保持相同的降级表现。
 */
import { computed } from 'vue'
import type { SenseToolInfo } from '@/application/backend/public'

const props = withDefaults(
  defineProps<{
    /** 可含 :auto / :confirm 等监管等级后缀。 */
    name: string
    tools?: SenseToolInfo[]
  }>(),
  {
    tools: () => [],
  },
)

const toolName = computed(() => props.name.split(':')[0] ?? props.name)
const tool = computed(() => props.tools.find((item) => item.name === toolName.value))
const icon = computed(() => tool.value?.icon ?? '⚙')
const label = computed(() => tool.value?.label ?? toolName.value)
</script>

<template>
  <span class="sense-icon" :title="label" :aria-label="label">{{ icon }}</span>
</template>

<style scoped lang="less">
.sense-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.25em;
  height: 1.25em;
  flex: 0 0 auto;
  font-family:
    ui-rounded, 'Hiragino Sans', 'PingFang SC', 'Noto Sans Symbols 2', 'Apple Color Emoji',
    'Segoe UI Emoji', sans-serif;
  font-size: 1em;
  line-height: 1;
}
</style>
