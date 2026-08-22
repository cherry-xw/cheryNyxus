<script setup lang="ts">
/**
 * FileWriteRenderer：write_file 专用渲染器。
 *
 * UI 设计：
 * - 头部：✏️ 图标 + "写入文件" + 文件名
 * - 写入模式：
 *   - 完整写入：显示"创建/覆盖文件"
 *   - 部分写入：显示"修改第 N-M 行"
 * - 内容预览（可折叠，默认收起）：
 *   - 显示写入内容（截断到 20 行）
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import { CopyDocument, DocumentChecked } from '@element-plus/icons-vue'
import type { RendererProps, WriteFileArgs } from '../types'

const props = defineProps<RendererProps>()

const showContent = ref(props.defaultExpanded ?? false)
const copied = ref(false)
let copyTimer: ReturnType<typeof setTimeout> | undefined

// 解析参数
const parsedArgs = computed<WriteFileArgs | null>(() => {
  try {
    const raw =
      typeof props.call.args === 'string' ? props.call.args : JSON.stringify(props.call.args ?? {})
    const obj = JSON.parse(raw) as WriteFileArgs
    if (obj.path) return obj
    return null
  } catch (e) {
    console.warn('[FileWriteRenderer] args 解析失败', e)
    return null
  }
})

// 判断写入模式
const writeMode = computed<'full' | 'partial'>(() => {
  const { offset, limit } = parsedArgs.value ?? {}
  if (offset !== undefined && limit !== undefined) {
    return 'partial'
  }
  return 'full'
})

// 写入模式描述
const modeDescription = computed(() => {
  if (writeMode.value === 'partial') {
    const { offset, limit } = parsedArgs.value ?? {}
    return `修改第 ${offset} - ${(offset ?? 0) + (limit ?? 0)} 行`
  }
  return '创建/覆盖文件'
})

// 内容预览（截断到 20 行）
const PREVIEW_MAX_LINES = 20
const contentPreview = computed(() => {
  const content = parsedArgs.value?.content ?? ''
  const lines = content.split('\n')
  if (lines.length <= PREVIEW_MAX_LINES) {
    return { text: content, truncated: false, totalLines: lines.length }
  }
  return {
    text: lines.slice(0, PREVIEW_MAX_LINES).join('\n'),
    truncated: true,
    totalLines: lines.length,
  }
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

async function copyPath(): Promise<void> {
  const path = parsedArgs.value?.path ?? ''
  if (!path) return
  try {
    await navigator.clipboard?.writeText(path)
    copied.value = true
    if (copyTimer) clearTimeout(copyTimer)
    copyTimer = setTimeout(() => {
      copied.value = false
    }, 1200)
  } catch (error) {
    console.warn('[FileWriteRenderer] 复制路径失败', error)
  }
}

onBeforeUnmount(() => {
  if (copyTimer) clearTimeout(copyTimer)
})
</script>

<template>
  <div class="file-write-box" :class="statusClass">
    <div class="file-head">
      <span class="file-icon" aria-hidden="true">✏️</span>
      <span class="file-name">写入文件</span>
      <span class="file-status" aria-hidden="true">{{ statusGlyph }}</span>
    </div>

    <!-- 文件路径和模式 -->
    <div v-if="parsedArgs" class="file-section">
      <div class="file-row">
        <span class="file-label">路径:</span>
        <div class="file-path-wrap">
          <code class="file-path">{{ parsedArgs.path }}</code>
          <button
            type="button"
            class="copy-btn"
            :class="{ copied }"
            :aria-label="copied ? '已复制' : '复制路径'"
            @click="copyPath"
          >
            <el-icon>
              <DocumentChecked v-if="copied" />
              <CopyDocument v-else />
            </el-icon>
          </button>
        </div>
      </div>
      <div class="file-row">
        <span class="file-label">模式:</span>
        <span class="file-mode">{{ modeDescription }}</span>
      </div>
    </div>

    <!-- 参数解析失败降级 -->
    <pre v-else-if="fallback" class="file-fallback">{{ fallback }}</pre>

    <!-- 内容预览 -->
    <div v-if="parsedArgs && parsedArgs.content" class="file-section">
      <button
        type="button"
        class="toggle"
        :aria-expanded="showContent"
        @click="showContent = !showContent"
      >
        <span class="caret" :class="{ open: showContent }">▸</span>
        <span class="toggle-label">
          内容
          <span class="line-count">{{ contentPreview.totalLines }} 行</span>
        </span>
      </button>
      <div v-if="showContent" class="content-body">
        <pre class="content-pre">{{ contentPreview.text }}</pre>
        <div v-if="contentPreview.truncated" class="content-truncated">
          显示前 {{ PREVIEW_MAX_LINES }} 行 / 共 {{ contentPreview.totalLines }} 行
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="less">
@ink: var(--ink);

.file-write-box {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  font-size: 11px;
  color: color-mix(in srgb, var(--ink) 80%, transparent);
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
    font-weight: 600;
    color: color-mix(in srgb, var(--ink) 86%, transparent);
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
  line-height: 17px;
  font-size: 10px;
  font-weight: 600;
  color: color-mix(in srgb, var(--ink) 56%, transparent);
}

.file-path-wrap {
  flex: 1;
  min-width: 0;
  position: relative;
}

.file-path {
  display: block;
  padding: 2px 6px;
  padding-right: 22px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--ink) 6%, transparent);
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 10.5px;
  white-space: pre-wrap;
  word-break: break-word;
  color: color-mix(in srgb, var(--ink) 88%, transparent);
}

.copy-btn {
  position: absolute;
  top: 1px;
  right: 2px;
  display: inline-grid;
  place-items: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--surface);
  color: color-mix(in srgb, var(--ink) 60%, transparent);
  cursor: pointer;

  &.copied {
    color: #16a34a;
  }
}

.file-mode {
  flex: 1;
  min-width: 0;
  font-size: 10.5px;
  color: color-mix(in srgb, var(--ink) 70%, transparent);
}

.file-fallback {
  margin: 0;
  padding: 6px 8px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--ink) 6%, transparent);
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
  color: color-mix(in srgb, var(--ink) 64%, transparent);
  font-size: 10px;
  font-family: inherit;
  cursor: pointer;
  user-select: none;
  text-align: left;

  &:hover {
    color: color-mix(in srgb, var(--ink) 86%, transparent);
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
  color: color-mix(in srgb, var(--ink) 50%, transparent);
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
}

.content-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-left: 12px;
}

.content-pre {
  margin: 0;
  padding: 6px 8px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--ink) 6%, transparent);
  color: color-mix(in srgb, var(--ink) 86%, transparent);
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 10.5px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 240px;
  overflow: auto;
}

.content-truncated {
  font-size: 9px;
  font-style: italic;
  color: color-mix(in srgb, var(--ink) 50%, transparent);
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
