<script setup lang="ts">
/**
 * VideoPlayer：简单视频播放器（播放/暂停 + 进度条 + 时间）。
 * 暗色 lightbox 风格，点击遮罩关闭。
 */
import { ref, onMounted, onBeforeUnmount, computed } from 'vue'

const props = defineProps<{ src: string }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const videoRef = ref<HTMLVideoElement | null>(null)
const playing = ref(false)
const currentTime = ref(0)
const duration = ref(0)

const progress = computed(() =>
  duration.value > 0 ? (currentTime.value / duration.value) * 100 : 0,
)

function fmtTime(s: number): string {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

function togglePlay(): void {
  const v = videoRef.value
  if (!v) return
  if (v.paused) void v.play()
  else v.pause()
}

function onPlay(): void {
  playing.value = true
}
function onPause(): void {
  playing.value = false
}
function onTimeUpdate(): void {
  if (videoRef.value) currentTime.value = videoRef.value.currentTime
}
function onLoadedMetadata(): void {
  if (videoRef.value) duration.value = videoRef.value.duration
}
function onEnded(): void {
  playing.value = false
}

function seek(e: MouseEvent): void {
  const target = e.currentTarget as HTMLElement
  if (!target || !videoRef.value || !duration.value) return
  const rect = target.getBoundingClientRect()
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
  videoRef.value.currentTime = ratio * duration.value
}

function onOverlayClick(e: MouseEvent): void {
  if ((e.target as HTMLElement).closest('.video-player-card')) return
  emit('close')
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close')
  else if (e.key === ' ') {
    e.preventDefault()
    togglePlay()
  }
}

onMounted(() => {
  document.addEventListener('keydown', onKeydown)
  void videoRef.value?.play()
})
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <Teleport to="body">
    <div class="video-player-overlay" @click="onOverlayClick">
      <div class="video-player-card">
        <video
          ref="videoRef"
          class="video-player-el"
          :src="props.src"
          preload="metadata"
          playsinline
          @play="onPlay"
          @pause="onPause"
          @timeupdate="onTimeUpdate"
          @loadedmetadata="onLoadedMetadata"
          @ended="onEnded"
          @click="togglePlay"
        />
        <div class="video-player-controls">
          <button
            type="button"
            class="vp-btn vp-play"
            :aria-label="playing ? '暂停' : '播放'"
            @click="togglePlay"
          >
            <svg v-if="!playing" viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
              <path d="M8 5v14l11-7z" />
            </svg>
            <svg v-else viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
              <path d="M6 4h4v16H6zm8 0h4v16h-4z" />
            </svg>
          </button>
          <span class="vp-time">{{ fmtTime(currentTime) }}</span>
          <div class="vp-progress" @click="seek">
            <div class="vp-progress-track">
              <div class="vp-progress-fill" :style="{ width: `${progress}%` }" />
            </div>
          </div>
          <span class="vp-time">{{ fmtTime(duration) }}</span>
          <button type="button" class="vp-btn vp-close" aria-label="关闭" @click="emit('close')">
            ✕
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped lang="less">
@ink: var(--ink);

.video-player-overlay {
  position: fixed;
  inset: 0;
  z-index: 2000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.78);
  backdrop-filter: blur(3px);
}

.video-player-card {
  display: flex;
  flex-direction: column;
  width: min(720px, 92vw);
  border-radius: 12px;
  overflow: hidden;
  background: var(--accent);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
}

.video-player-el {
  width: 100%;
  aspect-ratio: 16 / 9;
  background: var(--ink);
  cursor: pointer;
}

.video-player-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: rgba(20, 22, 26, 0.92);
}

.vp-btn {
  flex: none;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: rgba(255, 255, 255, 0.82);
  cursor: pointer;
  transition:
    background 120ms ease,
    color 120ms ease;

  &:hover {
    background: rgba(255, 255, 255, 0.12);
    color: var(--accent);
  }
}

.vp-play svg {
  width: 16px;
  height: 16px;
}

.vp-time {
  flex: none;
  color: rgba(255, 255, 255, 0.6);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  min-width: 34px;
  text-align: center;
}

.vp-progress {
  flex: 1;
  height: 20px;
  display: flex;
  align-items: center;
  cursor: pointer;
}

.vp-progress-track {
  width: 100%;
  height: 4px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.18);
  overflow: hidden;
}

.vp-progress-fill {
  height: 100%;
  background: var(--accent);
  transition: width 80ms linear;
}

.vp-close {
  font-size: 13px;
}
</style>
