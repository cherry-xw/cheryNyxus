<script setup lang="ts">
/**
 * AudioPlayer：音频波形播放器。
 * Web Audio API 解码波形 → Canvas 绘制 → 点击定位播放。
 */
import { ref, onMounted, onBeforeUnmount, computed, watch } from 'vue'

const props = defineProps<{ src: string }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const canvasRef = ref<HTMLCanvasElement | null>(null)
const audioRef = ref<HTMLAudioElement | null>(null)
const playing = ref(false)
const currentTime = ref(0)
const duration = ref(0)
const peaks = ref<number[]>([])
const loading = ref(true)

const progress = computed(() =>
  duration.value > 0 ? (currentTime.value / duration.value) * 100 : 0,
)

function fmtTime(s: number): string {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

/**
 * 解码音频并提取波形峰值。
 * 将多声道混合，降采样到目标点数（≈canvas 像素宽度）。
 */
async function decodePeaks(url: string, targetPoints = 300): Promise<number[]> {
  const resp = await fetch(url)
  const arrayBuf = await resp.arrayBuffer()
  const ctx = new (window.AudioContext || (window as any).webkitAudioContext)()
  const audioBuf = await ctx.decodeAudioData(arrayBuf)
  duration.value = audioBuf.duration
  const channelData = audioBuf.getChannelData(0)
  const blockSize = Math.max(1, Math.floor(channelData.length / targetPoints))
  const result: number[] = []
  for (let i = 0; i < channelData.length; i += blockSize) {
    let max = 0
    const end = Math.min(i + blockSize, channelData.length)
    for (let j = i; j < end; j++) {
      const abs = Math.abs(channelData[j]!)
      if (abs > max) max = abs
    }
    result.push(max)
  }
  // 归一化到 0-1
  const peak = Math.max(...result, 0.01)
  await ctx.close()
  return result.map((v) => v / peak)
}

function drawWaveform(): void {
  const canvas = canvasRef.value
  if (!canvas || peaks.value.length === 0) return
  const dpr = window.devicePixelRatio || 1
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  canvas.width = w * dpr
  canvas.height = h * dpr
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.scale(dpr, dpr)
  ctx.clearRect(0, 0, w, h)

  const barCount = Math.min(peaks.value.length, Math.floor(w / 3))
  const step = peaks.value.length / barCount
  const barWidth = Math.max(1.5, (w / barCount) * 0.6)
  const gap = w / barCount - barWidth
  const playedRatio = duration.value > 0 ? currentTime.value / duration.value : 0
  const playedX = playedRatio * w

  for (let i = 0; i < barCount; i++) {
    const peakVal = peaks.value[Math.floor(i * step)] ?? 0
    const barH = Math.max(2, peakVal * (h - 4))
    const x = i * (barWidth + gap) + gap / 2
    const y = (h - barH) / 2
    ctx.fillStyle = x < playedX ? '#f6b73c' : '&'
    ctx.beginPath()
    ctx.roundRect(x, y, barWidth, barH, 1)
    ctx.fill()
  }
}

async function onCanvasClick(e: MouseEvent): Promise<void> {
  const canvas = canvasRef.value
  const audio = audioRef.value
  if (!canvas || !audio || !duration.value) return
  const rect = canvas.getBoundingClientRect()
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
  audio.currentTime = ratio * duration.value
  currentTime.value = audio.currentTime
  drawWaveform()
}

function togglePlay(): void {
  const audio = audioRef.value
  if (!audio) return
  if (audio.paused) void audio.play()
  else audio.pause()
}

function onPlay(): void {
  playing.value = true
}
function onPause(): void {
  playing.value = false
}
function onTimeUpdate(): void {
  if (audioRef.value) {
    currentTime.value = audioRef.value.currentTime
    drawWaveform()
  }
}
function onLoadedMetadata(): void {
  if (audioRef.value) duration.value = audioRef.value.duration
}
function onEnded(): void {
  playing.value = false
}

function onOverlayClick(e: MouseEvent): void {
  if ((e.target as HTMLElement).closest('.audio-player-card')) return
  emit('close')
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close')
  else if (e.key === ' ') {
    e.preventDefault()
    togglePlay()
  }
}

onMounted(async () => {
  document.addEventListener('keydown', onKeydown)
  try {
    peaks.value = await decodePeaks(props.src)
  } catch (e) {
    console.error('[AudioPlayer] 波形解码失败:', e)
  } finally {
    loading.value = false
    drawWaveform()
  }
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown)
})

