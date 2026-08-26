<script setup lang="ts">
import { useHistoryDrawerPanelController, type HistoryDrawerPanelControllerProps } from './useHistoryDrawerPanelController'
const props = defineProps<HistoryDrawerPanelControllerProps>()
const controller = useHistoryDrawerPanelController(props)
const {
  ContextUsageBar, MessageBubble, MotionDiv, PromptSnapshotTip, VirtualScroll,
  activateCurrentBranch, activatingBranch, activeGenerationIndex, agents, batchReloading,
  callerIsMaster, callerPetFace, callerPetName, cascadeOptions, cascadeProps, closeGenerationLayer,
  copied, copyChatId, currentTaskBranch, detailBranchStartIndex, dropdownAsTitle, estimateSize,
  faceStateClass, generationError, generationHistory, generationLoading, generationPayload,
  generationScrollRef, generationSummaryLine, getHistoryItemKey, history, isLastSubReply, layout,
  loaded, loadingAgents, manager, masterPetName, onHandlePointerDown, onHandlePointerMove,
  onHandlePointerUp, onJumpToSpawn, onPromptSnapShow, onRailJump, onSwitchCascade,
  openGenerationCard, packedGenerations, panelFullStyle, pet, previewOf, previewTooltip,
  previewTooltipStyle, promptSnap, ref, removeOutgoing, retryOutgoing, runtimeForItem,
  scrollToBottomSmooth, scrollToTopSmooth, showAgentLoading, showDetailBranchDivider, subPetFace,
  subPetName, subPetType, taskTimeline, titleText, userAvatarCaption, userMarks, virtualScrollRef,
} = controller
</script>

