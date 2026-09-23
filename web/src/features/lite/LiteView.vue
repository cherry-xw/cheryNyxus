<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Plus, Top } from '@element-plus/icons-vue'
import { ElPopover, ElTooltip, ElUpload } from 'element-plus'
import type { UploadFile } from 'element-plus'
import { MorphIcon } from 'morphicons/vue'
import { useMotionTier } from '@/composables/useMotionTier'
import { THINKING_ICONS, toolCallIcon } from './clusterIcons'
import { classifyToolType, toolTypeGlyph } from './executionMonitor'
import { useLiteViewController, type LiteViewControllerProps } from './useLiteViewController'
import { useInstructionSuggestions } from '../agent/composer/useInstructionSuggestions'
import InstructionSuggestions from '../agent/composer/InstructionSuggestions.vue'
import MediaThumbStrip from '../agent/composer/media/MediaThumbStrip.vue'
import { splitCommandPrompt } from '../agent/composables/commands'
const props = defineProps<LiteViewControllerProps>()
const controller = useLiteViewController(props)
const {
  DetailDrawer,
  LiteMarkdown,
  LiteScrollbar,
  aborting,
  activeLane,
  autoGrowInput,
  closeDetail,
  connectionBlocked,
  detailNode,
  detailNodeIndex,
  entryDispatch,
  entryExpanded,
  entryHasMore,
  entryPreview,
  errorBanner,
  focusNodeFromTrajectory,
  focusNodeId,
  formatElapsed,
  hideBarTip,
  history,
  hoverCall,
  hoverNode,
  hydrationLabel,
  inputText,
  inputLines,
  isDetailNode,
  isPlainRowContent,
  isRowFocused,
  isThinkingOpen,
  laneTabs,
  lite,
  liteInputEl,
  liteStatus,
  monitor,
  monitorEl,
  moveBarTip,
  mediaAttachments,
  mediaDisabledReason,
  mediaHint,
  mediaServicesByType,
  nodeKindLabel,
  nodeTipText,
  nodeToneVars,
  onErrorAction,
  onInputKeydown,
  onMonitorScroll,
  onMediaSelected,
  onResume,
  onSend,
  onStop,
  onTrajectoryKeydown,
  onTrajectoryWheel,
  openNodeDetail,
  openToolCallDetail,
  operationBlockReason,
  resetTrajectoryZoom,
  removeMedia,
  resuming,
  rootUi,
  rowKey,
  runDetailOpen,
  runDetailText,
  runStatusLabel,
  sending,
  setRowEl,
  showBarTip,
  showThinkingMark,
  showsRowContent,
  tipAction,
  tipPos,
  toolCallStatus,
  toolCallTipText,
  toggleMediaVariant,
  toggleThinking,
  toggleRunDetail,
  toolTypeLabel,
  trajectoryBarStyle,
  trajectoryLayout,
  trajectoryZoom,
  uploading,
  userSegments,
  visibleRows,
} = controller

const mediaKinds = [
  { kind: 'image', label: '图片' },
  { kind: 'video', label: '视频' },
  { kind: 'audio', label: '音频' },
] as const

const menu = useInstructionSuggestions({
  chatId: () => props.rootChatId,
  preset: () => props.presetName,
  text: () => inputText.value,
  input: liteInputEl,
  update: (value) => {
    inputText.value = value
  },
  resize: autoGrowInput,
})
function onLiteInput(): void {
  void nextTick(menu.refresh)
  autoGrowInput()
}
function onLiteKeydown(event: KeyboardEvent): void {
  if (!menu.keydown(event)) onInputKeydown(event)
}

// ── cluster 小按钮可变形图标（morphicons）：状态变化时弹簧变形为状态图标（终态），
// 平时静止；动效档位约定与 WorkflowMorphIcon 一致——精简动效/关闭装饰档下不做变形动画。 ──
const { spec } = useMotionTier()
const clusterMorphReducedMotion = computed(() =>
  spec.value.mode === 'full' && spec.value.decoration !== 'off' ? 'user' : 'always',
)