watch(
  () => props.src,
  async () => {
    loading.value = true
    try {
      peaks.value = await decodePeaks(props.src)
    } finally {
      loading.value = false
      drawWaveform()
    }
  },
)
</script>

<template>
  <Teleport to="body">
    <div class="audio-player-overlay" @click="onOverlayClick">
      <div class="audio-player-card">
        <audio
          ref="audioRef"
          :src="props.src"
          preload="auto"
          @play="onPlay"
          @pause="onPause"
          @timeupdate="onTimeUpdate"
          @loadedmetadata="onLoadedMetadata"
          @ended="onEnded"
        />
        <div class="ap-head">
          <span class="ap-icon">♫</span>
          <span class="ap-title">音频播放</span>
        </div>
        <div class="ap-waveform-wrap" :class="{ 'is-loading': loading }">
          <canvas ref="canvasRef" class="ap-waveform" @click="onCanvasClick" />
          <div v-if="loading" class="ap-loading">解码波形中…</div>
        </div>
        <div class="ap-controls">
          <button
            type="button"
            class="ap-btn ap-play"
            :aria-label="playing ? '暂停' : '播放'"
            @click="togglePlay"
          >
            <svg v-if="!playing" viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
              <path d="M8 5v14l11-7z" />
            </svg>
            <svg v-else viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
              <path d="M6 4h4v16H6zm8 0h4v16h-4z" />
            </svg>
          </button>
          <span class="ap-time">{{ fmtTime(currentTime) }}</span>
          <div class="ap-progress-track">
            <div class="ap-progress-fill" :style="{ width: `${progress}%` }" />
          </div>
          <span class="ap-time">{{ fmtTime(duration) }}</span>
          <button type="button" class="ap-btn ap-close" aria-label="关闭" @click="emit('close')">
            ✕
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped lang="less">
.audio-player-overlay {
  position: fixed;
  inset: 0;
  z-index: 2000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(3px);
}

.audio-player-card {
  width: min(480px, 90vw);
  padding: 16px 18px 14px;
  border-radius: 14px;
  background: #1e2028;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.ap-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ap-icon {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  background: rgba(246, 183, 60, 0.16);
  color: #f6b73c;
  font-size: 15px;
}

.ap-title {
  color: rgba(255, 255, 255, 0.82);
  font-size: 13px;
  font-weight: 600;
}

.ap-waveform-wrap {
  position: relative;
  height: 90px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.04);
  overflow: hidden;
}

.ap-waveform {
  width: 100%;
  height: 100%;
  cursor: pointer;
  display: block;
}

.ap-loading {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: rgba(255, 255, 255, 0.5);
  font-size: 12px;
  background: rgba(30, 32, 40, 0.8);
}

.ap-controls {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ap-btn {
  flex: none;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: rgba(255, 255, 255, 0.82);
  cursor: pointer;
  transition:
    background 120ms ease,
    color 120ms ease;

  &:hover {
    background: rgba(255, 255, 255, 0.1);
    color: #f6b73c;
  }
}

.ap-play {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: #f6b73c;
  color: #1e2028;

  &:hover {
    background: #f7c155;
    color: #1e2028;
  }
}

.ap-time {
  flex: none;
  color: rgba(255, 255, 255, 0.5);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  min-width: 34px;
  text-align: center;
}

.ap-progress-track {
  flex: 1;
  height: 4px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.14);
  overflow: hidden;
}

.ap-progress-fill {
  height: 100%;
  background: #f6b73c;
  border-radius: 2px;
  transition: width 80ms linear;
}

.ap-close {
  font-size: 14px;
}
</style>
