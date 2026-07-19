<script setup lang="ts">
/**
 * FileReadRenderer：read_file 专用渲染器。
 *
 * UI 设计：
 * - 头部：📄 图标 + "读取文件" + 文件名
 * - 文件路径：可点击的文件路径（未来可集成 IDE 跳转）
 * - 内容预览（可折叠，默认展开前 10 行）：
 *   - 行号前缀（如 `  1 | content`）
 *   - 压缩信息（如有）：末尾显示 `[compressed: truncate]`
 * - 元信息：offset + limit（如有）
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import type { RendererProps, ReadFileArgs } from '../types'
import { CopyDocument, DocumentChecked } from '@element-plus/icons-vue'

const props = defineProps<RendererProps>()

const showContent = ref(true)

// 解析参数
const parsedArgs = computed<ReadFileArgs | null>(() => {
  try {
    const raw =
      typeof props.call.args === 'string' ? props.call.args : JSON.stringify(props.call.args ?? {})
    const obj = JSON.parse(raw) as ReadFileArgs
    if (obj.path) return obj
    return null
  } catch (e) {
    console.warn('[FileReadRenderer] args 解析失败', e)
    return null
  }
})

// 提取文件名（从路径）
const fileName = computed(() => {
  const path = parsedArgs.value?.path ?? ''
  const segments = path.split('/')
  return segments[segments.length - 1] || path
})

// 解析结果（提取压缩信息）
const compressionInfo = computed<{ strategy: string; truncated: boolean } | null>(() => {
  if (!props.call.result || typeof props.call.result !== 'string') return null
  const text = props.call.result as string

  // 匹配末尾的 [compressed: truncate] 或 [truncated: drain] 等
  const match = text.match(/\[(compressed|truncated):\s*(\w+)\]$/)
  if (match && match[2]) {
    return { strategy: match[2], truncated: true }
  }
  return null
})

// 内容（去掉压缩标记）
const content = computed(() => {
  if (!props.call.result || typeof props.call.result !== 'string') return ''
  let text = props.call.result as string

  // 移除末尾的压缩标记
  text = text.replace(/\[(compressed|truncated):\s*\w+\]$/, '').trim()

  return text
})

// 行数统计
const lineCount = computed(() => {
  return content.value.split('\n').length
})

// 复制路径到剪贴板
const copied = ref(false)
let copyTimer: ReturnType<typeof setTimeout> | undefined

async function copyPath(): Promise<void> {
  const path = parsedArgs.value?.path ?? ''
  if (!path) return
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(path)
    } else {
      const ta = document.createElement('textarea')
      ta.value = path
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    copied.value = true
    if (copyTimer) clearTimeout(copyTimer)
    copyTimer = setTimeout(() => {
      copied.value = false
    }, 1200)
  } catch (e) {
    console.warn('[FileReadRenderer] 复制失败', e)
  }
}

onBeforeUnmount(() => {
  if (copyTimer) clearTimeout(copyTimer)
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
  <div class="file-read-box" :class="statusClass">
    <div class="file-head">
      <span class="file-icon" aria-hidden="true">📄</span>
      <span class="file-name">读取文件</span>
      <span class="file-status" aria-hidden="true">{{ statusGlyph }}</span>
    </div>

    <!-- 文件路径 -->
    <div v-if="parsedArgs" class="file-section">
      <div class="file-row">
        <span class="file-label">路径:</span>
        <div class="file-path-wrap">
          <code class="file-path">{{ parsedArgs.path }}</code>
          <button
            type="button"
            class="copy-btn"
            :class="{ copied: copied }"
            :aria-label="copied ? '已复制' : '复制路径'"
            @click="copyPath"
          >
            <el-icon>
              <DocumentChecked v-if="copied" />
              <CopyDocument v-else />
            </el-icon>
          </button>
        </div>
        <div style="flex: 1" />
      </div>
      <div
        v-if="parsedArgs.offset !== undefined || parsedArgs.limit !== undefined"
        class="file-row"
      >
        <span class="file-label">范围:</span>
        <span class="file-range">
          {{ parsedArgs.offset !== undefined ? `第 ${parsedArgs.offset} 行` : '开头' }}
          {{ parsedArgs.limit !== undefined ? ` +${parsedArgs.limit} 行` : '至末尾' }}
        </span>
      </div>
    </div>

    <!-- 参数解析失败降级 -->
    <pre v-else-if="fallback" class="file-fallback">{{ fallback }}</pre>

    <!-- 内容预览 -->
    <div v-if="content" class="file-section">
      <button
        type="button"
        class="toggle"
        :aria-expanded="showContent"
        @click="showContent = !showContent"
      >
        <span class="caret" :class="{ open: showContent }">▸</span>
        <span class="toggle-label">
          内容
          <span class="line-count">{{ lineCount }} 行</span>
          <span v-if="compressionInfo" class="compression-badge">{{
            compressionInfo.strategy
          }}</span>
        </span>
      </button>
      <pre v-if="showContent" class="content-pre">{{ content }}</pre>
    </div>
  </div>
</template>

<style scoped lang="less">
@ink: #14161a;

.file-read-box {
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

.file-head {
  display: flex;
  align-items: center;
  gap: 6px;

  .file-icon {
    font-size: 12px;
  }

  .file-name {
    flex: 1;
    font-weight: 700;
    color: fade(@ink, 86%);
  }

  .file-status {
    font-weight: 800;
    font-size: 12px;

    &.status-done {
      color: #16a34a;
    }
    &.status-running {
      color: #eab308;
      animation: file-pulse 1.1s ease-in-out infinite;
    }
    &.status-error {
      color: #dc2626;
    }
  }
}

.file-section {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.file-row {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  min-width: 0;
}

.file-label {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 700;
  color: fade(@ink, 56%);
}

.file-path-wrap {
  position: relative;
  min-width: 0;
}

.file-path {
  display: block;
  padding: 2px 18px 2px 6px;
  border-radius: 4px;
  background: rgba(20, 22, 26, 0.06);
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 10.5px;
  white-space: pre-wrap;
  word-break: break-word;
  color: fade(@ink, 88%);
}

.file-range {
  flex: 1;
  min-width: 0;
  font-size: 10.5px;
  color: fade(@ink, 70%);
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
}

.copy-btn {
  position: absolute;
  top: 1px;
  right: 2px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  padding: 0;
  border: 1px solid rgba(36, 38, 45, 0.16);
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.7);
  color: fade(@ink, 60%);
  cursor: pointer;
  user-select: none;

  .el-icon {
    font-size: 10px;
  }

  &:hover {
    background: #ffffff;
    color: fade(@ink, 84%);
  }

  &.copied {
    border-color: rgba(22, 163, 74, 0.4);
    background: rgba(22, 163, 74, 0.12);
    color: #16a34a;
  }
}

.file-fallback {
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

.line-count {
  font-size: 9px;
  color: fade(@ink, 50%);
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
}

.compression-badge {
  display: inline-block;
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 9px;
  font-weight: 700;
  background: rgba(234, 179, 8, 0.16);
  color: #ca8a04;
}

.content-pre {
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
  max-height: 240px;
  overflow: auto;
}

@keyframes file-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.4;
  }
}
</style>
