<script setup lang="ts">
/**
 * ImagePreview：图片放大 lightbox，封装 el-image-viewer。
 */
import { ElImageViewer } from "element-plus";

defineProps<{ src: string }>();
const emit = defineEmits<{ (e: "close"): void }>();
</script>

<template>
  <el-image-viewer
    :url-list="[src]"
    :initial-index="0"
    teleported
    @close="emit('close')"
  />
</template>
