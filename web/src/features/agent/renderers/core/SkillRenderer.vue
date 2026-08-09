<script setup lang="ts">
/**
 * SkillRenderer：skill 专用渲染器。
 *
 * UI 设计：
 * - 头部：⚡ 图标 + "激活技能" + 技能名
 * - 技能内容（可折叠，默认收起）：
 *   - 显示完整技能指令
 *   - 行数统计："N 行指令"
 */
import { computed, ref } from 'vue'
import type { RendererProps, SkillArgs } from '../types'

const props = defineProps<RendererProps>()

const showContent = ref(props.defaultExpanded ?? false)

// 解析参数
const parsedArgs = computed<SkillArgs | null>(() => {
  try {
    const raw =
      typeof props.call.args === 'string' ? props.call.args : JSON.stringify(props.call.args ?? {})
    const obj = JSON.parse(raw) as SkillArgs
    if (obj.name) return obj
    return null
  } catch (e) {
    console.warn('[SkillRenderer] args 解析失败', e)
    return null
  }
})

// 从 result 提取技能名和内容
const skillInfo = computed<{ name: string; content: string } | null>(() => {
  if (!props.call.result || typeof props.call.result !== 'string') return null
  const text = props.call.result as string

  // 匹配 "技能名" 技能已激活。以下是完整指令...\n\n内容
  const match = text.match(/"([^"]+)" 技能已激活[^\n]*\n\n([\s\S]*)$/)
  if (match && match[1] && match[2]) {
    return {
      name: match[1],
      content: match[2].trim(),
    }
  }

  // 降级：使用参数中的 name
  if (parsedArgs.value?.name) {
    return {
      name: parsedArgs.value.name,
      content: text,
    }
  }

  return null
})

// 行数统计
const lineCount = computed(() => {
  const content = skillInfo.value?.content ?? ''
  return content.split('\n').length
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
  <div class="skill-box" :class="statusClass">
    <div class="skill-head">
      <span class="skill-icon" aria-hidden="true">⚡</span>
      <span class="skill-name">激活技能</span>
      <span class="skill-type">{{ skillInfo?.name ?? parsedArgs?.name ?? 'unknown' }}</span>
      <span class="skill-status" aria-hidden="true">{{ statusGlyph }}</span>
    </div>

    <!-- 技能内容 -->
    <div v-if="skillInfo" class="skill-section">
      <button
        type="button"
        class="toggle"
        :aria-expanded="showContent"
        @click="showContent = !showContent"
      >
        <span class="caret" :class="{ open: showContent }">▸</span>
        <span class="toggle-label">
          指令
          <span class="line-count">{{ lineCount }} 行</span>
        </span>
      </button>
      <div v-if="showContent" class="content-body">
        <pre class="content-pre">{{ skillInfo?.content }}</pre>
      </div>
    </div>

    <!-- 参数解析失败降级 -->
    <pre v-else-if="fallback" class="skill-fallback">{{ fallback }}</pre>
  </div>
</template>

<style scoped lang="less">
@ink: #14161a;

.skill-box {
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

.skill-head {
  display: flex;
  align-items: center;
  gap: 6px;

  .skill-icon {
    font-size: 12px;
  }

  .skill-name {
    font-weight: 700;
    color: fade(@ink, 86%);
  }

  .skill-type {
    flex: 1;
    font-size: 9px;
    padding: 1px 4px;
    border-radius: 3px;
    background: rgba(234, 179, 8, 0.16);
    color: #ca8a04;
    font-weight: 700;
    text-align: right;
  }

  .skill-status {
    font-weight: 800;
    font-size: 12px;

    &.status-done {
      color: #16a34a;
    }
    &.status-running {
      color: #eab308;
      animation: skill-pulse 1.1s ease-in-out infinite;
    }
    &.status-error {
      color: #dc2626;
    }
  }
}

.skill-section {
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

.line-count {
  font-size: 9px;
  color: fade(@ink, 50%);
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

.skill-fallback {
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

@keyframes skill-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.4;
  }
}
</style>