// ── 思考标记动态图标：运行中的模型响应在 brain / brain-cog 间切换（MorphIcon 变形过渡），
// 并配合主题色呼吸（CSS）；完成/失败后静止在 idle 图标。多个思考节点共享一个切换 tick。 ──
const hasActiveThinking = computed(() =>
  visibleRows.value.some((row) =>
    (row.nodes ?? []).some((node) => node.active && showThinkingMark(node)),
  ),
)
const thinkingFlip = ref(false)
let thinkingTimer: ReturnType<typeof setInterval> | undefined
watch(hasActiveThinking, (on) => {
  if (on) {
    thinkingTimer = setInterval(() => {
      thinkingFlip.value = !thinkingFlip.value
    }, 1600)
  } else if (thinkingTimer) {
    clearInterval(thinkingTimer)
    thinkingTimer = undefined
    thinkingFlip.value = false
  }
})
onBeforeUnmount(() => {
  if (thinkingTimer) clearInterval(thinkingTimer)
})
defineExpose({
  insertReference(token: string) {
    inputText.value += (inputText.value ? ' ' : '') + token + ' '
    void nextTick(() => {
      autoGrowInput()
      liteInputEl.value?.focus()
    })
  },
})

// ── 输入框展开态（精简模式同款交互，与对话模式一致）：默认保持 6 行上限，
// 展开后最高到窗口一半（由 CSS .lite-input.is-expanded 承接）。 ──
const expandedInput = ref(false)
function toggleExpandInput(): void {
  expandedInput.value = !expandedInput.value
  // 类切换后重算高度：展开时立即给足可视高度，收起时回到内容高度（CSS 上限兜底）。
  void nextTick(() => autoGrowInput())
}
// 展开按钮仅在输入超过 2 行时出现（controller 测量 inputLines）；内容回落 2 行以内时
// 收起展开态（按钮随之隐藏，避免「已展开却无法收起」）。
watch(inputLines, (lines) => {
  if (lines <= 2) expandedInput.value = false
})
// 挂载时按既有草稿重算高度/行数（恢复的长草稿直接撑高 + 展开按钮立即可见）；
// 容器宽度变化导致自动换行改变时重算，避免行数/高度停留在旧宽度。
let inputResizeObserver: ResizeObserver | null = null
let lastInputWidth = 0
onMounted(() => {
  void nextTick(() => autoGrowInput())
  const el = liteInputEl.value
  if (el) {
    lastInputWidth = el.clientWidth
    inputResizeObserver = new ResizeObserver(() => {
      const width = el.clientWidth
      if (width !== lastInputWidth) {
        lastInputWidth = width
        autoGrowInput()
      }
    })
    inputResizeObserver.observe(el)
  }
})
onBeforeUnmount(() => inputResizeObserver?.disconnect())
</script>

