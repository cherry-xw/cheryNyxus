<script setup lang="ts">
/**
 * MediaThumbStrip：紧凑小缩略图行（三个输入区共用：对话/精简在输入框上方、树/对话面板在输入框下方）。
 * 每个小图：
 *  - 点击 → 打开大图预览（图片走 el-image-viewer 多图列表，可切换同批次多张图；视频/音频走各自播放器）
 *  - 右侧「原图」tag（仅可压缩图片有）：点击切换 active（开启=发送基本压缩到合理范围的原图版，关闭=发送压缩版）；
 *    hover 提示原图含义 + 预计 token 消耗
 *  - 悬停显示移除按钮
 * 原图/压缩切换与 token 估算由调用方 controller 维护（removeMedia / toggleMediaVariant / onMediaSelected）。
 */
import { computed, ref } from 'vue'
import { CircleClose } from '@element-plus/icons-vue'
import type { MediaAttachment } from '../useAgentDialogOptions'
import { estimateImageTokens } from '@/utils/mediaTokens'
import {
  COMPRESS_MAX_EDGE,
  COMPRESS_QUALITY,
  ORIGINAL_MAX_EDGE,
  ORIGINAL_QUALITY,
} from '@/utils/imageCompress'
import ImagePreview from '@/components/media/ImagePreview.vue'
import AudioPlayer from '@/components/media/AudioPlayer.vue'
import VideoPlayer from '@/components/media/VideoPlayer.vue'

const props = defineProps<{ attachments: MediaAttachment[] }>()
const emit = defineEmits<{
  (e: 'remove', a: MediaAttachment): void
  (e: 'toggle', a: MediaAttachment): void
}>()

/** 同批次图片预览列表（仅 image；视频/音频走各自播放器）。 */
const imageUrls = computed(() =>
  props.attachments.filter((a) => a.kind === 'image').map((a) => a.previewUrl),
)
const previewImageIndex = ref<number | null>(null)
const previewVideo = ref<MediaAttachment | null>(null)
const previewAudio = ref<MediaAttachment | null>(null)

function openPreview(a: MediaAttachment): void {
  if (a.kind === 'image') previewImageIndex.value = imageUrls.value.indexOf(a.previewUrl)
  else if (a.kind === 'video') previewVideo.value = a
  else previewAudio.value = a
}
function closePreview(): void {
  previewImageIndex.value = null
  previewVideo.value = null
  previewAudio.value = null
}

/** 按宽高估算 token（无法测到尺寸 → 0）。 */
function estTokens(width?: number, height?: number): number {
  if (!width || !height || width <= 0 || height <= 0) return 0
  return estimateImageTokens(width, height)
}

/** 「原图」tag 的 hover 说明：原图含义 + 预计 token 消耗。 */
function origTooltip(a: MediaAttachment): string {
  const origTokens = estTokens(a.width, a.height)
  const compTokens = estTokens(a.compressed?.width, a.compressed?.height)
  return (
    `原图：已做基本压缩到合理范围（最长边≤${ORIGINAL_MAX_EDGE}px/质量${Math.round(ORIGINAL_QUALITY * 100)}%），` +
    `并非未压缩的原始大图。默认发送压缩版（最长边≤${COMPRESS_MAX_EDGE}px/质量${Math.round(COMPRESS_QUALITY * 100)}%）。` +
    `原图约 ~${origTokens.toLocaleString()} tokens · 压缩约 ~${compTokens.toLocaleString()} tokens`
  )
}
</script>

<template>
  <div
    v-if="attachments.length"
    class="media-thumb-strip"
    :aria-label="`${attachments.length} 个待发送媒体`"
  >
    <div v-for="a in attachments" :key="a.assetId" class="media-thumb-item">
      <button
        type="button"
        class="thumb-box"
        :aria-label="`预览 ${a.filename}`"
        @click="openPreview(a)"
      >
        <img v-if="a.kind === 'image'" :src="a.previewUrl" :alt="a.filename" />
        <video v-else-if="a.kind === 'video'" :src="a.previewUrl" preload="metadata" muted />
        <span v-else class="thumb-audio" aria-hidden="true">♫</span>
      </button>
      <el-tooltip
        v-if="a.kind === 'image' && a.compressed"
        :content="origTooltip(a)"
        placement="top"
        :show-after="120"
        :hide-after="0"
      >
        <button
          type="button"
          class="orig-tag"
          :class="{ 'is-active': !a.useCompressed }"
          :aria-pressed="!a.useCompressed"
          @click.stop="emit('toggle', a)"
        >
          原图
        </button>
      </el-tooltip>
      <button
        type="button"
        class="thumb-remove"
        :aria-label="`移除 ${a.filename}`"
        @click.stop="emit('remove', a)"
      >
        <el-icon :size="12"><CircleClose /></el-icon>
      </button>
    </div>
  </div>

  <ImagePreview
    v-if="previewImageIndex !== null"
    :urls="imageUrls"
    :initial-index="previewImageIndex"
    @close="closePreview"
  />
  <VideoPlayer v-if="previewVideo" :src="previewVideo.previewUrl" @close="closePreview" />
  <AudioPlayer v-if="previewAudio" :src="previewAudio.previewUrl" @close="closePreview" />
</template>

<style scoped lang="less">
@import '@/styles/scrollbar.less';

.media-thumb-strip {
  display: flex;
  align-items: center;
  gap: 6px;
  overflow-x: auto;
  max-width: 100%;
  min-width: 0;
  padding: 2px 2px;
  .inner-scrollbar();
}

.media-thumb-item {
  position: relative;
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.thumb-box {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  padding: 0;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--ink) 16%, transparent);
  border-radius: 6px;
  background: var(--surface-soft);
  cursor: pointer;

  img,
  video {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
}

.thumb-audio {
  font-size: 16px;
  color: #c58b20;
}

/* 「原图」tag：点击切换 active（active=开启原图版）。hover 走 el-tooltip 说明含义与 token。 */
.orig-tag {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 6px;
  border: 1px solid color-mix(in srgb, var(--ink) 22%, transparent);
  border-radius: 4px;
  background: transparent;
  color: color-mix(in srgb, var(--ink) 55%, transparent);
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
  font-family: inherit;
  transition:
    color 120ms ease,
    border-color 120ms ease,
    background-color 120ms ease;

  &:hover {
    border-color: color-mix(in srgb, var(--accent) 55%, transparent);
  }

  &.is-active {
    border-color: color-mix(in srgb, var(--accent) 65%, transparent);
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    color: color-mix(in srgb, var(--accent) 18%, var(--ink));
  }
}

.thumb-remove {
  position: absolute;
  top: -6px;
  right: -6px;
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: color-mix(in srgb, var(--ink) 60%, transparent);
  color: var(--ink);
  cursor: pointer;
  opacity: 0;
  transition:
    opacity 120ms ease,
    background 120ms ease;

  &:hover {
    background: color-mix(in srgb, var(--danger) 85%, transparent);
  }
}

.media-thumb-item:hover .thumb-remove {
  opacity: 1;
}
</style>
