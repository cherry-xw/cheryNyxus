<script setup lang="ts">
/**
 * ImagePreview：图片放大 lightbox，封装 el-image-viewer。
 * 单图：传 src；同批次多图：传 urls + initialIndex（el-image-viewer 原生支持前后切换）。
 */
import { computed } from 'vue'
import { ElImageViewer } from 'element-plus'

const props = defineProps<{
  /** 单图（向后兼容：MediaInlineRenderer 等传此值）；提供 urls 时忽略 */
  src?: string
  /** 同批次多图预览列表（提供时优先于 src） */
  urls?: string[]
  /** 初始展示索引（urls 模式下，默认 0） */
  initialIndex?: number
}>()
const emit = defineEmits<{ (e: 'close'): void }>()

const list = computed<string[]>(() => {
  if (props.urls && props.urls.length) return props.urls
  return props.src ? [props.src] : []
})
</script>

<template>
  <el-image-viewer
    v-if="list.length"
    :url-list="list"
    :initial-index="initialIndex ?? 0"
    teleported
    @close="emit('close')"
  />
</template>
