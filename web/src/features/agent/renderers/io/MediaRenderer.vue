<script setup lang="ts">
/**
 * MediaRenderer：generate_image/video/audio 共享渲染器。
 *
 * UI 设计：
 * - 头部：动态图标（🖼️/🎬/🎵）+ "生成媒体" + 类型标签
 * - 提示词：显示完整 prompt（可折叠）
 * - 结果预览：
 *   - 图片：<img> 标签显示缩略图
 *   - 视频：<video> 标签显示播放器
 *   - 音频：<audio> 标签显示播放器
 * - 状态：生成中显示进度动画
 */
import { computed, ref } from 'vue'
import type { RendererProps, GenerateMediaArgs, MediaKind } from '../types'
import { httpUrl } from '@/services/http'

const props = defineProps<RendererProps>()

const showPrompt = ref(false)

// 从 call.name 提取媒体类型
const mediaKind = computed<MediaKind>(() => {
  const name = props.call.name
  if (name === 'generate_image') return 'image'
  if (name === 'generate_video') return 'video'
  if (name === 'generate_audio') return 'audio'
  return 'image' // fallback
})

// 媒体类型标签
const mediaLabel = computed(() => {
  switch (mediaKind.value) {
    case 'image':
      return '图片'
    case 'video':
      return '视频'
    case 'audio':
      return '音频'
    default:
      return '媒体'
  }
})

// 媒体图标
const mediaIcon = computed(() => {
  switch (mediaKind.value) {
    case 'image':
      return '🖼️'
    case 'video':
      return '🎬'
    case 'audio':
      return '🎵'
    default:
      return '📎'
  }
})

// 解析参数
const parsedArgs = computed<GenerateMediaArgs | null>(() => {
  try {
    const raw =
      typeof props.call.args === 'string' ? props.call.args : JSON.stringify(props.call.args ?? {})
    const obj = JSON.parse(raw) as GenerateMediaArgs
    if (obj.prompt) return obj
    return null
  } catch (e) {
    console.warn('[MediaRenderer] args 解析失败', e)
    return null
  }
})

// 提取媒体 URL（从 result）
const mediaUrl = computed<string | null>(() => {
  if (!props.call.result || typeof props.call.result !== 'string') return null
  const text = props.call.result as string

  // 匹配 /api/media/xxx 格式的 URL
  const match = text.match(/\/api\/media\/[^\s"'`]+/)
  return match ? httpUrl(match[0]) : null
})

// 状态字形和样式
const statusGlyph = computed(() => {
  switch (props.call.status) {
    case 'running':
      return '⋯'
    case 'done':
      return '✓'
    case 'error':
      return '✗'
    default:
      return '?'
  }
})

const statusClass = computed(() => `status-${props.call.status}`)

// 降级显示
const fallback = computed(() => {
  if (!parsedArgs.value) {
    return JSON.stringify(props.call.args ?? {}, null, 2)
  }
  return ''
})
</script>

<template>
  <div class="media-box" :class="statusClass">
    <div class="media-head">
      <span class="media-icon" aria-hidden="true">{{ mediaIcon }}</span>
      <span class="media-name">生成{{ mediaLabel }}</span>
      <span class="media-status" aria-hidden="true">{{ statusGlyph }}</span>
    </div>

    <!-- 提示词 -->
    <div v-if="parsedArgs" class="media-section">
      <button
        type="button"
        class="toggle"
        :aria-expanded="showPrompt"
        @click="showPrompt = !showPrompt"
      >
        <span class="caret" :class="{ open: showPrompt }">▸</span>
        <span class="toggle-label">
          提示词
          <span class="prompt-preview"
            >{{ parsedArgs.prompt.slice(0, 50)
            }}{{ parsedArgs.prompt.length > 50 ? '...' : '' }}</span
          >
        </span>
      </button>
      <pre v-if="showPrompt" class="prompt-pre">{{ parsedArgs.prompt }}</pre>
    </div>

    <!-- 参数解析失败降级 -->
    <pre v-else-if="fallback" class="media-fallback">{{ fallback }}</pre>

    <!-- 媒体预览 -->
    <div v-if="mediaUrl" class="media-section">
      <div class="media-preview">
        <!-- 图片预览 -->
        <img
          v-if="mediaKind === 'image'"
          :src="mediaUrl"
          :alt="parsedArgs?.prompt ?? 'Generated image'"
          class="media-img"
        />
        <!-- 视频预览 -->
        <video v-else-if="mediaKind === 'video'" :src="mediaUrl" controls class="media-video">
          您的浏览器不支持视频播放
        </video>
        <!-- 音频预览 -->
        <audio v-else-if="mediaKind === 'audio'" :src="mediaUrl" controls class="media-audio">
          您的浏览器不支持音频播放
        </audio>
      </div>
    </div>
  </div>
</template>

<style scoped lang="less">
@ink: #14161a;

.media-box {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border: 1px solid rgba(36, 38, 45, 0.16);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.66);
  font-size: 11px;
  color: fade(@ink, 80%);
}

.media-head {
  display: flex;
  align-items: center;
  gap: 6px;

  .media-icon {
    font-size: 12px;
  }

  .media-name {
    flex: 1;
    font-weight: 700;
    color: fade(@ink, 86%);
  }

  .media-status {
    font-weight: 800;
    font-size: 12px;

    &.status-done {
      color: #16a34a;
    }
    &.status-running {
      color: #eab308;
      animation: media-pulse 1.1s ease-in-out infinite;
    }
    &.status-error {
      color: #dc2626;
    }
  }
}

.media-section {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.toggle {
  display: inline-flex;
  align-items: flex-start;
  gap: 4px;
  padding: 2px 4px;
  border: none;
  background: transparent;
  color: fade(@ink, 64%);
  font-size: 10px;
  font-family: inherit;
  cursor: pointer;
  user-select: none;
  text-align: left;

  &:hover {
    color: fade(@ink, 86%);
  }

  .toggle-label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
}

.caret {
  display: inline-block;
  transition: transform 140ms ease;

  &.open {
    transform: rotate(90deg);
  }
}

.prompt-preview {
  font-size: 9.5px;
  color: fade(@ink, 50%);
  font-style: italic;
}

.prompt-pre {
  margin: 0;
  padding: 6px 8px;
  border-radius: 4px;
  background: rgba(20, 22, 26, 0.06);
  color: fade(@ink, 86%);
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 10.5px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 120px;
  overflow: auto;
}

.media-fallback {
  margin: 0;
  padding: 6px 8px;
  border-radius: 4px;
  background: rgba(20, 22, 26, 0.06);
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 10.5px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 200px;
  overflow: auto;
}

.media-preview {
  display: flex;
  justify-content: center;
  padding: 8px 0;
}

.media-img {
  max-width: 100%;
  max-height: 240px;
  border-radius: 6px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
}

.media-video {
  max-width: 100%;
  max-height: 240px;
  border-radius: 6px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
}

.media-audio {
  width: 100%;
  max-width: 280px;
}

@keyframes media-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.4;
  }
}
</style>
