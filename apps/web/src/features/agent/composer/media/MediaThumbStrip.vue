<script setup lang="ts">
import type { MediaAttachment } from '../useAgentDialogOptions'
import { useDraftFilePreview } from './useDraftFilePreview'
import ImagePreview from '@/components/media/ImagePreview.vue'
import AudioPlayer from '@/components/media/AudioPlayer.vue'
import VideoPlayer from '@/components/media/VideoPlayer.vue'
const props = defineProps<{ attachments: MediaAttachment[] }>()
const emit = defineEmits<{
  remove: [attachment: MediaAttachment]
  toggle: [attachment: MediaAttachment, field?: 'variant' | 'usage']
}>()
const { preview, imageUrls, busy: previewBusy, error: previewError, open, close } = useDraftFilePreview(() => props.attachments)
function download(a: MediaAttachment) {
  const link = document.createElement('a'); link.href = a.previewUrl; link.download = a.filename; link.click()
}
</script>
<template>
  <ul v-if="attachments.length" class="media-thumb-strip" aria-label="待发送文件">
    <li v-for="(a, index) in attachments" :key="a.referenceId || a.previewUrl || a.assetId">
      <span class="filename">附件 {{ index + 1 }} · {{ a.filename }}</span>
      <span>{{ ((a.useCompressed && a.compressed ? a.compressed.size : a.size) / 1024).toFixed(1) }} KiB · {{ a.status === 'uploading' ? '上传中' : a.status === 'failed' ? '上传失败' : (a.useCompressed && a.compressed) || a.variant === 'adapted' ? '适配版本' : '原始文件' }}</span>
      <p v-if="a.error" role="alert">{{ a.error }}</p>
      <div class="actions">
        <button v-if="a.status === 'failed'" type="button" @click="a.retry?.()">重试上传</button>
        <button v-if="['image','video','audio'].includes(a.kind)" type="button" :disabled="previewBusy" @click="open(a)">预览{{ a.variant === 'adapted' ? '适配版本' : '原始文件' }}</button>
        <button v-if="a.compressed" type="button" :disabled="previewBusy" @click="open(a, true)">预览适配版本</button>
        <button v-if="!['image','video','audio'].includes(a.kind)" type="button" @click="download(a)">查看文件</button>
        <button type="button" :aria-pressed="a.usage === 'reference-only'" @click="emit('toggle', a, 'usage')">{{ a.usage === 'reference-only' ? '仅附文件 · 本次不读取' : '本次使用内容' }}</button>
        <button v-if="a.copy" type="button" :disabled="a.status !== 'ready'" @click="a.copy()">复制引用</button>
        <button v-if="a.compressed" type="button" @click="emit('toggle', a, 'variant')">改用{{ a.useCompressed ? '原始文件' : '适配版本' }}</button>
        <button v-else-if="a.kind === 'image' && a.adapt" type="button" :disabled="a.status !== 'ready' || a.adapting" @click="a.adapt()">{{ a.adapting ? '正在生成适配版本' : '生成并采用适配版本' }}</button>
        <button type="button" :aria-label="`移除 ${a.filename}`" @click="emit('remove', a)">{{ a.status === 'uploading' ? '取消此项' : '移除' }}</button>
      </div>
    </li>
  </ul>
  <p v-if="previewError" role="alert">{{ previewError }}</p>
  <ImagePreview v-if="preview?.kind === 'image'" :urls="imageUrls" :initial-index="0" @close="close" />
  <AudioPlayer v-else-if="preview?.kind === 'audio'" :src="preview.previewUrl" @close="close" />
  <VideoPlayer v-else-if="preview?.kind === 'video'" :src="preview.previewUrl" @close="close" />
</template>
<style scoped>
.media-thumb-strip { display:flex; flex-wrap:wrap; gap:8px; padding:0; margin:0; list-style:none; max-height:220px; overflow:auto; min-width:0; font-size:14px; color:var(--ink); }
li { border:1px solid var(--border-strong); padding:8px; display:flex; flex-direction:column; gap:6px; min-width:0; max-width:100%; }
.filename,p { overflow-wrap:anywhere; } p { margin:0; } .actions { display:flex; flex-wrap:wrap; gap:6px; }
button { border:1px solid var(--border-strong); border-radius:0; background:var(--surface); color:var(--ink); font:inherit; padding:5px 8px; cursor:pointer; } button[aria-pressed=true] { border-color:var(--accent); } button:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
</style>
