<script setup lang="ts">
import { useLiteViewController, type LiteViewControllerProps } from './useLiteViewController'
import ApprovalSummary from '@/features/agent/cards/ApprovalSummary.vue'
import ParsedArgs from '@/features/agent/cards/ParsedArgs.vue'
import FileChangeDiff from '@/features/agent/cards/FileChangeDiff.vue'
const props = defineProps<LiteViewControllerProps>()
const controller = useLiteViewController(props)
const {
  DetailDrawer,
  LiteMarkdown,
  LiteScrollbar,
  aborting,
  activeInteraction,
  activeLane,
  activePendingTabId,
  activeQuestion,
  activeQuestionIdOf,
  activeQuestionIndexOf,
  answeredQuestionCount,
  answering,
  approvalArguments,
  approvalDetailNodeId,
  approvalRiskSummary,
  autoGrowInput,
  closeDetail,
  connectionBlocked,
  deciding,
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
  interactionActionable,
  interactionStatusLabel,
  isDetailNode,
  isInFlightNode,
  isPlainRowContent,
  isRowFocused,
  laneTabs,
  lite,
  liteInputEl,
  liteStatus,
  monitor,
  monitorEl,
  moveBarTip,
  nodeKindLabel,
  nodeToneVars,
  noteOf,
  onAnswerBatch,
  onDecide,
  onErrorAction,
  onInputKeydown,
  onMonitorScroll,
  onResume,
  onSend,
  onStop,
  onTrajectoryKeydown,
  onTrajectoryWheel,
  openApprovalDetail,
  moveQuestion,
  openNodeDetail,
  operationBlockReason,
  pendingTab,
  pendingTabs,
  questionAnswered,
  questionsOf,
  remainingLabel,
  resetTrajectoryZoom,
  resuming,
  rootUi,
  rowKey,
  runStatusLabel,
  selectedOf,
  sending,
  setOptionNote,
  selectQuestion,
  setRowEl,
  setTextDraft,
  showBarTip,
  showsRowContent,
  textDraftOf,
  tipPos,
  toggleOption,
  canAnswerBatch,
  toolTypeGlyph,
  trajectoryBarStyle,
  trajectoryLayout,
  trajectoryZoom,
  visibleRows,
} = controller
</script>

