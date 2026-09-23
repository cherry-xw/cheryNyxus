<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import { agentApi } from '@/application/backend/public'
import type { PromptSnapshotTool, SenseToolDocInfo } from '@/application/backend/public'
import { parseSenseDoc } from '@/features/agent/settings/config/shared'

const props = defineProps<{
  toolName: string
  /** 工具英文名（用于匹配 sense.tools.docs / promptSnapshot.tools 的 name 字段）。
   * 缺省回退用 toolName 匹配（部分场景只有中文名时仍尽力命中）。 */
  toolKey?: string
  chatId?: string
  /** 面板主题覆写（CSS 变量），供 CRT 终端等宿主传入与自身调色板协调的变量。 */
  theme?: Record<string, string>
}>()

const open = ref(false)
const loading = ref(false)
const error = ref<string | null>(null)
const doc = ref<SenseToolDocInfo | null>(null)
const tool = ref<PromptSnapshotTool | null>(null)

const lookupKey = computed(() => props.toolKey ?? props.toolName)

const sections = computed(() => parseSenseDoc(doc.value?.doc ?? ''))
const fields = computed(() => {
  const schema = tool.value?.parameters
  if (!schema?.properties) return []
  const required = new Set(schema.required ?? [])
  return Object.entries(schema.properties).map(([name, raw]) => {
    const value = raw as { type?: unknown; description?: unknown }
    return {
      name,
      type: Array.isArray(value.type)
        ? value.type.join(' | ')
        : typeof value.type === 'string'
          ? value.type
          : 'any',
      required: required.has(name),
      description: typeof value.description === 'string' ? value.description : '',
    }
  })
})

async function load(): Promise<void> {
  if (loading.value || doc.value || tool.value) return
  loading.value = true
  error.value = null
  try {
    const [docs, snapshot] = await Promise.all([
      agentApi.listSenseToolDocs([lookupKey.value]),
      props.chatId ? agentApi.promptSnapshot(props.chatId) : Promise.resolve(null),
    ])
    doc.value = docs.find((item) => item.name === lookupKey.value) ?? null
    tool.value = snapshot?.tools.find((item) => item.name === lookupKey.value) ?? null
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '工具说明加载失败'
  } finally {
    loading.value = false
  }
}

// ---- 浮层定位：面板 Teleport 到 body，fixed 定位在标题下方，不参与宿主布局/裁剪 ----
const triggerRef = ref<HTMLElement | null>(null)
const panelStyle = ref<Record<string, string>>({})

const PANEL_MAX_WIDTH = 460
const PANEL_GAP = 6

function updatePosition(): void {
  const el = triggerRef.value
  if (!el || !el.isConnected) {
    close()
    return
  }
  const rect = el.getBoundingClientRect()
  const viewportWidth = window.innerWidth
  const maxWidth = Math.min(PANEL_MAX_WIDTH, viewportWidth - 24)
  const minWidth = Math.min(300, maxWidth)
  let left = rect.left
  if (left + maxWidth > viewportWidth - 12) left = Math.max(12, viewportWidth - maxWidth - 12)
  panelStyle.value = {
    top: `${Math.round(rect.bottom + PANEL_GAP)}px`,
    left: `${Math.round(left)}px`,
    minWidth: `${minWidth}px`,
    maxWidth: `${maxWidth}px`,
    ...props.theme,
  }
}

function onViewportChange(): void {
  if (viewportRafId !== 0) return
  viewportRafId = requestAnimationFrame(() => {
    viewportRafId = 0
    updatePosition()
  })
}

let viewportRafId = 0

function removeListeners(): void {
  if (viewportRafId !== 0) {
    cancelAnimationFrame(viewportRafId)
    viewportRafId = 0
  }
  window.removeEventListener('scroll', onViewportChange, true)
  window.removeEventListener('resize', onViewportChange)
}

function toggle(): void {
  open.value = !open.value
  if (open.value) {
    void load()
    void nextTick(updatePosition)
    // capture 捕获阶段监听，能拿到任意滚动容器（含 VirtualScroll 视口）的滚动
    window.addEventListener('scroll', onViewportChange, true)
    window.addEventListener('resize', onViewportChange)
  } else {
    removeListeners()
  }
}

function close(): void {
  if (!open.value) return
  open.value = false
  removeListeners()
}

onBeforeUnmount(() => {
  removeListeners()
})
</script>