<template>
  <div class="lite-view" :data-window="props.windowId" :style="nodeToneVars">
    <header class="lite-statusbar">
      <span class="lite-status-dot" :data-tone="liteStatus.tone" aria-hidden="true" />
      <span class="lite-status-text">LITE // {{ liteStatus.text }}</span>
      <span v-if="hydrationLabel" class="lite-hydration">{{ hydrationLabel }}</span>
      <span class="lite-node-count"
        >NODE {{ history.nodes.length.toString().padStart(3, '0') }}</span
      >
      <!-- v0.5.3 链路标签栏迁入状态条：顶层直接展示多个 Agent（主 Agent ✧ + 各子 Agent ◆ 角色名），
            点击切换 activeLane，与轨迹行头角色名按钮联动 -->
      <nav v-if="laneTabs.length > 1" class="lite-lane-bar" aria-label="切换链路">
        <el-tooltip
          v-for="tab in laneTabs"
          :key="tab.chatId"
          :content="'切换到 ' + tab.label + ' 链路'"
          placement="top"
          :show-after="150"
          :hide-after="0"
        >
          <button
            type="button"
            class="lite-lane-tab"
            :class="[
              { 'is-active': tab.chatId === activeLane },
              { 'is-root-lane': tab.isRootLane },
            ]"
            @click="activeLane = tab.chatId"
          >
            <span class="lite-lane-tab-icon" aria-hidden="true">{{
              tab.isRootLane ? '✧' : '◆'
            }}</span>
            <span class="lite-lane-tab-label">{{ tab.label }}</span>
          </button>
        </el-tooltip>
      </nav>
      <span class="lite-session">{{ props.presetName || '会话' }}</span>
      <time class="lite-total" aria-label="总耗时"
        >总耗时 {{ formatElapsed(monitor.elapsedMs) }}</time
      >
      <div class="lite-run-controls">
        <button
          v-if="lite.runningState"
          type="button"
          class="lite-inline-action"
          :disabled="aborting || connectionBlocked"
          @click="onStop"
        >
          {{ aborting ? '停止中…' : '停止' }}
        </button>
        <button
          v-else-if="lite.canResume"
          type="button"
          class="lite-inline-action"
          :disabled="resuming || connectionBlocked"
          @click="onResume"
        >
          {{ resuming ? '继续中…' : '继续' }}
        </button>
      </div>
    </header>

    <div class="lite-body">
      <section
        v-if="history.nodes.length"
        class="lite-trajectory"
        aria-label="运行轨迹时间线"
        @wheel.capture="onTrajectoryWheel"
        @keydown="onTrajectoryKeydown"
      >
        <span v-if="trajectoryZoom !== 1" class="lite-trajectory-head">
          <el-tooltip
            content="重置缩放（Ctrl/⌘ + 滚轮缩放）"
            placement="top"
            :show-after="150"
            :hide-after="0"
          >
            <button type="button" class="lite-trajectory-zoom" @click="resetTrajectoryZoom">
              {{ Math.round(trajectoryZoom * 100) }}%
            </button>
          </el-tooltip>
        </span>
        <LiteScrollbar axis="x">
          <template #default="{ width }">
            <!-- 单元素 v-for 缓存 layout，避免重复计算轨迹布局 -->
            <template
              v-for="(layout, index) in [trajectoryLayout(width, trajectoryZoom)]"
              :key="index"
            >
              <div class="lite-trajectory-track" :style="{ width: layout.trackWidth + 'px' }">
                <div
                  v-for="track in layout.tracks"
                  :key="track.chatId"
                  class="lite-trajectory-lane"
                  :class="{
                    'is-root-lane': track.isRootLane,
                    'is-active': track.chatId === activeLane,
                  }"
                >
                  <el-tooltip
                    :content="'切换到 ' + track.label + ' 链路'"
                    placement="top"
                    :show-after="150"
                    :hide-after="0"
                  >
                    <button
                      type="button"
                      class="lite-trajectory-lane-label"
                      @click="activeLane = track.chatId"
                    >
                      {{ track.label }}
                    </button>
                  </el-tooltip>
                  <div class="lite-trajectory-lane-track">
                    <button
                      v-for="bar in track.bars"
                      :key="bar.node.key"
                      type="button"
                      class="lite-trajectory-bar"
                      :class="[
                        'is-' + bar.node.kind,
                        bar.node.kind === 'tool'
                          ? 'is-tooltype-' + (bar.node.toolType ?? 'other')
                          : '',
                        {
                          'is-running': bar.node.active,
                          'is-selected': isDetailNode(bar.node),
                          'is-focused': bar.node.nodeId === focusNodeId,
                        },
                      ]"
                      :data-kind="bar.node.kind"
                      :data-tooltype="bar.node.toolType"
                      :data-node-id="bar.node.nodeId"
                      :style="trajectoryBarStyle(bar)"
                      :aria-label="nodeTipText(bar.node) + '，点击定位下方内容'"
                      @pointerenter="showBarTip(bar.node, $event)"
                      @pointermove="moveBarTip"
                      @pointerleave="hideBarTip"
                      @click="focusNodeFromTrajectory(bar.node)"
                    />
                  </div>
                </div>
              </div>
            </template>
          </template>
        </LiteScrollbar>
      </section>

      <main ref="monitorEl" class="lite-monitor" aria-label="执行监控" @scroll="onMonitorScroll">
        <div v-if="entryDispatch" class="lite-entry-dispatch">
          <div class="lite-entry-dispatch-head">
            <span class="lite-entry-dispatch-icon" aria-hidden="true">{{
              entryDispatch.icon
            }}</span>
            <span class="lite-entry-dispatch-actor">{{ entryDispatch.agentLabel }}</span>
            <span class="lite-entry-dispatch-verb">任务委派</span>
            <button
              v-if="entryHasMore"
              type="button"
              class="lite-entry-dispatch-toggle"
              @click="entryExpanded = !entryExpanded"
            >
              {{ entryExpanded ? '收起' : '展开全文' }}
            </button>
          </div>
          <div class="lite-entry-dispatch-content">
            <LiteMarkdown :text="entryPreview" />
          </div>
        </div>
        <ol v-if="visibleRows.length" class="lite-history">
          <li
            v-for="row in visibleRows"
            :key="rowKey(row)"
            :ref="(el) => setRowEl(rowKey(row), el)"
            class="lite-history-row"
            :class="[
              row.kind === 'cluster'
                ? ['is-cluster']
                : [`is-${row.node?.kind}`, { 'is-round-start': row.node?.kind === 'user' }],
              { 'is-focused': isRowFocused(row) },
            ]"
          >
            <template v-if="row.kind === 'full' && row.node">
              <div class="lite-history-summary">
                <span class="lite-history-icon" aria-hidden="true">{{ row.node.icon }}</span>
                <div class="lite-history-meta">
                  <strong>{{ row.node.label }}</strong>
                  <span class="lite-history-status">{{ runStatusLabel(row.node.status) }}</span>
                  <time v-if="row.node.elapsedMs > 0">{{ formatElapsed(row.node.elapsedMs) }}</time>
                </div>
              </div>
              <!-- v2.8 行内「思考」：正文全文已直接在页面滚动展示，思考默认折叠在此补充；
                   详情按钮随之移除（工具调用细节仍可从 cluster 小按钮 / 轨迹块进入）。 -->
              <div v-if="row.node.thinking" class="lite-history-thinking">
                <button
                  type="button"
                  class="lite-thinking-toggle"
                  :aria-expanded="isThinkingOpen(row.node)"
                  @click="toggleThinking(row.node)"
                >
                  <span
                    class="lite-thinking-caret"
                    :class="{ open: isThinkingOpen(row.node) }"
                    aria-hidden="true"
                    >▸</span
                  >
                  <span>思考</span>
                </button>
                <div v-if="isThinkingOpen(row.node)" class="lite-thinking-content">
                  <LiteMarkdown :text="row.node.thinking" />
                </div>
              </div>
              <div
                v-if="showsRowContent(row.node)"
                class="lite-history-content"
                :class="{ 'is-plain': isPlainRowContent(row.node) }"
              >
                <!-- 用户指令性消息：[[command:…]] / [[role:@…]] token 样式化（与对话模式 MessageBubble 同源） -->
                <template v-if="isPlainRowContent(row.node)">
                  <template v-for="(segment, index) in userSegments(row.node)" :key="index">
                    <span v-if="segment.type === 'command'" class="lite-instruction-token">{{
                      segment.value
                    }}</span>
                    <span
                      v-else-if="segment.type === 'role'"
                      class="lite-instruction-token is-role"
                      >{{ segment.value }}</span
                    >
                    <el-tooltip
                      v-else-if="segment.type === 'file'"
                      content="工作区文件引用，仅传递路径，由 Agent 按需读取"
                      ><span class="lite-instruction-token"
                        >&amp;{{ segment.value }}</span
                      ></el-tooltip
                    >
                    <template v-else>{{ segment.value }}</template>
                  </template>
                </template>
                <LiteMarkdown v-else :text="row.node.content || '（空）'" />
              </div>
            </template>
            <div v-else class="lite-cluster" role="group" aria-label="本轮中间节点">
              <template v-for="node in row.nodes" :key="node.key">
                <div
                  class="lite-cluster-unit"
                  :class="{
                    'is-selected': isDetailNode(node),
                    'is-focused': node.nodeId === focusNodeId,
                  }"
                >
                  <!-- 思考/正文标记：主·子 Agent 响应或工具节点合并的思考/正文。
                       运行中 brain ↔ brain-cog 切换（MorphIcon 变形）+ 主题色呼吸（CSS）；完成静止。 -->
                  <button
                    v-if="showThinkingMark(node)"
                    type="button"
                    class="lite-thinking-mark"
                    :class="{ 'is-active': node.active }"
                    :aria-label="nodeTipText(node)"
                    @pointerenter="showBarTip(node, $event)"
                    @pointermove="moveBarTip"
                    @pointerleave="hideBarTip"
                    @click="openNodeDetail(node, $event)"
                  >
                    <MorphIcon
                      class="lite-thinking-icon"
                      :icon="
                        node.active && thinkingFlip ? THINKING_ICONS.active : THINKING_ICONS.idle
                      "
                      :size="14"
                      :stroke-width="2"
                      :reduced-motion="clusterMorphReducedMotion"
                      spring="snappy"
                      aria-hidden="true"
                    />
                  </button>
                  <!-- 工具 icon 组：同一次 LLM 响应的逐个工具调用（无边框并排，每工具底部一条状态线） -->
                  <template v-if="node.kind === 'tool' && node.toolCalls?.length">
                    <button
                      v-for="call in node.toolCalls"
                      :key="call.callId"
                      type="button"
                      class="lite-tool-call"
                      :class="{
                        'is-selected':
                          isDetailNode(node) && rootUi.detailFocusToolCallId === call.callId,
                      }"
                      :data-tooltype="classifyToolType(call.name)"
                      :data-status="toolCallStatus(call.status)"
                      :aria-label="toolCallTipText(node, call)"
                      @pointerenter="showBarTip(node, $event, call)"
                      @pointermove="moveBarTip"
                      @pointerleave="hideBarTip"
                      @click="openToolCallDetail(node, call, $event)"
                    >
                      <MorphIcon
                        class="lite-tool-call-icon"
                        :icon="toolCallIcon(call.name)"
                        :size="10"
                        :stroke-width="2"
                        :reduced-motion="clusterMorphReducedMotion"
                        spring="snappy"
                        aria-hidden="true"
                      />
                      <span
                        class="lite-tool-call-status"
                        :data-status="toolCallStatus(call.status)"
                        aria-hidden="true"
                      />
                    </button>
                  </template>
                </div>
              </template>
            </div>
          </li>
        </ol>
        <p v-else class="lite-empty">{{ monitor.question ? '暂无执行节点' : '等待输入问题' }}</p>
      </main>

      <div
        v-if="lite.outgoingMessages.some((message) => message?.delivery?.status === 'failed')"
        class="lite-failed-inputs"
      >
        <div
          v-for="message in lite.outgoingMessages.filter(
            (item) => item?.delivery?.status === 'failed',
          )"
          :key="message.msgId"
          class="lite-failed-input"
        >
          <span>{{ message.delivery?.error?.message ?? '发送失败' }}</span>
          <button type="button" @click="lite.retryInput(message.msgId)">重试</button>
          <button type="button" @click="lite.removeFailedInput(message.msgId)">移除</button>
        </div>
      </div>

      <div v-if="errorBanner" class="lite-error-banner" role="alert">
        <span>{{ errorBanner.text }}</span>
        <button
          v-if="errorBanner.action === 'refresh'"
          type="button"
          class="lite-error-action"
          @click="onErrorAction"
        >
          刷新
        </button>
      </div>

      <div v-if="lite.runError" class="lite-run-error" role="alert">
        <div class="lite-run-error-title">
          <span>{{ lite.runError.message }}</span>
          <button
            v-if="lite.runError.detail || lite.runError.tracingId"
            type="button"
            class="lite-error-action"
            @click="toggleRunDetail"
          >
            {{ runDetailOpen ? '收起' : '查看详情' }}
          </button>
        </div>
        <p v-if="runDetailOpen" class="lite-run-error-detail">{{ runDetailText }}</p>
      </div>

      <!-- 顶部行：提示信息居左 + 「展开输入框」按钮居右（与对话模式同款结构）；
           下行：输入框 + 发送按钮同行贴底对齐，发送按钮不再被挤到下一行。 -->
      <div class="lite-input" :class="{ 'is-expanded': expandedInput }">
        <div class="lite-input-top">
          <div class="lite-media-group">
            <MediaThumbStrip
              :attachments="mediaAttachments"
              @remove="removeMedia"
              @toggle="toggleMediaVariant"
            />
            <div class="lite-input-hint">/ 指令 · @ 角色 · &amp; 文件引用</div>
          </div>
          <div class="lite-input-actions">
            <ElPopover
              trigger="click"
              placement="top-end"
              :width="160"
              popper-class="add-media-popper"
              popper-style="padding: 4px;"
            >
              <template #reference>
                <ElTooltip
                  :content="mediaDisabledReason || '添加媒体'"
                  popper-class="label-tip-popper"
                >
                  <span>
                    <button
                      type="button"
                      class="lite-add-media-btn"
                      :disabled="!!mediaDisabledReason"
                      aria-label="添加媒体附件"
                    >
                      <Plus width="16" height="16" />
                    </button>
                  </span>
                </ElTooltip>
              </template>
              <div class="add-media-menu" @click.stop>
                <ElTooltip
                  v-for="item in mediaKinds"
                  :key="item.kind"
                  :content="
                    mediaDisabledReason ||
                    (mediaServicesByType[item.kind]
                      ? item.label
                      : `当前感官组无处理${item.label}的工具，且模型不支持原生${item.label}`)
                  "
                  popper-class="label-tip-popper"
                >
                  <span>
                    <ElUpload
                      :auto-upload="false"
                      :show-file-list="false"
                      :accept="`${item.kind}/*`"
                      :disabled="!!mediaDisabledReason || !mediaServicesByType[item.kind]"
                      :on-change="(file: UploadFile) => onMediaSelected(file)"
                      class="add-media-upload"
                    >
                      <div class="add-media-item">
                        <span>{{ item.label }}</span
                        ><span
                          class="media-svc-tag"
                          :class="{ missing: !mediaServicesByType[item.kind] }"
                          >{{ mediaServicesByType[item.kind] || '不可用' }}</span
                        >
                      </div>
                    </ElUpload>
                  </span>
                </ElTooltip>
              </div>
            </ElPopover>
            <el-tooltip
              :content="expandedInput ? '收起输入框' : '展开输入框（最高半屏）'"
              placement="top"
              :show-after="150"
              :hide-after="0"
            >
              <button
                type="button"
                class="lite-expand-btn"
                :class="{ 'is-expanded': expandedInput }"
                :aria-pressed="expandedInput"
                :aria-label="expandedInput ? '收起输入框' : '展开输入框（最高半屏）'"
                @click="toggleExpandInput"
              >
                <Top class="lite-expand-icon" aria-hidden="true" />
              </button>
            </el-tooltip>
          </div>
        </div>
        <div v-if="mediaHint" class="lite-media-hint" role="status">
          {{ mediaHint }}
        </div>
        <div class="lite-input-row">
          <textarea
            ref="liteInputEl"
            v-model="inputText"
            class="lite-input-box"
            rows="1"
            :placeholder="
              connectionBlocked ? operationBlockReason : '发送消息（Enter 发送 / Shift+Enter 换行）'
            "
            :disabled="sending || connectionBlocked"
            @keydown="onLiteKeydown"
            @click="menu.refresh"
            @keyup.left="menu.refresh"
            @keyup.right="menu.refresh"
            @input="onLiteInput"
          />
          <InstructionSuggestions
            :items="menu.suggestions.value"
            :active-index="menu.activeIndex.value"
            :message="menu.message.value"
            :opened="menu.opened.value"
            :tabs="menu.tabs.value"
            :active-tab="menu.activeTab.value"
            @select="menu.choose"
            @select-tab="menu.selectTab"
          />
          <button
            type="button"
            class="lite-send-btn"
            :disabled="sending || uploading || !inputText.trim() || connectionBlocked"
            @click="onSend"
          >
            发送
          </button>
        </div>
        <div
          v-if="inputText.includes('[[file:')"
          class="lite-input-reference-preview"
          aria-label="文件引用"
        >
          <span
            v-for="(segment, index) in splitCommandPrompt(inputText).filter(
              (item) => item.type === 'file',
            )"
            :key="index"
            class="lite-reference-chip"
            >&amp;{{ segment.value }}</span
          >
        </div>
      </div>

      <DetailDrawer
        :window-id="windowId"
        :root-chat-id="rootChatId"
        :node="detailNode"
        :node-index="detailNodeIndex"
        :focus-tool-call-id="rootUi.detailFocusToolCallId"
        :initial-section="rootUi.detailInitialSection"
        @close="closeDetail"
      />

      <!-- t16：时间轴 bar 悬停 tip（详情浮层，跟随鼠标） -->
      <Teleport to="body">
        <div
          v-if="hoverNode"
          class="lite-tip"
          :style="{ left: tipPos.x + 'px', top: tipPos.y + 'px' }"
        >
          <span class="lite-tip-head">
            <template v-if="hoverCall">
              <span class="lite-tip-icon" aria-hidden="true">{{
                toolTypeGlyph(classifyToolType(hoverCall.name))
              }}</span>
              <strong>{{ hoverCall.label }}</strong>
            </template>
            <template v-else>
              <span class="lite-tip-icon" aria-hidden="true">{{ hoverNode.icon }}</span>
              <strong>{{ hoverNode.label }}</strong>
            </template>
          </span>
          <span class="lite-tip-row">
            <span class="lite-tip-key">状态</span>
            {{
              hoverCall
                ? runStatusLabel(toolCallStatus(hoverCall.status))
                : runStatusLabel(hoverNode.status)
            }}
          </span>
          <span v-if="!hoverCall" class="lite-tip-row">
            <span class="lite-tip-key">耗时</span>
            {{ hoverNode.elapsedMs > 0 ? formatElapsed(hoverNode.elapsedMs) : '—' }}
          </span>
          <span v-if="!hoverCall" class="lite-tip-row">
            <span class="lite-tip-key">类型</span>
            {{ nodeKindLabel(hoverNode) }}
          </span>
          <span v-if="hoverCall" class="lite-tip-row">
            <span class="lite-tip-key">工具类型</span>
            {{ toolTypeLabel(classifyToolType(hoverCall.name)) }}
          </span>
          <span v-else-if="hoverNode.kind === 'tool'" class="lite-tip-row">
            <span class="lite-tip-key">工具类型</span>
            {{ toolTypeLabel(hoverNode.toolType) }}
          </span>
          <span v-if="hoverNode.agentLabel" class="lite-tip-row">
            <span class="lite-tip-key">Agent</span>
            {{ hoverNode.agentLabel }}
          </span>
          <span class="lite-tip-action">{{ tipAction }}</span>
        </div>
      </Teleport>
    </div>
  </div>
</template>

<style scoped src="./LiteView.styles.css"></style>