<template>
  <MotionDiv
    class="drawer-panel"
    :style="panelFullStyle"
    :initial="{ x: '100%' }"
    :animate="{ x: 0 }"
    :transition="{ duration: 0.24, ease: 'easeOut' }"
    role="dialog"
    aria-modal="true"
    :aria-label="titleText"
  >
    <div
      class="resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label="拖拽调整宽度"
      @pointerdown="onHandlePointerDown"
      @pointermove="onHandlePointerMove"
      @pointerup="onHandlePointerUp"
    />
    <header class="drawer-head">
      <div class="title-block">
        <span v-if="!dropdownAsTitle" class="title">{{ titleText }}</span>
        <!-- 会话级联切换：dock 恒显示平铺当前任务分支一级（主流程/继续/解释）；overlay 两级（一级任务、二级分支，二级去除解释） -->
        <el-cascader
          v-if="dropdownAsTitle"
          class="cascade-switch"
          size="small"
          :model-value="props.chatId"
          :options="cascadeOptions"
          :props="cascadeProps"
          placeholder="切换会话"
          aria-label="切换会话或任务分支"
          @change="onSwitchCascade"
        />
        <button
          v-if="
            currentTaskBranch &&
            currentTaskBranch.kind !== 'detail' &&
            currentTaskBranch.branchId !== taskTimeline?.activeBranchId
          "
          type="button"
          class="activate-branch-btn"
          :disabled="activatingBranch"
          title="将当前分支切换为任务主流程；不会复制消息或启动执行"
          @click="activateCurrentBranch"
        >
          设为主流程
        </button>
        <button
          type="button"
          class="copy-id-btn"
          :class="{ copied }"
          :title="copied ? '已复制' : '复制 ID'"
          aria-label="复制 chatId"
          @click="copyChatId"
        >
          <span class="copy-glyph">{{ copied ? '✓' : '📋' }}</span>
        </button>
      </div>
      <div v-if="isTop" class="head-actions">
        <button
          type="button"
          class="tool-collapse-btn"
          :class="{ active: agents.senseCallsCollapsed }"
          :aria-pressed="agents.senseCallsCollapsed"
          title="折叠工具调用为标签（hover 标签查看详情）"
          @click="agents.setSenseCallsCollapsed(!agents.senseCallsCollapsed)"
        >
          🧰
        </button>
        <div
          v-if="layout === 'group'"
          class="display-mode-seg"
          role="group"
          aria-label="子 agent 消息显示模式"
        >
          <button
            type="button"
            class="mode-btn"
            :class="{ active: agents.subagentDisplay === 'show' }"
            :aria-pressed="agents.subagentDisplay === 'show'"
            title="不折叠子 Agent 消息"
            @click="agents.setSubagentDisplay('show')"
          >
            👥</button
          ><button
            type="button"
            class="mode-btn"
            :class="{ active: agents.subagentDisplay === 'collapse' }"
            :aria-pressed="agents.subagentDisplay === 'collapse'"
            title="折叠子 Agent 消息"
            @click="agents.setSubagentDisplay('collapse')"
          >
            🙈</button
          ><button
            type="button"
            class="mode-btn"
            :class="{ active: agents.subagentDisplay === 'round' }"
            :aria-pressed="agents.subagentDisplay === 'round'"
            title="只保留用户和大模型单个轮次最后一条消息"
            @click="agents.setSubagentDisplay('round')"
          >
            🎯
          </button>
        </div>
        <button type="button" class="close-btn" aria-label="Close" @click="manager.closeTop()">
          ✕
        </button>
      </div>
    </header>
    <ContextUsageBar
      v-if="pet?.contextBreakdown?.total"
      :usage="pet?.contextUsage ?? 0"
      :breakdown="pet?.contextBreakdown"
      variant="inline"
    >
      <template #label>
        <el-popover
          trigger="hover"
          placement="bottom-start"
          :width="460"
          popper-class="prompt-snapshot-popper"
          :show-after="200"
          @show="onPromptSnapShow"
        >
          <template #reference>
            <span class="usage-label usage-label-hover">上下文</span>
          </template>
          <PromptSnapshotTip
            v-if="promptSnap"
            :system-prompt="promptSnap.systemPrompt"
            :tools="promptSnap.tools"
            :status="promptSnap.status"
            :error="promptSnap.error"
          />
        </el-popover>
      </template>
    </ContextUsageBar>

    <div class="drawer-body">
      <!-- 打包代际卡片条：与树中 pack 节点同数据，点击开二层代际抽屉 -->
      <div
        v-if="packedGenerations.length"
        class="generation-cards"
        role="group"
        aria-label="打包历史"
      >
        <button
          v-for="gen in packedGenerations"
          :key="gen.index"
          type="button"
          class="generation-card"
          :class="{ active: gen.index === activeGenerationIndex }"
          :title="gen.summary"
          @click="openGenerationCard(gen.index)"
        >
          <span class="generation-card-summary">{{ generationSummaryLine(gen) }}</span>
          <span class="generation-card-meta">
            {{ gen.nodeCount }} 节点 · {{ gen.trigger === 'auto' ? '自动' : '手动' }}
          </span>
        </button>
      </div>
      <div v-if="!loaded && history.length === 0 && !showAgentLoading" class="loading-row">
        载入历史…
      </div>
      <div v-else-if="loaded && history.length === 0 && !showAgentLoading" class="empty-row">
        暂无历史
      </div>
      <VirtualScroll
        v-else-if="history.length > 0"
        ref="virtualScrollRef"
        class="history-list"
        :items="history"
        :item-key="getHistoryItemKey"
        :estimate-size="estimateSize"
        :default-render-count="12"
      >
        <template #default="{ index }">
          <div :class="{ 'detail-context-item': index < detailBranchStartIndex }">
            <div
              v-if="showDetailBranchDivider && index === detailBranchStartIndex"
              class="detail-branch-divider"
              role="separator"
              aria-label="解释分支开始"
            >
              <span>以上为创建解释分支时的前置对话</span>
              <strong>以下为解释分支</strong>
            </div>
            <MessageBubble
              :item="history[index]!"
              :layout="layout"
              :collapse-sense-calls="agents.senseCallsCollapsed"
              :master-pet-name="masterPetName"
              :sub-pet-name="subPetName(history[index]!)"
              :sub-pet-face="subPetFace(history[index]!)"
              :sub-pet-type="subPetType(history[index]!)"
              :caller-pet-face="callerPetFace(history[index]!)"
              :caller-pet-name="callerPetName(history[index]!)"
              :caller-is-master="callerIsMaster(history[index]!)"
              :show-master-badge="isLastSubReply(history[index]!)"
              :fallback-runtime="runtimeForItem(history[index]!)"
              :user-avatar-caption="userAvatarCaption"
              @jump-to-spawn="onJumpToSpawn"
              @retry-message="retryOutgoing"
              @remove-message="removeOutgoing"
            />
          </div>
        </template>

        <!-- 滚动条轨道上的 user 消息 minimap 标记：hover 预览 + 点击跳转（VirtualScroll 暴露 ratioOf/trackHeight） -->
        <template #scrollbar-mark="{ ratioOf, trackHeight }">
          <el-tooltip
            v-for="m in userMarks"
            :key="m.item.msgId ?? `idx-${m.idx}`"
            placement="left"
            :show-after="120"
          >
            <template #content>
              <div :style="previewTooltipStyle">{{ previewTooltip(m.item.content) }}</div>
            </template>
            <button
              type="button"
              class="scrollbar-mark"
              :style="{ top: `${ratioOf(m.idx) * trackHeight}px` }"
              :aria-label="`跳转到用户消息: ${previewOf(m.item.content, 30)}`"
              @pointerdown.stop
              @click.stop="onRailJump(m.idx)"
            />
          </el-tooltip>
        </template>
      </VirtualScroll>

      <!-- 滚动顶部 / 底部按钮：堆叠在 drawer-body 底部右侧（绝对定位，不挤压列表布局） -->
      <div v-if="history.length > 0" class="scroll-actions">
        <button
          type="button"
          class="scroll-btn"
          aria-label="滚动到顶部"
          title="滚动到顶部"
          @click="scrollToTopSmooth"
        >
          👆
        </button>
        <button
          type="button"
          class="scroll-btn"
          aria-label="滚动到底部"
          title="滚动到底部"
          @click="scrollToBottomSmooth"
        >
          👇
        </button>
      </div>
      <div v-if="showAgentLoading" class="agent-loading-list" aria-live="polite">
        <div v-for="entry in loadingAgents" :key="entry.chatId" class="agent-loading-row">
          <span class="agent-loading-face" :class="faceStateClass(entry)">{{ entry.face }}</span>
          <span class="agent-loading-copy">
            <b>{{ entry.name }}</b>
            <small>{{ entry.running ? '正在输入…' : '已完成，等待其他 Agent…' }}</small>
          </span>
          <span v-if="entry.running" class="typing-dots" aria-hidden="true"> <i /><i /><i /> </span>
          <span v-else class="agent-done" aria-hidden="true">✓</span>
        </div>
        <div v-if="batchReloading" class="batch-loading">正在整理全部 Agent 的完整内容…</div>
      </div>
    </div>

    <!-- 二层代际抽屉：覆盖首层（栈深恒 ≤2，二层内无下钻/无分支入口） -->
    <div
      v-if="activeGenerationIndex !== undefined"
      class="generation-layer"
      role="dialog"
      aria-modal="true"
      :aria-label="`打包历史 第 ${activeGenerationIndex} 代`"
    >
      <header class="generation-layer-head">
        <span class="generation-layer-title">
          打包历史 · 第 {{ activeGenerationIndex }} 代
          <small v-if="generationPayload">
            {{ generationPayload.generation.nodeCount }} 节点 ·
            {{ generationPayload.generation.trigger === 'auto' ? '自动压缩' : '手动压缩' }}
          </small>
        </span>
        <button
          type="button"
          class="close-btn generation-layer-close"
          aria-label="关闭打包历史"
          @click="closeGenerationLayer"
        >
          ✕
        </button>
      </header>
      <div class="generation-layer-body">
        <div v-if="generationLoading" class="loading-row">载入代际历史…</div>
        <div v-else-if="generationError" class="empty-row" role="alert">{{ generationError }}</div>
        <div v-else-if="generationHistory.length === 0" class="empty-row">该代无对话内容</div>
        <VirtualScroll
          v-else
          ref="generationScrollRef"
          class="history-list"
          :items="generationHistory"
          :item-key="getHistoryItemKey"
          :estimate-size="estimateSize"
          :default-render-count="12"
        >
          <template #default="{ index }">
            <MessageBubble
              :item="generationHistory[index]!"
              layout="group"
              :collapse-sense-calls="agents.senseCallsCollapsed"
              :master-pet-name="masterPetName"
              :sub-pet-name="subPetName(generationHistory[index]!)"
              :sub-pet-face="subPetFace(generationHistory[index]!)"
              :sub-pet-type="subPetType(generationHistory[index]!)"
              :caller-pet-face="callerPetFace(generationHistory[index]!)"
              :caller-pet-name="callerPetName(generationHistory[index]!)"
              :caller-is-master="callerIsMaster(generationHistory[index]!)"
              :show-master-badge="isLastSubReply(generationHistory[index]!)"
              :fallback-runtime="runtimeForItem(generationHistory[index]!)"
              :user-avatar-caption="userAvatarCaption"
            />
          </template>
        </VirtualScroll>
      </div>
    </div>
  </MotionDiv>
</template>

<style scoped lang="less" src="./HistoryDrawerPanel.styles.less"></style>
