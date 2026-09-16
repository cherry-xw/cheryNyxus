<script setup lang="ts">
/**
 * WorkbenchSessionStrip：工作台标题栏会话状态条。
 * 当前预设活跃会话 icon 阵列：icon = 当前运行节点（model=✦ 思考 / tool=sense 图标）；
 * 运行中节点上层叠半透明 loading 遮罩（可见底层 icon）；hover 提示分三块（标题 / 用户最后一次消息 / 当前节点）。
 * 当前打开的会话强制置顶入列并高亮。数据来自 useTaskOverviewStore（应用级订阅生命周期由 startApplicationRuntime 管理）。
 * 纯展示 + emit，切换由父级执行（switchSession / setWorkbenchWindowChat，draft 保持契约既有）。
 */
import { computed, onMounted, ref } from 'vue'
import { useTaskOverviewStore } from '@/application/public'
import { agentApi, type SenseToolInfo } from '@/application/backend/public'
import {
  buildStripTooltip,
  currentNodeLabel,
  pickStripTasks,
  type SessionStripItem,
} from './useSessionStripTasks'

const props = withDefaults(
  defineProps<{
    windowId: string
    presetId?: string
    presetName?: string
    /** sense 图标查找（工具节点 icon 映射）；缺省时组件内部自拉 sense.tools 兜底。 */
    senseTool?: (name: string) => SenseToolInfo | undefined
    activeChatId?: string | null
  }>(),
  { presetId: undefined, presetName: undefined, senseTool: undefined, activeChatId: null },
)

const emit = defineEmits<{
  select: [chatId: string]
  /** 溢出「+N」点击：父级展开完整会话下拉。 */
  expand: []
}>()

const overview = useTaskOverviewStore()

/** sense 图标兜底：父级未注入 senseTool（如 Electron 原生标题栏）时自拉 sense.tools。 */
const localSenseTools = ref<SenseToolInfo[]>([])
onMounted(() => {
  void agentApi
    .listSenseTools()
    .then((tools) => {
      localSenseTools.value = tools
    })
    .catch(() => undefined)
})

const strip = computed(() =>
  pickStripTasks(overview.tasks, props.presetId, props.presetName, props.activeChatId ?? undefined),
)

/** 工具节点 icon：优先父级注入的 senseTool，否则本地自拉结果，未命中回退 ⚙。 */
function toolIcon(name: string | undefined): string {
  if (!name) return '⚙'
  if (props.senseTool) return props.senseTool(name)?.icon ?? '⚙'
  return localSenseTools.value.find((tool) => tool.name === name)?.icon ?? '⚙'
}

/** 当前运行节点 icon：tool=工具图标；model/缺省=思考符号 ✦。 */
function nodeIcon(item: SessionStripItem): string {
  if (item.currentStepKind === 'tool' || (item.currentStep && !item.currentStepKind)) {
    return toolIcon(item.currentStep)
  }
  return '✦'
}

function onSelect(item: SessionStripItem): void {
  emit('select', item.rootChatId)
}
</script>

<template>
  <div class="session-strip" role="group" aria-label="运行中会话">
    <template v-if="strip.items.length">
      <el-tooltip
        v-for="item in strip.items"
        :key="item.rootChatId"
        placement="bottom"
        :show-after="200"
        :hide-after="0"
        popper-class="session-strip-tip"
      >
        <template #content>
          <div class="session-strip-tip-body">
            <span class="tip-title">{{ buildStripTooltip(item).title }}</span>
            <span class="tip-divider" aria-hidden="true" />
            <span class="tip-section">
              <span class="tip-label">用户消息</span>
              <span class="tip-value">{{ buildStripTooltip(item).lastPrompt }}</span>
            </span>
            <span class="tip-section">
              <span class="tip-label">当前节点</span>
              <span class="tip-value">{{ buildStripTooltip(item).currentNode }}</span>
            </span>
          </div>
        </template>
        <button
          type="button"
          class="session-strip-icon"
          :class="{
            'is-active': item.rootChatId === activeChatId,
            'is-needs-user': item.status === 'needs_user',
          }"
          :aria-label="`切换会话：${buildStripTooltip(item).title}${item.rootChatId === activeChatId ? '（当前）' : ''}`"
          :aria-pressed="item.rootChatId === activeChatId"
          @click="onSelect(item)"
        >
          <span class="strip-node-icon" :title="currentNodeLabel(item)" aria-hidden="true">
            {{ nodeIcon(item) }}
          </span>
          <span v-if="item.status === 'running'" class="strip-loading" aria-hidden="true">
            <span class="strip-loading-spinner" />
          </span>
          <span v-if="item.status === 'needs_user'" class="strip-needs-dot" aria-hidden="true" />
          <span v-if="item.pendingCount" class="strip-pending-count" aria-hidden="true">
            {{ item.pendingCount > 9 ? '9+' : item.pendingCount }}
          </span>
          <span
            v-if="item.rootChatId === activeChatId"
            class="strip-current-bar"
            aria-hidden="true"
          />
        </button>
      </el-tooltip>
      <button
        v-if="strip.overflowCount > 0"
        type="button"
        class="session-strip-overflow"
        :aria-label="`展开全部 ${strip.overflowCount + strip.items.length} 个会话`"
        @click="emit('expand')"
      >
        +{{ strip.overflowCount }}
      </button>
    </template>
  </div>
