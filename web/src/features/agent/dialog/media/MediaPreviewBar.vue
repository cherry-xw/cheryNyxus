<script setup lang="ts">
/**
 * MediaPreviewBar：输入框上方已选媒体缩略图条。
 * 点击缩略图触发对应预览组件，hover 显示移除按钮。
 */
import { ref } from 'vue'
import { CircleClose } from '@element-plus/icons-vue'
import type { MediaAttachment } from '../useAgentDialogOptions'
import ImagePreview from './ImagePreview.vue'
import AudioPlayer from './AudioPlayer.vue'
import VideoPlayer from './VideoPlayer.vue'

defineProps<{ attachments: MediaAttachment[] }>()
const emit = defineEmits<{ (e: 'remove', a: MediaAttachment): void }>()

const previewImage = ref<MediaAttachment | null>(null)
const previewAudio = ref<MediaAttachment | null>(null)
const previewVideo = ref<MediaAttachment | null>(null)

function openPreview(a: MediaAttachment): void {
  if (a.kind === 'image') previewImage.value = a
  else if (a.kind === 'video') previewVideo.value = a
  else previewAudio.value = a
}

function closePreview(): void {
  previewImage.value = null
  previewAudio.value = null
  previewVideo.value = null
}

function kindLabel(kind: string): string {
  return kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频'
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
</script>

<template>
  <div v-if="attachments.length" class="media-preview-bar">
    <div class="media-preview-strip">
      <div
        v-for="a in attachments"
        :key="a.assetId"
        class="media-preview-thumb"
        :title="`${a.filename} · 点击查看`"
        @click="openPreview(a)"
      >
        <div class="thumb-visual">
          <img v-if="a.kind === 'image'" :src="a.previewUrl" :alt="a.filename" />
          <video v-else-if="a.kind === 'video'" :src="a.previewUrl" preload="metadata" muted />
          <div v-else class="thumb-audio-icon">♫</div>
          <span class="thumb-kind">{{ kindLabel(a.kind) }}</span>
        </div>
        <div class="thumb-meta">
          <span class="thumb-name" :title="a.filename">{{ a.filename }}</span>
          <span class="thumb-size">{{ formatSize(a.size) }}</span>
        </div>
        <button
          type="button"
          class="thumb-remove"
          aria-label="移除"
          @click.stop="emit('remove', a)"
        >
          <el-icon :size="12"><CircleClose /></el-icon>
        </button>
      </div>
    </div>
  </div>

  <ImagePreview v-if="previewImage" :src="previewImage.previewUrl" @close="closePreview" />
  <AudioPlayer v-if="previewAudio" :src="previewAudio.previewUrl" @close="closePreview" />
  <VideoPlayer v-if="previewVideo" :src="previewVideo.previewUrl" @close="closePreview" />
</template>

<style scoped lang="less">
@ink: #14161a;

.media-preview-bar {
  padding: 6px 2px 0;
}

.media-preview-strip {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  padding: 2px 2px 4px;
  scrollbar-width: thin;
  scrollbar-color: rgba(20, 22, 26, 0.18) transparent;

  &::-webkit-scrollbar {
    height: 4px;
  }
  &::-webkit-scrollbar-thumb {
    background: rgba(20, 22, 26, 0.18);
    border-radius: 2px;
  }
}

.media-preview-thumb {
  position: relative;
  flex: none;
  width: 156px;
  display: grid;
  grid-template-rows: 72px auto;
  border: 1px solid rgba(36, 38, 45, 0.12);
  border-radius: 8px;
  background: #fff;
  cursor: pointer;
  overflow: hidden;
  transition:
    border-color 120ms ease,
    box-shadow 120ms ease;

  &:hover {
    border-color: rgba(190, 132, 28, 0.4);
    box-shadow: 0 2px 8px rgba(20, 22, 26, 0.08);

    .thumb-remove {
      opacity: 1;
    }
  }
}

.thumb-visual {
  position: relative;
  width: 100%;
  height: 72px;
  background: #f4f0e8;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;

  img,
  video {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
}

.thumb-audio-icon {
  font-size: 22px;
  color: #c58b20;
  opacity: 0.7;
}

.thumb-kind {
  position: absolute;
  left: 4px;
  bottom: 4px;
  padding: 1px 5px;
  border-radius: 4px;
  background: rgba(20, 22, 26, 0.65);
  color: #fff;
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.thumb-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  padding: 4px 6px;
  min-width: 0;
}

.thumb-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
  color: fade(@ink, 72%);
}

.thumb-size {
  flex: none;
  font-size: 9px;
  color: fade(@ink, 44%);
}

.thumb-remove {
  position: absolute;
  top: 3px;
  right: 3px;
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 50%;
  background: rgba(20, 22, 26, 0.6);
  color: #fff;
  cursor: pointer;
  opacity: 0;
  transition:
    opacity 120ms ease,
    background 120ms ease;

  &:hover {
    background: rgba(220, 38, 38, 0.85);
  }
}
</style>