<template>
  <div ref="triggerRef" class="tool-description-disclosure">
    <button
      type="button"
      class="tool-description-trigger"
      :aria-expanded="open"
      :aria-label="`${open ? '收起' : '查看'}${toolName}工具说明`"
      @click="toggle"
    >
      <span class="tool-description-caret" :class="{ open }" aria-hidden="true">▸</span>
      <span class="tool-description-name">{{ toolName }}</span>
    </button>
  </div>

  <!-- Teleport 到 body：脱离 VirtualScroll transform 层叠上下文 / overflow 裁剪 / 抽屉滚动容器，
       面板不会被后续消息行遮挡或裁剪。fixed 定位基于标题位置计算，滚动时跟随。 -->
  <Teleport to="body">
    <Transition name="tool-desc">
      <section
        v-if="open"
        class="tool-description-panel"
        :style="panelStyle"
        :aria-label="`${toolName}工具说明`"
        role="region"
      >
        <p v-if="loading" class="tool-description-muted">加载工具说明…</p>
        <p v-else-if="error" class="tool-description-error" role="alert">{{ error }}</p>
        <template v-else>
          <p v-if="!sections.length && !doc?.doc" class="tool-description-muted">暂无工具说明。</p>
          <div v-for="section in sections" :key="section.label" class="tool-description-section">
            <span class="tool-description-section-label">{{ section.label }}</span>
            <p class="tool-description-section-text">{{ section.text }}</p>
          </div>
          <p v-if="doc?.doc && !sections.length" class="tool-description-text">{{ doc.doc }}</p>

          <div v-if="fields.length" class="tool-description-fields">
            <span class="tool-description-fields-title">字段说明</span>
            <div v-for="field in fields" :key="field.name" class="tool-description-field">
              <div class="tool-description-field-head">
                <code class="tool-description-field-name">{{ field.name }}</code>
                <span class="tool-description-field-type">{{ field.type }}</span>
                <em v-if="field.required" class="tool-description-field-required">必填</em>
              </div>
              <p class="tool-description-field-desc">
                {{ field.description || '暂无字段说明。' }}
              </p>
            </div>
          </div>
          <p v-if="!doc && !fields.length" class="tool-description-muted">
            当前工具没有可用的固定说明，仅显示本次调用参数。
          </p>
        </template>
      </section>
    </Transition>
  </Teleport>
</template>

<style scoped>
.tool-description-disclosure {
  min-width: 0;
}
.tool-description-trigger {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  text-align: left;
}
.tool-description-trigger > .tool-description-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tool-description-trigger:hover .tool-description-name {
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 2px;
}
.tool-description-caret {
  display: inline-block;
  flex: none;
  transition: transform 140ms ease;
}
.tool-description-caret.open {
  transform: rotate(90deg);
}

/* 说明面板：body 顶层浮层（fixed 定位，几何由脚本计算），不参与宿主标题行高度与裁剪。 */
.tool-description-panel {
  position: fixed;
  top: 0;
  left: 0;
  z-index: 9999;
  box-sizing: border-box;
  margin: 0;
  padding: 10px 12px;
  border: 1px solid var(--border, var(--el-border-color));
  border-radius: var(--radius-panel, 8px);
  background: var(--panel, var(--surface, var(--el-fill-color-blank)));
  color: var(--ink, var(--el-text-color-primary));
  box-shadow:
    0 6px 20px rgba(15, 23, 42, 0.16),
    0 1px 3px rgba(15, 23, 42, 0.08);
  font-size: 13px;
  line-height: 1.55;
  max-height: min(420px, 60vh);
  overflow-y: auto;
}

/* 分节（作用 / 能力 / 边界 / 注意）：小标签 + 正文 */
.tool-description-section {
  display: grid;
  gap: 3px;
}
.tool-description-section + .tool-description-section,
.tool-description-section + .tool-description-fields,
.tool-description-fields + .tool-description-section {
  margin-top: 9px;
  padding-top: 8px;
  border-top: 1px solid color-mix(in srgb, var(--border, var(--el-border-color)) 55%, transparent);
}
.tool-description-section-label {
  justify-self: start;
  padding: 1px 7px;
  border-radius: 4px;
  background: var(--accent-soft, var(--el-color-primary-light-9));
  color: var(--accent, var(--el-color-primary));
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  line-height: 1.5;
}
.tool-description-section-text {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
}
.tool-description-text {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
}

/* 字段说明：标题 + 逐字段列表 */
.tool-description-fields {
  display: grid;
  gap: 7px;
}
.tool-description-fields-title {
  color: color-mix(in srgb, var(--ink, var(--el-text-color-primary)) 52%, transparent);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
}
.tool-description-field {
  display: grid;
  gap: 2px;
}
.tool-description-field-head {
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.tool-description-field-name {
  color: var(--ink, var(--el-text-color-primary));
  font-family: var(--font-mono, var(--el-font-family-mono));
  font-size: 12.5px;
  overflow-wrap: anywhere;
}
.tool-description-field-type {
  color: color-mix(in srgb, var(--ink, var(--el-text-color-primary)) 52%, transparent);
  font-size: 12px;
}
.tool-description-field-required {
  margin-left: auto;
  flex: none;
  color: var(--el-color-warning, #e6a23c);
  font-size: 12px;
  font-style: normal;
}
.tool-description-field-desc {
  margin: 0;
  color: color-mix(in srgb, var(--ink, var(--el-text-color-primary)) 82%, transparent);
  white-space: pre-wrap;
  word-break: break-word;
}

.tool-description-muted,
.tool-description-error {
  margin: 0;
  color: color-mix(in srgb, var(--ink, var(--el-text-color-primary)) 52%, transparent);
}
.tool-description-error {
  color: var(--el-color-danger, #f56c6c);
}

/* 展开过渡：只做轻量淡入 + 微下移，不位移标题行 */
.tool-desc-enter-active {
  transition:
    opacity 150ms ease,
    transform 150ms ease;
}
.tool-desc-enter-from {
  opacity: 0;
  transform: translateY(-4px);
}
.tool-desc-leave-active {
  transition:
    opacity 110ms ease,
    transform 110ms ease;
}
.tool-desc-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
@media (prefers-reduced-motion: reduce) {
  .tool-desc-enter-active,
  .tool-desc-leave-active {
    transition: none;
  }
}
</style>
