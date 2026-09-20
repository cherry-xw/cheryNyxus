<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Top } from '@element-plus/icons-vue'
import { MorphIcon } from 'morphicons/vue'
import { useMotionTier } from '@/composables/useMotionTier'
import { clusterNodeIcon } from './clusterIcons'
import { useLiteViewController, type LiteViewControllerProps } from './useLiteViewController'
import { useInstructionSuggestions } from '../agent/composer/useInstructionSuggestions'
import InstructionSuggestions from '../agent/composer/InstructionSuggestions.vue'
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
  nodeKindLabel,
  nodeTipText,
  nodeToneVars,
  onErrorAction,
  onInputKeydown,
  onMonitorScroll,
  onResume,
  onSend,
  onStop,
  onTrajectoryKeydown,
  onTrajectoryWheel,
  openNodeDetail,
  operationBlockReason,
  resetTrajectoryZoom,
  resuming,
  rootUi,
  rowKey,
  runDetailOpen,
  runDetailText,
  runStatusLabel,
  sending,
  setRowEl,
  showBarTip,
  showsRowContent,
  tipAction,
  tipPos,
  toggleThinking,
  toggleRunDetail,
  toolTypeLabel,
  trajectoryBarStyle,
  trajectoryLayout,
  trajectoryZoom,
  userSegments,
  visibleRows,
} = controller

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
              <button
                v-for="node in row.nodes"
                :key="node.key"
                type="button"
                class="lite-cluster-node"
                :class="[
                  `is-${node.kind}`,
                  `is-status-${node.status}`,
                  {
                    'is-selected': isDetailNode(node),
                    'is-focused': node.nodeId === focusNodeId,
                  },
                ]"
                :data-status="node.status"
                :data-tooltype="node.kind === 'tool' ? node.toolType : undefined"
                :aria-label="nodeTipText(node)"
                @pointerenter="showBarTip(node, $event)"
                @pointermove="moveBarTip"
                @pointerleave="hideBarTip"
                @click="openNodeDetail(node, $event)"
              >
                <!-- 可变形图标（morphicons + lucide）：终态变形为状态图标，见 clusterIcons.ts -->
                <MorphIcon
                  class="lite-cluster-icon"
                  :icon="clusterNodeIcon(node)"
                  :size="15"
                  :stroke-width="2"
                  :reduced-motion="clusterMorphReducedMotion"
                  spring="snappy"
                  aria-hidden="true"
                />
                <span class="lite-cluster-status" :data-status="node.status" aria-hidden="true" />
              </button>
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
          <div class="lite-input-hint">
            / 指令 · @ 角色 · &amp; 文件引用（仅传路径） · 输入后从候选窗口选择
          </div>
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
            :disabled="sending || !inputText.trim() || connectionBlocked"
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
            <span class="lite-tip-icon" aria-hidden="true">{{ hoverNode.icon }}</span>
            <strong>{{ hoverNode.label }}</strong>
          </span>
          <span class="lite-tip-row">
            <span class="lite-tip-key">状态</span>
            {{ runStatusLabel(hoverNode.status) }}
          </span>
          <span class="lite-tip-row">
            <span class="lite-tip-key">耗时</span>
            {{ hoverNode.elapsedMs > 0 ? formatElapsed(hoverNode.elapsedMs) : '—' }}
          </span>
          <span class="lite-tip-row">
            <span class="lite-tip-key">类型</span>
            {{ nodeKindLabel(hoverNode) }}
          </span>
          <span v-if="hoverNode.kind === 'tool'" class="lite-tip-row">
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