<template>
  <div class="lite-view" :data-window="props.windowId" :style="nodeToneVars">
    <header class="lite-statusbar">
      <span class="lite-status-dot" :data-tone="liteStatus.tone" aria-hidden="true" />
      <span class="lite-status-text">轻量状态：{{ liteStatus.text }}</span>
      <span v-if="hydrationLabel" class="lite-hydration">{{ hydrationLabel }}</span>
      <span class="lite-node-count">{{ history.nodes.length }} 节点</span>
      <!-- v0.5.3 链路标签栏迁入状态条：顶层直接展示多个 Agent（主 Agent ✧ + 各子 Agent ◆ 角色名），
           点击切换 activeLane，与轨迹行头角色名按钮联动 -->
      <nav v-if="laneTabs.length > 1" class="lite-lane-bar" aria-label="切换链路">
        <button
          v-for="tab in laneTabs"
          :key="tab.chatId"
          type="button"
          class="lite-lane-tab"
          :class="[{ 'is-active': tab.chatId === activeLane }, { 'is-root-lane': tab.isRootLane }]"
          :title="'切换到 ' + tab.label + ' 链路'"
          @click="activeLane = tab.chatId"
        >
          <span class="lite-lane-tab-icon" aria-hidden="true">{{
            tab.isRootLane ? '✧' : '◆'
          }}</span>
          <span class="lite-lane-tab-label">{{ tab.label }}</span>
        </button>
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
          <button
            type="button"
            class="lite-trajectory-zoom"
            :title="'重置缩放（Ctrl/⌘ + 滚轮缩放）'"
            @click="resetTrajectoryZoom"
          >
            {{ Math.round(trajectoryZoom * 100) }}%
          </button>
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
                  <button
                    type="button"
                    class="lite-trajectory-lane-label"
                    :title="'切换到 ' + track.label + ' 链路'"
                    @click="activeLane = track.chatId"
                  >
                    {{ track.label }}
                  </button>
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
                      :title="
                        bar.node.label +
                        ' · ' +
                        runStatusLabel(bar.node.status) +
                        ' · 点击定位下方内容'
                      "
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
                <button
                  v-if="row.node && !isInFlightNode(row.node)"
                  type="button"
                  class="lite-history-detail"
                  @click="openNodeDetail(row.node, $event)"
                >
                  详情
                </button>
              </div>
              <div v-if="showsRowContent(row.node)" class="lite-history-content">
                <LiteMarkdown
                  :text="row.node.content || '（空）'"
                  :plain="isPlainRowContent(row.node)"
                />
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
                :title="`${node.label} · ${runStatusLabel(node.status)}${
                  node.elapsedMs > 0 ? ' · ' + formatElapsed(node.elapsedMs) : ''
                }`"
                :aria-label="`${node.label}，${runStatusLabel(node.status)}${
                  node.elapsedMs > 0 ? '，' + formatElapsed(node.elapsedMs) : ''
                }`"
                @click="openNodeDetail(node, $event)"
              >
                <span class="lite-cluster-icon" aria-hidden="true">{{
                  node.kind === 'tool' ? toolTypeGlyph(node.toolType) : node.icon
                }}</span>
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

      <section v-if="activeInteraction" class="lite-pending-panel" aria-label="待处理详情">
        <div v-if="pendingTabs.length" class="lite-pending-tabs-bar" role="tablist">
          <button
            v-for="tab in pendingTabs"
            :key="tab.id"
            type="button"
            role="tab"
            class="lite-pending-tab"
            :class="[
              { 'is-active': tab.id === activePendingTabId, 'is-expired': tab.expired },
              'is-' + tab.kind,
            ]"
            :aria-selected="tab.id === activePendingTabId"
            :title="tab.label"
            @click="pendingTab = tab.id"
          >
            <span class="lite-pending-tab-icon" aria-hidden="true">{{ tab.icon }}</span>
            <span class="lite-pending-tab-label">{{ tab.label }}</span>
            <span v-if="tab.countdown" class="lite-pending-badge" :data-expired="tab.expired">
              {{ tab.countdown }}
            </span>
          </button>
        </div>
        <div class="lite-pending-content">
          <div
            v-if="activeInteraction.kind === 'approval'"
            class="lite-interaction is-approval"
            :data-status="activeInteraction.status"
          >
            <div class="lite-interaction-body">
              <header class="lite-interaction-head">
                <span class="lite-interaction-kicker">APPROVAL REQUEST</span>
                <span class="lite-interaction-head-right">
                  <span
                    class="lite-interaction-dot"
                    :data-status="activeInteraction.status"
                    aria-hidden="true"
                  />
                  <span
                    v-if="activeInteraction.status !== 'pending'"
                    class="lite-status-pill"
                    :data-status="activeInteraction.status"
                    >{{ interactionStatusLabel(activeInteraction) }}</span
                  >
                  <span
                    v-if="remainingLabel(activeInteraction)"
                    class="lite-countdown"
                    :data-expired="remainingLabel(activeInteraction) === '已超时'"
                  >
                    {{ remainingLabel(activeInteraction) }}
                  </span>
                </span>
              </header>
              <ApprovalSummary
                class="lite-approval-overview"
                :sense-name="activeInteraction.payload?.senseName"
                :args="approvalArguments(activeInteraction)"
              />
              <p class="lite-risk-summary">
                <span aria-hidden="true">!</span>{{ approvalRiskSummary(activeInteraction) }}
              </p>
              <details class="lite-technical-details">
                <summary>技术详情</summary>
                <div class="lite-technical-details-body">
                  <ParsedArgs
                    :args="approvalArguments(activeInteraction)"
                    title="完整操作参数"
                    embedded
                  />
                  <FileChangeDiff :args="approvalArguments(activeInteraction)" embedded />
                </div>
              </details>
              <p
                v-if="lite.interactionError(activeInteraction.interactionId)"
                class="lite-object-error"
                role="alert"
              >
                {{ lite.interactionError(activeInteraction.interactionId)?.message }}
              </p>
              <button
                type="button"
                class="lite-view-full"
                :disabled="!approvalDetailNodeId(activeInteraction)"
                @click="openApprovalDetail(activeInteraction, $event)"
              >
                查看工具详情
              </button>
            </div>
            <footer
              v-if="interactionActionable(activeInteraction)"
              class="lite-interaction-actions"
            >
              <span class="lite-action-hint">批准后将立即执行，请先核对目标与变更。</span>
              <button
                type="button"
                class="lite-btn is-reject"
                :disabled="
                  deciding === activeInteraction.interactionId ||
                  remainingLabel(activeInteraction) === '已超时' ||
                  connectionBlocked
                "
                @click="onDecide(activeInteraction, 'reject')"
              >
                拒绝
              </button>
              <button
                type="button"
                class="lite-btn is-accept"
                :disabled="
                  deciding === activeInteraction.interactionId ||
                  remainingLabel(activeInteraction) === '已超时' ||
                  connectionBlocked
                "
                @click="onDecide(activeInteraction, 'accept')"
              >
                {{ deciding === activeInteraction.interactionId ? '处理中…' : '允许执行' }}
              </button>
            </footer>
          </div>
          <div v-else class="lite-interaction is-question" :data-status="activeInteraction.status">
            <div class="lite-interaction-body is-question">
              <header class="lite-interaction-head">
                <span class="lite-interaction-kicker">QUESTION SESSION</span>
                <span class="lite-interaction-head-right">
                  <span
                    class="lite-interaction-dot"
                    :data-status="activeInteraction.status"
                    aria-hidden="true"
                  />
                  <span>
                    已完成 {{ answeredQuestionCount(activeInteraction) }}/{{
                      questionsOf(activeInteraction).length
                    }}
                  </span>
                </span>
              </header>
              <div class="lite-question-workspace">
                <nav class="lite-question-nav" aria-label="问题列表">
                  <button
                    v-for="(question, index) in questionsOf(activeInteraction)"
                    :key="question.questionId"
                    type="button"
                    class="lite-question-nav-item"
                    :class="{
                      'is-active': question.questionId === activeQuestionIdOf(activeInteraction),
                      'is-answered': questionAnswered(activeInteraction.interactionId, question),
                    }"
                    :aria-current="
                      question.questionId === activeQuestionIdOf(activeInteraction)
                        ? 'step'
                        : undefined
                    "
                    @click="selectQuestion(activeInteraction, question.questionId)"
                  >
                    <span class="lite-question-index">{{
                      String(index + 1).padStart(2, '0')
                    }}</span>
                    <span class="lite-question-nav-copy">
                      <strong>{{ question.header || `问题 ${index + 1}` }}</strong>
                      <small>{{ question.question }}</small>
                    </span>
                    <span class="lite-question-state" aria-hidden="true">{{
                      questionAnswered(activeInteraction.interactionId, question) ? '✓' : '·'
                    }}</span>
                  </button>
                </nav>
                <fieldset v-if="activeQuestion" class="lite-followup-question">
                  <legend>{{ activeQuestion.header || activeQuestion.question }}</legend>
                  <p v-if="activeQuestion.header" class="lite-question-prompt">
                    {{ activeQuestion.question }}
                  </p>
                  <p class="lite-question-type">
                    {{
                      activeQuestion.freeText
                        ? '自由回答'
                        : activeQuestion.multiSelect
                          ? '可多选'
                          : '单选'
                    }}
                  </p>
                  <p
                    v-if="
                      lite.questionError(activeInteraction.interactionId, activeQuestion.questionId)
                    "
                    class="lite-question-error"
                    role="alert"
                  >
                    {{
                      lite.questionError(activeInteraction.interactionId, activeQuestion.questionId)
                        ?.message
                    }}
                  </p>
                  <template v-if="!activeQuestion.freeText">
                    <div
                      v-for="option in activeQuestion.options"
                      :key="option.label"
                      class="lite-option-wrap"
                    >
                      <label class="lite-option">
                        <input
                          :type="activeQuestion.multiSelect ? 'checkbox' : 'radio'"
                          :name="activeInteraction.interactionId + ':' + activeQuestion.questionId"
                          :disabled="!interactionActionable(activeInteraction)"
                          :checked="
                            selectedOf(
                              activeInteraction.interactionId,
                              activeQuestion.questionId,
                            ).includes(option.label)
                          "
                          @change="
                            toggleOption(
                              activeInteraction.interactionId,
                              activeQuestion,
                              option.label,
                            )
                          "
                        />
                        <span class="lite-option-label">{{ option.label }}</span>
                        <span v-if="option.description" class="lite-option-description">{{
                          option.description
                        }}</span>
                      </label>
                      <textarea
                        v-if="
                          selectedOf(
                            activeInteraction.interactionId,
                            activeQuestion.questionId,
                          ).includes(option.label)
                        "
                        class="lite-option-note"
                        rows="2"
                        :value="
                          noteOf(
                            activeInteraction.interactionId,
                            activeQuestion.questionId,
                            option.label,
                          )
                        "
                        :disabled="!interactionActionable(activeInteraction)"
                        placeholder="为这个选项补充描述（可选）"
                        @input="
                          setOptionNote(
                            activeInteraction.interactionId,
                            activeQuestion.questionId,
                            option.label,
                            ($event.target as HTMLTextAreaElement).value,
                          )
                        "
                      />
                    </div>
                  </template>
                  <textarea
                    class="lite-freetext"
                    :class="{ 'is-other': !activeQuestion.freeText }"
                    rows="4"
                    :value="textDraftOf(activeInteraction.interactionId, activeQuestion.questionId)"
                    :disabled="!interactionActionable(activeInteraction)"
                    :placeholder="activeQuestion.freeText ? '输入回答' : '其他补充（可选）'"
                    @input="
                      setTextDraft(
                        activeInteraction.interactionId,
                        activeQuestion,
                        ($event.target as HTMLTextAreaElement).value,
                      )
                    "
                  />
                </fieldset>
              </div>
              <p
                v-if="lite.interactionError(activeInteraction.interactionId)"
                class="lite-object-error"
                role="alert"
              >
                {{ lite.interactionError(activeInteraction.interactionId)?.message }}
              </p>
            </div>
            <footer
              v-if="interactionActionable(activeInteraction)"
              class="lite-interaction-actions is-question"
            >
              <div class="lite-question-pager">
                <button
                  type="button"
                  :disabled="activeQuestionIndexOf(activeInteraction) <= 0"
                  @click="moveQuestion(activeInteraction, -1)"
                >
                  上一题
                </button>
                <span
                  >{{ activeQuestionIndexOf(activeInteraction) + 1 }} /
                  {{ questionsOf(activeInteraction).length }}</span
                >
                <button
                  type="button"
                  :disabled="
                    activeQuestionIndexOf(activeInteraction) >=
                    questionsOf(activeInteraction).length - 1
                  "
                  @click="moveQuestion(activeInteraction, 1)"
                >
                  下一题
                </button>
              </div>
              <button
                type="button"
                class="lite-btn is-submit"
                :disabled="
                  answering === activeInteraction.interactionId ||
                  connectionBlocked ||
                  !canAnswerBatch(activeInteraction)
                "
                @click="onAnswerBatch(activeInteraction)"
              >
                {{ canAnswerBatch(activeInteraction) ? '提交回答' : '请完成全部问题' }}
              </button>
            </footer>
          </div>
        </div>
      </section>

      <div class="lite-input">
        <textarea
          ref="liteInputEl"
          v-model="inputText"
          class="lite-input-box"
          rows="1"
          :placeholder="
            connectionBlocked ? operationBlockReason : '发送消息（Enter 发送 / Shift+Enter 换行）'
          "
          :disabled="sending || connectionBlocked"
          @keydown="onInputKeydown"
          @input="autoGrowInput"
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
          <span v-if="hoverNode.agentLabel" class="lite-tip-row">
            <span class="lite-tip-key">Agent</span>
            {{ hoverNode.agentLabel }}
          </span>
        </div>
      </Teleport>
    </div>
  </div>
</template>

<style scoped src="./LiteView.styles.css"></style>
