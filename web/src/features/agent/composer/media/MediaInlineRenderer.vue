<script setup lang="ts">
/**
 * MediaInlineRenderer：内联媒体预览组件。
 * 接收 MediaAssetRef[]，按 kind 渲染不同内联预览：
 * - image：缩略图，点击打开 ImagePreview
 * - video：视频卡片（封面帧 + 播放图标），点击打开 VideoPlayer
 * - audio：音频卡片（波形图标 + 文件名），点击打开 AudioPlayer
 */
import { ref, computed } from 'vue'
import type { MediaAssetRef } from '@/domain/chat/projectionTypes'
import ImagePreview from '@/components/media/ImagePreview.vue'
import VideoPlayer from '@/components/media/VideoPlayer.vue'
import AudioPlayer from '@/components/media/AudioPlayer.vue'
import { httpUrl } from '@/application/platform/public'

const props = defineProps<{
  assets: MediaAssetRef[]
}>()

// 预览状态（同一时间只打开一个）
const previewImage = ref<string | null>(null)
const previewVideo = ref<string | null>(null)
const previewAudio = ref<string | null>(null)

const mediaUrl = (filename: string) => httpUrl(`/api/media/${filename}`)

const kindLabel = (kind: MediaAssetRef['kind']) => {
  switch (kind) {
    case 'image':
      return '图片'
    case 'video':
      return '视频'
    case 'audio':
      return '音频'
    default:
      return '媒体'
  }
}

function openPreview(asset: MediaAssetRef) {
  const url = mediaUrl(asset.filename)
  if (asset.kind === 'image') {
    previewImage.value = url
  } else if (asset.kind === 'video') {
    previewVideo.value = url
  } else if (asset.kind === 'audio') {
    previewAudio.value = url
  }
}

function closePreview() {
  previewImage.value = null
  previewVideo.value = null
  previewAudio.value = null
}
</script>

<template>
  <div class="media-inline-group">
    <div
      v-for="asset in props.assets"
      :key="asset.filename"
      class="media-inline-item"
      :class="`kind-${asset.kind}`"
      @click="openPreview(asset)"
    >
      <!-- 图片：缩略图 -->
      <img
        v-if="asset.kind === 'image'"
        :src="mediaUrl(asset.filename)"
        class="thumb-image"
        :alt="asset.filename"
      />
      <!-- 视频：封面帧 + 播放图标 -->
      <div v-else-if="asset.kind === 'video'" class="thumb-video-card">
        <video :src="mediaUrl(asset.filename)" preload="metadata" muted />
        <div class="play-overlay">▶</div>
        <span class="kind-label">{{ kindLabel(asset.kind) }}</span>
      </div>
      <!-- 音频：波形图标 + 文件名 -->
      <div v-else class="thumb-audio-card">
        <span class="audio-icon">♫</span>
        <span class="audio-label">{{ kindLabel(asset.kind) }}</span>
      </div>
    </div>

    <!-- 预览组件（teleport 到 body） -->
    <ImagePreview v-if="previewImage" :src="previewImage" @close="closePreview" />
    <VideoPlayer v-if="previewVideo" :src="previewVideo" @close="closePreview" />
    <AudioPlayer v-if="previewAudio" :src="previewAudio" @close="closePreview" />
  </div>
</template>

<style scoped lang="less">
@ink: var(--ink);
@accent: var(--accent);

.media-inline-group {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}

.media-inline-item {
  cursor: pointer;
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--ink) 12%, transparent);
  transition:
    transform 120ms ease,
    box-shadow 120ms ease;

  &:hover {
    transform: translateY(-1px);
    box-shadow: 0 2px 8px color-mix(in srgb, var(--ink) 10%, transparent);
  }
}

.thumb-image {
  display: block;
  max-width: 200px;
  max-height: 150px;
  object-fit: cover;
}

.thumb-video-card {
  position: relative;
  width: 200px;
  height: 120px;
  background: var(--surface-soft);

  video {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .play-overlay {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 36px;
    height: 36px;
    border-radius: 50%;
    background: color-mix(in srgb, var(--ink) 60%, transparent);
    color: var(--ink);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    padding-left: 2px;
  }

  .kind-label {
    position: absolute;
    bottom: 4px;
    left: 4px;
    padding: 1px 6px;
    border-radius: 3px;
    background: color-mix(in srgb, var(--ink) 60%, transparent);
    color: var(--ink);
    font-size: 10px;
  }
}

.thumb-audio-card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: linear-gradient(135deg, color-mix(in srgb, var(--accent) 8%, transparent), color-mix(in srgb, var(--accent) 2%, transparent));
  min-width: 140px;

  .audio-icon {
    font-size: 20px;
    color: @accent;
  }

  .audio-label {
    font-size: 11px;
    color: color-mix(in srgb, var(--ink) 70%, transparent);
  }
}
</style>
