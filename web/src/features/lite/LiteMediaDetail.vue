<script setup lang="ts">
/**
 * LiteMediaDetail：generate_image / generate_video / generate_audio 专有内容区（精简模式详情抽屉工具链内）。
 * 展示 类型 → 提示词（直接全量展示） → 媒体预览（img/video/audio）。
 * 头部（工具名/简介/风险徽章）由 LiteToolCallDetail 统一提供；层级保持扁平，不套边框背景。
 * 媒体 URL 解析与树/对话视图 MediaRenderer 同源（result 文本中匹配 /api/media/… 并转 httpUrl）。
 */
import { computed } from 'vue'
import type { GraphToolCall } from '@/application/backend/public'
import { httpUrl } from '@/application/platform/public'
import { argsRecord, argString } from './builtinToolArgs'

const props = defineProps<{ call: GraphToolCall; label: string }>()

const mediaKind = computed<'image' | 'video' | 'audio'>(() => {
  if (props.call.name === 'generate_image') return 'image'
  if (props.call.name === 'generate_video') return 'video'
  if (props.call.name === 'generate_audio') return 'audio'
  return 'image'
})
const mediaLabel = computed(() =>
  mediaKind.value === 'image' ? '图片' : mediaKind.value === 'video' ? '视频' : '音频',
)

const args = computed(() => argsRecord(props.call.arguments))
const prompt = computed(() => argString(args.value, 'prompt', '描述'))
const reference = computed(() => argString(args.value, 'reference', '参考'))

const mediaUrl = computed<string | null>(() => {
  const match = (props.call.result ?? '').match(/\/api\/media\/[^\s"'`]+/)
  return match ? httpUrl(match[0]) : null
})
</script>

<template>
  <div class="lite-bt">
    <div v-if="mediaLabel" class="lite-bt-row">
      <span class="lite-bt-label">类型</span>
      <span class="lite-bt-value">{{ mediaLabel }}</span>
    </div>
    <template v-if="prompt">
      <div class="lite-bt-row">
        <span class="lite-bt-label">提示词</span>
      </div>
      <pre class="lite-bt-pre">{{ prompt }}</pre>
    </template>
    <div v-if="reference" class="lite-bt-row">
      <span class="lite-bt-label">参考</span>
      <code class="lite-bt-code">{{ reference }}</code>
    </div>
    <div v-if="mediaUrl" class="lite-bt-media">
      <img
        v-if="mediaKind === 'image'"
        :src="mediaUrl"
        :alt="prompt || '生成的图片'"
        class="lite-bt-img"
      />
      <video v-else-if="mediaKind === 'video'" :src="mediaUrl" controls class="lite-bt-video">
        您的浏览器不支持视频播放
      </video>
      <audio v-else :src="mediaUrl" controls class="lite-bt-audio">您的浏览器不支持音频播放</audio>
    </div>
  </div>
</template>

<style scoped>
/* 与其余内置工具一致的扁平字段行/代码块（层级保持扁平）。 */
.lite-bt {
  display: grid;
  gap: 6px;
  min-width: 0;
}
.lite-bt-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.lite-bt-label {
  flex: none;
  color: var(--el-text-color-secondary);
  font-size: 14px;
  line-height: 1.5;
}
.lite-bt-value {
  min-width: 0;
  color: var(--el-text-color-primary);
  font-size: 15px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}
.lite-bt-code {
  min-width: 0;
  color: var(--el-text-color-primary);
  font-family: var(--el-font-family-mono);
  font-size: 13.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
}
.lite-bt-pre {
  margin: 0;
  padding: 6px 8px;
  background: var(--el-fill-color-blank);
  font-family: var(--el-font-family-mono);
  font-size: 13.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 240px;
  overflow: auto;
  scrollbar-width: none;
}
.lite-bt-media {
  display: flex;
  justify-content: flex-start;
}
.lite-bt-img {
  max-width: 100%;
  max-height: 240px;
}
.lite-bt-video {
  max-width: 100%;
  max-height: 240px;
}
.lite-bt-audio {
  width: 100%;
  max-width: 280px;
}
</style>