</template>

<style scoped lang="less">
// 全直角 + token 色（--ink/--accent/--border + color-mix），浅深双端自适应；
// hover 只用 transform/opacity；loading 动画尊重 prefers-reduced-motion。
.session-strip {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 2px;
}
.session-strip-icon {
  position: relative;
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  padding: 0;
  box-sizing: border-box;
  border: 1px solid color-mix(in srgb, var(--ink) 30%, transparent);
  border-radius: 0;
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  color: var(--ink);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  overflow: hidden;
  transition:
    border-color 120ms ease,
    background 120ms ease,
    transform 120ms ease,
    opacity 120ms ease;
  &:hover {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 18%, transparent);
    transform: translateY(-1px);
  }
  &:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  &.is-active {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 24%, transparent);
  }
  &.is-needs-user {
    border-color: color-mix(in srgb, var(--accent) 70%, transparent);
    box-shadow: 0 0 6px color-mix(in srgb, var(--accent) 45%, transparent);
  }
}
.strip-node-icon {
  font-size: 15px;
  line-height: 1;
  filter: saturate(0.85);
}
// 运行中：半透明 loading 遮罩叠在节点 icon 上（能看见底层 icon），细 spinner 居中 + 呼吸。
.strip-loading {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background: color-mix(in srgb, var(--accent) 24%, transparent);
  animation: strip-loading-breathe 1.3s ease-in-out infinite;
}
.strip-loading-spinner {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 2px solid color-mix(in srgb, var(--accent) 40%, transparent);
  border-top-color: var(--accent);
  animation: strip-spin 900ms linear infinite;
}
@keyframes strip-loading-breathe {
  0%,
  100% {
    background: color-mix(in srgb, var(--accent) 22%, transparent);
  }
  50% {
    background: color-mix(in srgb, var(--accent) 38%, transparent);
  }
}
@keyframes strip-spin {
  to {
    transform: rotate(360deg);
  }
}
.strip-needs-dot {
  position: absolute;
  top: -3px;
  right: -3px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
  animation: strip-pulse 1.4s ease-in-out infinite;
}
@keyframes strip-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}
.strip-pending-count {
  position: absolute;
  bottom: -5px;
  right: -5px;
  min-width: 13px;
  height: 13px;
  padding: 0 3px;
  display: grid;
  place-items: center;
  box-sizing: border-box;
  border-radius: 0;
  background: var(--accent);
  color: #fff;
  font:
    400 9px/1 ui-monospace,
    SFMono-Regular,
    Menlo,
    Consolas,
    monospace;
}
// 当前打开会话标记：底部 accent 指示条（is-active 之外的第二重信号）。
.strip-current-bar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 3px;
  background: var(--accent);
}
.session-strip-overflow {
  height: 26px;
  padding: 0 7px;
  border: 1px dashed color-mix(in srgb, var(--ink) 40%, transparent);
  border-radius: 0;
  background: transparent;
  color: color-mix(in srgb, var(--ink) 75%, transparent);
  font:
    400 11px/1 ui-monospace,
    SFMono-Regular,
    Menlo,
    Consolas,
    monospace;
  cursor: pointer;
  &:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
}
@media (prefers-reduced-motion: reduce) {
  .strip-loading,
  .strip-loading-spinner,
  .strip-needs-dot {
    animation: none;
  }
}
</style>

<style lang="less">
// tooltip 三块分栏（标题 / 用户消息 / 当前节点），popper 挂 body，样式需全局（非 scoped）。
.session-strip-tip-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-width: 260px;
}
.session-strip-tip-body .tip-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--nx-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.session-strip-tip-body .tip-divider {
  height: 1px;
  background: color-mix(in srgb, var(--nx-text) 18%, transparent);
}
.session-strip-tip-body .tip-section {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.session-strip-tip-body .tip-label {
  font-size: 10px;
  letter-spacing: 0.08em;
  color: color-mix(in srgb, var(--nx-text) 48%, transparent);
}
.session-strip-tip-body .tip-value {
  font-size: 12px;
  line-height: 1.45;
  color: var(--nx-text);
  word-break: break-word;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
