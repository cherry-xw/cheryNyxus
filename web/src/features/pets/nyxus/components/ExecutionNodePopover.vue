<script setup lang="ts">
import { ref } from 'vue'
import { gsap } from 'gsap'
import { useExecutionNodePopoverController, type ExecutionNodePopoverControllerProps, type ExecutionNodePopoverControllerEmits } from './useExecutionNodePopoverController'
import { useGsap } from '@/composables/useGsap'
import { useMotionPreference } from '@/composables/useMotionPreference'
import { MOTION } from '@/utils/gsapCore'
import ApprovalCard from '@/features/agent/cards/ApprovalCard.vue'
import QuestionCard from '@/features/agent/cards/QuestionCard.vue'
import RiskBadge from '@/components/RiskBadge.vue'
const props = defineProps<ExecutionNodePopoverControllerProps>()
const emit = defineEmits<ExecutionNodePopoverControllerEmits>()
const controller = useExecutionNodePopoverController(props, emit)
const {
  ElTooltip, RESULT_PREVIEW_LIMIT, ToolFieldTree, activeQuestionCall, actualDescription, batch,
  batchInfo, canBranch, copiedFieldKey, copyField, isQuestionOptionSelected, isQuestionTool,
  isReadFileTool, isSearchTool, isSkillTool, isSpawnTool, isUserNode, nodeContent,
  nodeContentSegments, nodeDescription, nodeStatus, nodeTermination, nodeThinking, nodeTime,
  nodeTitle, onHeaderPointerDown, onHeaderPointerMove, onHeaderPointerUp, primaryInstruction,
  questionAnswer, questionArgs, readFileContent, readFileLineCount, readFilePath, readFilePreview,
  readFileRange, renderedActualDescription, renderedNodeContent, renderedNodeDescription,
  renderedNodeThinking, renderedPrimaryInstruction, renderedResult, renderedSkillContent,
  renderedSpawnPrompt, resultFields, resultTruncated,
  searchConfiguration, searchMode, searchPath, searchQuery, searchResult, secondaryFields,
  selectedCall, selectedStatus, skillResult, skinForNode, spawnPrompt, spawnRole, spawnWake,
  terminationDisplay, thinkingOpen, toolBatchUsesTabs, toolGlyph, toolIcon, toolLabel, toolPresentation,
} = controller

/**
 * 入场时间线（2026-09-02 返工契约，docs/web/pet/nyxus-node-tree-maintenance.md）：
 * 标题栏 → 页签 → 正文 stagger，总时长 ≤320ms，只动 transform/autoAlpha。
 * 仅组件挂载时执行一次——hover 链上切换节点复用同一实例，不重放。
 */
const popoverRoot = ref<HTMLElement | null>(null)
const { effectiveMode } = useMotionPreference()
useGsap(popoverRoot, (context) => {
  context.add(() => {
    if (effectiveMode.value === 'reduced') return
    const head = popoverRoot.value?.querySelector('.popover-chrome')
    const tabs = popoverRoot.value?.querySelector('.tool-tabs')
    const body = popoverRoot.value?.querySelectorAll('.popover-body > *')
    const timeline = gsap.timeline({ defaults: { ease: 'power2.out', overwrite: 'auto' } })
    if (head) timeline.from(head, { autoAlpha: 0, y: -6, duration: MOTION.control }, 0)
    if (tabs) timeline.from(tabs, { autoAlpha: 0, y: -4, duration: MOTION.control }, 0.04)
    if (body?.length) {
      const stagger = Math.min(0.02, 0.08 / Math.max(1, body.length - 1))
      timeline.from(body, { autoAlpha: 0, y: 8, duration: MOTION.control, stagger }, 0.08)
    }
  })
})
</script>

<template>
  <aside
    ref="popoverRoot"
    class="node-popover"
    :class="[
      `is-${variant ?? 'popover'}`,
      { 'is-pinned': pinned, 'is-actionable': approval || question, 'is-wrap': wrap },
    ]"
    :style="{ maxHeight: `${maxHeight}px` }"
    role="dialog"
    :aria-label="`${nodeTitle}详情`"
  >
    <div class="popover-chrome">
      <header
        class="popover-head"
        :class="{ 'is-draggable': draggable }"
        @pointerdown.stop="onHeaderPointerDown"
        @pointermove.stop="onHeaderPointerMove"
        @pointerup.stop="onHeaderPointerUp"
        @pointercancel.stop="onHeaderPointerUp"
      >
        <span class="title-icon" aria-hidden="true">
          {{ batch ? toolIcon : skinForNode(node).glyph }}
        </span>
        <strong>{{ nodeTitle }}</strong>
        <span v-if="nodeTime" class="node-time" aria-label="节点发起时间">{{ nodeTime }}</span>
        <span v-if="!batch" class="status-pill" :class="`status-${node.status}`">
          {{ nodeStatus }}
        </span>
        <div v-if="canBranch && !approval && !question" class="branch-head-actions" role="group" aria-label="从此节点发起对话">
          <span class="branch-action-wrap">
            <button
              type="button"
              class="branch-head-action is-detail"
              :disabled="detailBranchAvailable === false"
              @click="emit('branch', 'detail', node.sourceFact!.id)"
            ><span aria-hidden="true">◉</span>解释此处</button>
            <ElTooltip
              :content="detailBranchAvailable === false
                ? (detailBranchUnavailableReason || '当前预设未配置解释角色')
                : '创建独立解释分支，使用专用诊断角色；可读取、搜索并运行诊断命令，不修改原任务。'"
              placement="top"
              :show-after="180"
            >
              <span class="branch-info" aria-hidden="true">ⓘ</span>
            </ElTooltip>
          </span>
          <span class="branch-action-wrap">
            <button
              type="button"
              class="branch-head-action is-continuation"
              @click="emit('branch', 'continuation', node.sourceFact!.id)"
            ><span aria-hidden="true">⑂</span>从此处继续</button>
            <ElTooltip
              content="从该历史状态创建并列任务分支并继承原角色；节点之后已经发生的工具副作用不会撤销。"
              placement="top"
              :show-after="180"
            >
              <span class="branch-info" aria-hidden="true">ⓘ</span>
            </ElTooltip>
          </span>
        </div>
        <button
          v-if="pinned"
          type="button"
          class="icon-button wrap-button"
          :aria-pressed="wrap"
          :title="wrap ? '保持长行并横向滚动' : '自动换行'"
          @click="emit('toggleWrap')"
        >
          {{ wrap ? '↔' : '¶' }}
        </button>
        <button
          v-if="pinned"
          type="button"
          class="icon-button close-button"
          aria-label="关闭详情"
          @click="emit('close')"
        >
          ×
        </button>
      </header>

      <div
        v-if="batch && toolBatchUsesTabs(batch.calls) && !question"
        class="tool-tabs"
        role="tablist"
        aria-label="工具类型"
      >
        <button
          v-for="call in batch.calls"
          :key="call.callId"
          type="button"
          role="tab"
          :aria-selected="call.callId === selectedCall?.callId"
          :class="{ active: call.callId === selectedCall?.callId }"
          @click="emit('selectCall', call.callId)"
        >
          <span class="tool-tab-icon" aria-hidden="true">{{ toolGlyph(call.name) }}</span>
          <span class="tool-tab-label">{{ toolLabel(call.name) }}</span>
          <RiskBadge :auth="call.security" compact />
        </button>
      </div>
    </div>

    <div class="popover-body">
      <ApprovalCard v-if="approval && chatId" :approval="approval" :chat-id="chatId" />
      <!-- 询问节点（question 场景）：标题 → 思考 → 正文 → tabs(指示器) → 选项区+操作。
           tabs 高亮由当前活动问题（activeQuestionCall）联动，"下一步"推进后高亮跟走；
           点击 tab 不切换问题内容（问题只由"下一步"实质切换）。 -->
      <template v-if="question">
        <QuestionCard
          v-if="chatId"
          :question="question.question"
          :chat-id="chatId"
          :batch-info="{
            batchId: question.batch.batchId,
            total: question.batch.questions.length,
            readyCount: question.batch.questions.filter((item) => item.localStatus === 'ready').length,
            currentIndex: question.currentIndex,
            isLast: question.currentIndex === question.batch.questions.length - 1,
          }"
          variant="paper"
        />
        <div class="question-title-row">
          <span class="question-symbol" aria-hidden="true">?</span>
          <span class="heading-copy">
            <span class="heading-kicker">{{ question.question.header || '需要你的选择' }}</span>
            <span class="question-text">{{ question.question.question }}</span>
          </span>
          <span v-if="batchInfo && batchInfo.total > 1" class="question-progress">
            {{ batchInfo.currentIndex + 1 }} / {{ batchInfo.total }}
          </span>
        </div>
        <div v-if="batch" class="batch-lead">
          <section v-if="nodeThinking" class="thinking-block">
            <button
              type="button"
              class="thinking-toggle"
              :aria-expanded="thinkingOpen"
              @click="thinkingOpen = !thinkingOpen"
            >
              <span class="thinking-glyph" aria-hidden="true">✦</span>
              <span>思考</span>
              <span class="thinking-toggle-hint" aria-hidden="true">
                {{ thinkingOpen ? '−' : '+' }}
              </span>
            </button>
            <div v-if="thinkingOpen" class="thinking-body">
              <div class="markdown-body thinking-copy" v-html="renderedNodeThinking" />
            </div>
          </section>
          <section v-if="nodeDescription" class="actual-description detail-field">
            <small class="detail-label">说明</small>
            <div class="detail-value">
              <div class="markdown-body" v-html="renderedNodeDescription" />
            </div>
          </section>
          <div
            v-if="nodeContent"
            class="markdown-body primary-content batch-lead-content"
            v-html="renderedNodeContent"
          />
        </div>
        <div
          v-if="batch && toolBatchUsesTabs(batch.calls)"
          class="tool-tabs question-tabs"
          role="tablist"
          aria-label="问题批次"
        >
          <button
            v-for="call in batch.calls"
            :key="call.callId"
            type="button"
            role="tab"
            :aria-selected="call.callId === activeQuestionCall?.callId"
            :class="{ active: call.callId === activeQuestionCall?.callId }"
            @click="!question && emit('selectCall', call.callId)"
          >
            <span class="tool-tab-icon" aria-hidden="true">{{ toolGlyph(call.name) }}</span>
            <span class="tool-tab-label">{{ toolLabel(call.name) }}</span>
          </button>
        </div>
      </template>

      <div v-if="batch && !question" class="batch-lead">
        <section v-if="nodeThinking" class="thinking-block">
          <button
            type="button"
            class="thinking-toggle"
            :aria-expanded="thinkingOpen"
            @click="thinkingOpen = !thinkingOpen"
          >
            <span class="thinking-glyph" aria-hidden="true">✦</span>
            <span>思考</span>
            <span class="thinking-toggle-hint" aria-hidden="true">
              {{ thinkingOpen ? '−' : '+' }}
            </span>
          </button>
          <div v-if="thinkingOpen" class="thinking-body">
            <div class="markdown-body thinking-copy" v-html="renderedNodeThinking" />
          </div>
        </section>
        <section v-if="nodeDescription" class="actual-description detail-field">
          <small class="detail-label">说明</small>
          <div class="detail-value">
            <div class="markdown-body" v-html="renderedNodeDescription" />
          </div>
        </section>
        <div
          v-if="nodeContent"
          class="markdown-body primary-content batch-lead-content"
          v-html="renderedNodeContent"
        />
      </div>

      <template v-if="batch && !question">
        <Transition name="tool-content" mode="out-in">
          <section v-if="selectedCall" :key="selectedCall.callId" class="tool-detail">
            <div class="single-tool-status">
              <span :class="`status-${selectedCall.status}`">{{ selectedStatus }}</span>
              <!-- 该工具调用的安全判定徽章（缺省 = 未知） -->
              <RiskBadge :auth="selectedCall.security" />
            </div>
            <section v-if="toolPresentation" class="actual-description detail-field">
              <small class="detail-label">本次操作</small>
              <div class="detail-value">
                <p>{{ toolPresentation.operationLabel }}</p>
                <code v-if="toolPresentation.target">{{ toolPresentation.target }}</code>
                <ul v-if="toolPresentation.changes.length">
                  <li v-for="change in toolPresentation.changes" :key="`${change.label}:${change.detail}`">
                    {{ change.detail }}
                  </li>
                </ul>
              </div>
            </section>
            <section v-if="actualDescription" class="actual-description detail-field">
              <small class="detail-label">说明</small>
              <div class="detail-value">
                <div class="markdown-body" v-html="renderedActualDescription" />
              </div>
            </section>

            <section v-if="isSpawnTool" class="spawn-detail">
              <div class="spawn-field detail-field">
                <small class="detail-label">派遣角色</small>
                <div class="detail-value is-copyable">
                  <code>{{ spawnRole || '未指定' }}</code>
                  <button
                    type="button"
                    class="field-copy-button"
                    :title="copiedFieldKey === 'spawn-role' ? '已复制' : '复制派遣角色'"
                    :aria-label="copiedFieldKey === 'spawn-role' ? '已复制' : '复制派遣角色'"
                    @click="copyField('spawn-role', spawnRole)"
                  >
                    <span aria-hidden="true">⧉</span>
                  </button>
                </div>
              </div>
              <div class="spawn-field detail-field">
                <small class="detail-label">派遣信息</small>
                <div class="detail-value is-copyable">
                  <span>{{ spawnWake }}</span>
                  <button
                    type="button"
                    class="field-copy-button"
                    :title="copiedFieldKey === 'spawn-wake' ? '已复制' : '复制派遣信息'"
                    :aria-label="copiedFieldKey === 'spawn-wake' ? '已复制' : '复制派遣信息'"
                    @click="copyField('spawn-wake', spawnWake)"
                  >
                    <span aria-hidden="true">⧉</span>
                  </button>
                </div>
              </div>
              <div class="spawn-field detail-field is-prompt">
                <small class="detail-label">派遣提示词</small>
                <div class="detail-value is-copyable">
                  <div class="markdown-body" v-html="renderedSpawnPrompt" />
                  <button
                    type="button"
                    class="field-copy-button"
                    :title="copiedFieldKey === 'spawn-prompt' ? '已复制' : '复制派遣提示词'"
                    :aria-label="copiedFieldKey === 'spawn-prompt' ? '已复制' : '复制派遣提示词'"
                    @click="copyField('spawn-prompt', spawnPrompt)"
                  >
                    <span aria-hidden="true">⧉</span>
                  </button>
                </div>
              </div>
            </section>

            <template v-else>
              <section v-if="isReadFileTool" class="file-detail">
                <div class="file-detail-row detail-field">
                  <small class="detail-label">文件路径</small>
                  <div class="detail-value is-copyable file-path-line">
                    <code>{{ readFilePath || '未提供路径' }}</code>
                    <button
                      v-if="readFilePath"
                      type="button"
                      class="field-copy-button"
                      :title="copiedFieldKey === 'read-path' ? '已复制' : '复制文件路径'"
                      :aria-label="copiedFieldKey === 'read-path' ? '已复制' : '复制文件路径'"
                      @click="copyField('read-path', readFilePath)"
                    >
                      <span aria-hidden="true">⧉</span>
                    </button>
                  </div>
                </div>
                <div class="file-detail-row detail-field">
                  <small class="detail-label">读取范围</small>
                  <div class="detail-value">
                    <span>{{ readFileRange }}</span>
                  </div>
                </div>
                <div v-if="readFilePreview" class="file-content-block detail-field">
                  <small class="detail-label">文件内容 · {{ readFileLineCount }} 行</small>
                  <div class="detail-value is-copyable is-multiline">
                    <pre>{{ readFilePreview }}</pre>
                    <button
                      type="button"
                      class="field-copy-button"
                      :title="copiedFieldKey === 'read-content' ? '已复制' : '复制文件内容'"
                      :aria-label="copiedFieldKey === 'read-content' ? '已复制' : '复制文件内容'"
                      @click="copyField('read-content', readFileContent)"
                    >
                      <span aria-hidden="true">⧉</span>
                    </button>
                  </div>
                  <p v-if="resultTruncated" class="truncation-hint">
                    内容较长，当前仅展示前 {{ RESULT_PREVIEW_LIMIT }} 个字符；复制保留完整内容。
                  </p>
                </div>
                <p v-else class="empty-detail">暂无可展示的文件内容。</p>
              </section>

              <section v-else-if="isQuestionTool" class="question-detail">
                <template v-if="questionArgs">
                  <div class="question-heading">
                    <span v-if="questionArgs.header">{{ questionArgs.header }}</span>
                    <small>{{ questionArgs.multiSelect ? '多选' : '单选' }}</small>
                  </div>
                  <p class="question-text">{{ questionArgs.question }}</p>
                  <div
                    class="question-options"
                    role="list"
                    :aria-label="questionArgs.multiSelect ? '多选选项' : '单选选项'"
                  >
                    <div
                      v-for="option in questionArgs.options"
                      :key="option.label"
                      class="question-option"
                      :class="{ selected: isQuestionOptionSelected(option.label) }"
                      role="listitem"
                    >
                      <span
                        class="question-control"
                        :class="{ 'is-multi': questionArgs.multiSelect }"
                        aria-hidden="true"
                      >
                        {{ isQuestionOptionSelected(option.label) ? '✓' : '' }}
                      </span>
                      <span class="question-option-copy">
                        <strong>{{ option.label }}</strong>
                        <small v-if="option.description">{{ option.description }}</small>
                      </span>
                    </div>
                  </div>
                  <div
                    v-if="questionAnswer.kind === 'answered' && questionAnswer.freeText"
                    class="question-other detail-field"
                  >
                    <small class="detail-label">其他补充</small>
                    <div class="detail-value">
                      <p>{{ questionAnswer.freeText }}</p>
                    </div>
                  </div>
                  <p v-else-if="questionAnswer.kind === 'cancelled'" class="question-note">
                    用户已取消该问题。
                  </p>
                  <p v-else-if="questionAnswer.kind === 'running'" class="question-note">
                    等待用户选择…
                  </p>
                  <p v-else-if="questionAnswer.kind === 'missing'" class="question-note">
                    这次执行没有留下可识别的回答。
                  </p>
                </template>
                <pre v-else class="question-fallback">{{ selectedCall.arguments }}</pre>
              </section>

              <section v-else-if="isSearchTool" class="search-detail">
                <div class="search-summary-bar">
                  <span class="search-mode-badge">{{ searchMode }}</span>
                  <span v-if="searchResult.items.length">
                    {{ searchResult.items.length }} 项结果
                  </span>
                </div>
                <div class="detail-field">
                  <small class="detail-label">搜索内容</small>
                  <div class="detail-value is-copyable">
                    <code>{{ searchQuery || '未提供搜索内容' }}</code>
                    <button
                      v-if="searchQuery"
                      type="button"
                      class="field-copy-button"
                      :title="copiedFieldKey === 'search-query' ? '已复制' : '复制搜索内容'"
                      :aria-label="copiedFieldKey === 'search-query' ? '已复制' : '复制搜索内容'"
                      @click="copyField('search-query', searchQuery)"
                    >
                      <span aria-hidden="true">⧉</span>
                    </button>
                  </div>
                </div>
                <div class="detail-field">
                  <small class="detail-label">搜索范围</small>
                  <div class="detail-value is-copyable">
                    <code>{{ searchPath || '未提供搜索范围' }}</code>
                    <button
                      v-if="searchPath"
                      type="button"
                      class="field-copy-button"
                      :title="copiedFieldKey === 'search-path' ? '已复制' : '复制搜索范围'"
                      :aria-label="copiedFieldKey === 'search-path' ? '已复制' : '复制搜索范围'"
                      @click="copyField('search-path', searchPath)"
                    >
                      <span aria-hidden="true">⧉</span>
                    </button>
                  </div>
                </div>
                <div class="detail-field">
                  <small class="detail-label">搜索配置</small>
                  <div class="detail-value search-configuration">
                    <span v-for="item in searchConfiguration" :key="item">{{ item }}</span>
                  </div>
                </div>
                <div v-if="selectedCall.result" class="detail-field search-results-field">
                  <small class="detail-label">搜索结果</small>
                  <div class="detail-value is-copyable is-multiline search-results">
                    <p v-if="searchResult.summary" class="search-result-summary">
                      {{ searchResult.summary }}
                    </p>
                    <div v-if="searchResult.items.length" class="search-result-list">
                      <div
                        v-for="(result, index) in searchResult.items"
                        :key="`${result.filePath}:${result.line ?? index}`"
                        class="search-result-item"
                      >
                        <div class="search-result-location">
                          <code>{{ result.filePath }}</code>
                          <span v-if="result.line">第 {{ result.line }} 行</span>
                          <span v-if="result.gitStatus">{{ result.gitStatus }}</span>
                        </div>
                        <pre v-if="result.content">{{ result.content }}</pre>
                      </div>
                    </div>
                    <pre v-else-if="!searchResult.summary" class="search-result-raw">{{
                      selectedCall.result
                    }}</pre>
                    <button
                      type="button"
                      class="field-copy-button"
                      :title="copiedFieldKey === 'search-result' ? '已复制' : '复制搜索结果'"
                      :aria-label="copiedFieldKey === 'search-result' ? '已复制' : '复制搜索结果'"
                      @click="copyField('search-result', selectedCall.result)"
                    >
                      <span aria-hidden="true">⧉</span>
                    </button>
                  </div>
                </div>
                <p v-else class="empty-detail">等待搜索结果…</p>
              </section>

              <section v-else-if="isSkillTool" class="skill-detail">
                <div class="detail-field">
                  <small class="detail-label">技能名称</small>
                  <div class="detail-value is-copyable skill-name-value">
                    <span class="skill-glyph" aria-hidden="true">⚡</span>
                    <strong>{{ skillResult.name || '未提供技能名称' }}</strong>
                    <button
                      v-if="skillResult.name"
                      type="button"
                      class="field-copy-button"
                      :title="copiedFieldKey === 'skill-name' ? '已复制' : '复制技能名称'"
                      :aria-label="copiedFieldKey === 'skill-name' ? '已复制' : '复制技能名称'"
                      @click="copyField('skill-name', skillResult.name)"
                    >
                      <span aria-hidden="true">⧉</span>
                    </button>
                  </div>
                </div>
                <div v-if="skillResult.content && !skillResult.error" class="detail-field">
                  <small class="detail-label">技能指令 · {{ skillResult.lineCount }} 行</small>
                  <div class="detail-value is-copyable is-multiline skill-instructions">
                    <div class="markdown-body" v-html="renderedSkillContent" />
                    <button
                      type="button"
                      class="field-copy-button"
                      :title="copiedFieldKey === 'skill-content' ? '已复制' : '复制技能指令'"
                      :aria-label="copiedFieldKey === 'skill-content' ? '已复制' : '复制技能指令'"
                      @click="copyField('skill-content', skillResult.content)"
                    >
                      <span aria-hidden="true">⧉</span>
                    </button>
                  </div>
                </div>
                <p v-else-if="skillResult.error" class="tool-error-note">{{ skillResult.error }}</p>
                <p v-else class="empty-detail">等待加载技能指令…</p>
              </section>

              <template v-else>
                <section
                  v-if="primaryInstruction"
                  class="primary-instruction detail-field"
                  :class="`is-${primaryInstruction.kind}`"
                >
                  <small class="detail-label">{{ primaryInstruction.label }}</small>
                  <div class="detail-value is-copyable">
                    <div v-if="primaryInstruction.kind === 'command'" class="command-line">
                      <span aria-hidden="true">$</span>
                      <code>{{ primaryInstruction.value }}</code>
                    </div>
                    <div
                      v-else
                      class="markdown-body instruction-copy"
                      v-html="renderedPrimaryInstruction"
                    />
                    <button
                      type="button"
                      class="field-copy-button"
                      :title="
                        copiedFieldKey === 'primary' ? '已复制' : `复制${primaryInstruction.label}`
                      "
                      :aria-label="
                        copiedFieldKey === 'primary' ? '已复制' : `复制${primaryInstruction.label}`
                      "
                      @click="copyField('primary', primaryInstruction.value)"
                    >
                      <span aria-hidden="true">⧉</span>
                    </button>
                  </div>
                </section>

                <ToolFieldTree v-if="secondaryFields.length" :fields="secondaryFields" />
              </template>

              <section
                v-if="
                  selectedCall.result &&
                  !isReadFileTool &&
                  !isQuestionTool &&
                  !isSearchTool &&
                  !isSkillTool
                "
                class="result-block detail-field"
              >
                <small class="detail-label">执行结果</small>
                <div class="detail-value is-copyable is-multiline">
                  <ToolFieldTree v-if="resultFields.length" :fields="resultFields" />
                  <div v-else class="markdown-body result-copy" v-html="renderedResult" />
                  <button
                    type="button"
                    class="field-copy-button"
                    :title="copiedFieldKey === 'result' ? '已复制' : '复制执行结果'"
                    :aria-label="copiedFieldKey === 'result' ? '已复制' : '复制执行结果'"
                    @click="copyField('result', selectedCall.result)"
                  >
                    <span aria-hidden="true">⧉</span>
                  </button>
                </div>
                <p v-if="resultTruncated" class="truncation-hint">
                  完整结果已保留，可通过复制获取。
                </p>
              </section>
              <p
                v-else-if="
                  !isReadFileTool &&
                  !isQuestionTool &&
                  !isSearchTool &&
                  !isSkillTool &&
                  (selectedCall.status === 'pending' || selectedCall.status === 'accepted')
                "
                class="empty-detail"
              >
                等待执行结果…
              </p>
            </template>
          </section>
          <p v-else key="empty" class="empty-detail">暂无可展示内容。</p>
        </Transition>

        <ul v-if="batch.terminations.length" class="termination-list" aria-label="执行终止提示">
          <li
            v-for="termination in batch.terminations"
            :key="`${termination.batchId}:${termination.code}`"
          >
            {{ terminationDisplay({ actor: 'system', code: termination.code, at: 0 }).label }}
          </li>
        </ul>
      </template>

      <section v-else-if="!batch" class="node-content">
        <section v-if="nodeThinking" class="thinking-block">
          <button
            type="button"
            class="thinking-toggle"
            :aria-expanded="thinkingOpen"
            @click="thinkingOpen = !thinkingOpen"
          >
            <span class="thinking-glyph" aria-hidden="true">✦</span>
            <span>思考</span>
            <span class="thinking-toggle-hint" aria-hidden="true">{{ thinkingOpen ? '−' : '+' }}</span>
          </button>
          <div v-if="thinkingOpen" class="thinking-body">
            <div class="markdown-body thinking-copy" v-html="renderedNodeThinking" />
          </div>
        </section>
        <section v-if="nodeDescription" class="actual-description detail-field">
          <small class="detail-label">说明</small>
          <div class="detail-value">
            <div class="markdown-body" v-html="renderedNodeDescription" />
          </div>
        </section>
        <template v-if="nodeContent">
          <div v-if="isUserNode" class="primary-content user-node-content">
            <template
              v-for="(segment, index) in nodeContentSegments"
              :key="`${segment.type}-${index}`"
            >
              <span
                v-if="segment.type === 'command'"
                class="node-command-token"
                :aria-label="`指令 ${segment.value}`"
              >
                <span class="node-command-token-kind" aria-hidden="true">指令</span>
                <span class="node-command-token-value">{{ segment.value }}</span>
              </span>
              <template v-else>
                {{ segment.type === 'role' ? `[[role:${segment.value}]]` : segment.value }}
              </template>
            </template>
          </div>
          <div v-else class="markdown-body primary-content" v-html="renderedNodeContent" />
        </template>
        <p v-else-if="!nodeDescription && !nodeThinking" class="empty-detail">暂无正文。</p>
        <p v-if="nodeTermination" class="termination-note" :class="`tone-${nodeTermination.tone}`">
          {{ nodeTermination.label }}
        </p>
      </section>
    </div>
  </aside>
</template>

<style scoped lang="less" src="./ExecutionNodePopover.styles.less"></style>
