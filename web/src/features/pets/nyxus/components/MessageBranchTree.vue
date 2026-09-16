<script setup lang="ts">
import {
  useMessageBranchTreeController,
  type MessageBranchTreeControllerProps,
  type MessageBranchTreeControllerEmits,
} from './useMessageBranchTreeController'
import { useOverlayTransitionHooks } from '@/composables/useOverlayAnimation'
import { computed, ref, toRef } from 'vue'
import { useTreePointerHighlight } from './useTreePointerHighlight'
const props = withDefaults(defineProps<MessageBranchTreeControllerProps>(), {
  foldMode: 'partial',
  layoutMode: 'timeline',
  presentationMode: 'horizontal-signal',
  suspended: false,
  sidePanelTitle: '',
})
const emit = defineEmits<MessageBranchTreeControllerEmits>()
const controller = useMessageBranchTreeController(props, emit)
const detailMotion = useOverlayTransitionHooks('panel')
const drawerMotion = useOverlayTransitionHooks('drawer')
/** 侧边抽屉标题兜底（工作台总会传入；代际弹窗等无侧栏场景不渲染抽屉）。 */
const drawerTitle = computed(() => props.sidePanelTitle || '侧边面板')
const {
  AnchoredRunCrt,
  ExecutionNodePopover,
  FoldTabRail,
  GenerationTreeDialog,
  NodePaperStack,
  activateNode,
  agents,
  canvas,
  closeCrt,
  closeNodeDetail,
  crtById,
  crtPlacements,
  crtVisibility,
  defaultPopoverAnchorIds,
  defaultPopoverViews,
  detailAnchorEl,
  detailAnchorStyle,
  detailDisplayNode,
  detailFoldMember,
  detailMaxHeight,
  detailNode,
  detailPinned,
  detailWrap,
  detailPlacement,
  detailRelatedEdges,
  cycleDetailSize,
  detailSizeLabel,
  dragActionPopover,
  dragCrt,
  dragDetailPopover,
  finishDetailDrag,
  focusCrt,
  focusNode,
  focusRelativeNode,
  foldRailSide,
  generationDialogIndex,
  gpuNodeAccent,
  gpuNodeHitStyle,
  gpuRenderError,
  hasNewTail,
  hideNodeDetail,
  keepNodeDetailOpen,
  leaveNodeDetail,
  nodeAriaLabel,
  nodeTitle,
  onFoldRailInteraction,
  onNodePointerDown,
  overlayPlacements,
  paperCurrentIndex,
  paperEntries,
  paperGraph,
  paperHasNewTail,
  persistentGraph,
  pinCrt,
  pinnedCrtIds,
  pixiMountRef,
  recordActionPopoverHeight,
  recoverGraph,
  recoveringGraph,
  recoveryError,
  requestBranch,
  resetLayout,
  returnToBottom,
  returnToLatestPaper,
  selectActionCall,
  selectFoldMember,
  selectPaperIndex,
  selectedActionCall,
  selectedCallId,
  showNodeDetail,
  toggleDetailWrap,
  unpinCrt,
  unreadFoldMembers,
  vMeasureHeight,
  viewportRef,
  viewportSize,
  visibleInteractiveNodes,
} = controller
const pointerHighlightRef = ref<HTMLElement | null>(null)
useTreePointerHighlight({
  host: viewportRef,
  layer: pointerHighlightRef,
  suspended: toRef(props, 'suspended'),
})
// 卡牌/流程图/阅读器右侧抽屉：以 --tree-drawer-width 覆盖节点树，左缘拖拽/键盘调宽。
// 宽度存百分比（相对画布容器），跨开关抽屉保留；切换会话重挂载后回到默认 50%。
const DRAWER_MIN_PX = 300
const DRAWER_MIN_PCT = 24
const DRAWER_MAX_PCT = 88
const drawerWidthPct = ref(50)
const drawerWidthLimits = computed(() => {
  const containerWidth = viewportSize.value.width
  const minPct = containerWidth > 0 ? (DRAWER_MIN_PX / containerWidth) * 100 : DRAWER_MIN_PCT
  return {
    min: Math.min(DRAWER_MAX_PCT, Math.max(DRAWER_MIN_PCT, minPct)),
    max: DRAWER_MAX_PCT,
  }
})
function clampDrawerWidth(pct: number): number {
  return Math.min(drawerWidthLimits.value.max, Math.max(drawerWidthLimits.value.min, pct))
}
let drawerDragStart: { x: number; pct: number } | null = null
function onDrawerResizeDown(event: PointerEvent): void {
  if (event.button !== 0) return
  event.preventDefault()
  event.stopPropagation()
  drawerDragStart = { x: event.clientX, pct: drawerWidthPct.value }
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}
function onDrawerResizeMove(event: PointerEvent): void {
  if (!drawerDragStart) return
  const containerWidth = viewportSize.value.width
  if (containerWidth <= 0) return
  const deltaPct = ((event.clientX - drawerDragStart.x) / containerWidth) * 100
  // 右侧抽屉：手柄在抽屉左缘，向左拖 = 变宽。
  drawerWidthPct.value = clampDrawerWidth(drawerDragStart.pct - deltaPct)
}
function onDrawerResizeEnd(): void {
  drawerDragStart = null
}
function onDrawerResizeKeydown(event: KeyboardEvent): void {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const { min, max } = drawerWidthLimits.value
  if (event.key === 'Home') drawerWidthPct.value = min
  else if (event.key === 'End') drawerWidthPct.value = max
  // 右侧抽屉：左箭头 = 变宽（向左扩），右箭头 = 变窄。
  else
    drawerWidthPct.value = clampDrawerWidth(
      drawerWidthPct.value + (event.key === 'ArrowLeft' ? 5 : -5),
    )
}
/** 遮罩 / ✕ 关闭侧边抽屉 → 父级（工作台）把 sidePanel 置回 none。 */
function closeSidePanel(): void {
  emit('close-side-panel')
}
defineExpose({ resetLayout: controller.resetLayout })
</script>

<template>
  <section
    class="execution-tree"
    :class="{ 'has-side-panel': sidePanelOpen }"
    :style="{ '--tree-drawer-width': `${clampDrawerWidth(drawerWidthPct)}%` }"
    aria-label="任务执行节点树"
  >
    <Transition
      :css="false"
      @before-enter="drawerMotion.onBeforeEnter"
      @enter="drawerMotion.onEnter"
      @leave="drawerMotion.onLeave"
      @enter-cancelled="drawerMotion.onEnterCancelled"
      @leave-cancelled="drawerMotion.onLeaveCancelled"
    >
      <div v-if="sidePanelOpen" key="tree-drawer" class="tree-drawer-layer">
        <div class="tree-drawer-mask" aria-hidden="true" @pointerdown="closeSidePanel" />
        <aside
          class="tree-drawer"
          data-motion-panel
          role="dialog"
          aria-modal="true"
          :aria-label="drawerTitle"
        >
          <header class="tree-drawer-head">
            <span class="tree-drawer-title">{{ drawerTitle }}</span>
            <button
              type="button"
              class="tree-drawer-close"
              aria-label="关闭侧边抽屉"
              title="关闭"
              @click="closeSidePanel"
            >
              ✕
            </button>
          </header>
          <div class="tree-drawer-body">
            <NodePaperStack
              v-if="paperMode"
              :entries="paperEntries"
              :edges="paperGraph.edges"
              :current-index="paperCurrentIndex"
              :max-height="Math.min(640, Math.max(160, viewportSize.height - 150))"
              :has-new-tail="paperHasNewTail"
              :detail-branch-available="detailBranchAvailable"
              :detail-branch-unavailable-reason="detailBranchUnavailableReason"
              :sense-tools="agents.senseTools"
              @select="selectPaperIndex"
              @latest="returnToLatestPaper"
              @branch="requestBranch"
            />
            <slot v-else name="side-panel" />
          </div>
        </aside>
        <span
          class="tree-drawer-resize"
          role="separator"
          tabindex="0"
          aria-orientation="vertical"
          aria-label="调整侧边面板宽度"
          :aria-valuemin="Math.round(drawerWidthLimits.min)"
          :aria-valuemax="Math.round(drawerWidthLimits.max)"
          :aria-valuenow="Math.round(drawerWidthPct)"
          @pointerdown="onDrawerResizeDown"
          @pointermove="onDrawerResizeMove"
          @pointerup="onDrawerResizeEnd"
          @pointercancel="onDrawerResizeEnd"
          @lostpointercapture="onDrawerResizeEnd"
          @keydown="onDrawerResizeKeydown"
        />
      </div>
    </Transition>
    <div
      ref="viewportRef"
      class="tree-viewport"
      @pointerdown="canvas.onPointerDown"
      @pointermove="canvas.onPointerMove"
      @pointerup="canvas.onPointerUp"
      @pointercancel="canvas.onPointerUp"
      @lostpointercapture="canvas.onPointerUp"
      @wheel.prevent="canvas.onWheel"
    >
      <div ref="pixiMountRef" class="tree-gpu-surface" role="img" aria-label="任务执行节点图" />
      <div class="tree-overlay" aria-live="polite">
        <div ref="pointerHighlightRef" class="tree-pointer-highlight" aria-hidden="true" />
        <div class="gpu-node-hit-layer">
          <button
            v-for="node in visibleInteractiveNodes"
            :key="`${node.id}:hit-target`"
            v-memo="[
              node.id,
              node.x,
              node.y,
              nodeTitle(node),
              node.status,
              gpuNodeAccent(node),
              canvas.scale.value,
              canvas.offsetX.value,
              canvas.offsetY.value,
            ]"
            type="button"
            class="gpu-node-hit-target"
            :style="gpuNodeHitStyle(node)"
            :aria-label="nodeAriaLabel(node)"
            :data-execution-node-id="node.id"
            @pointerdown="onNodePointerDown($event, node); canvas.onPointerDown($event)"
            @pointerenter="showNodeDetail(node)"
            @pointerleave="hideNodeDetail(node)"
            @focus="focusNode(node)"
            @blur="hideNodeDetail(node)"
            @keydown.enter.prevent.stop="activateNode(node)"
            @keydown.space.prevent.stop="activateNode(node)"
            @keydown.down.prevent.stop="focusRelativeNode(node.id, 'down')"
            @keydown.right.prevent.stop="focusRelativeNode(node.id, 'right')"
            @keydown.up.prevent.stop="focusRelativeNode(node.id, 'up')"
            @keydown.left.prevent.stop="focusRelativeNode(node.id, 'left')"
            @keydown.home.prevent.stop="focusRelativeNode(node.id, 'first')"
            @keydown.end.prevent.stop="focusRelativeNode(node.id, 'last')"
            @click.stop="activateNode(node)"
          />
        </div>
        <div v-if="gpuRenderError" class="graph-diagnostic" role="alert">
          <span>GPU 图形渲染器不可用</span>
          <small>{{ gpuRenderError }}</small>
        </div>
        <div class="tree-float-actions">
          <button
            v-if="canvas.userPanned.value"
            type="button"
            class="tree-float-action"
            aria-label="复位视图"
            title="复位视图"
            @pointerdown.stop
            @click.stop="resetLayout"
          >
            ↻ 复位视图
          </button>
          <button
            v-if="canvas.userPanned.value && hasNewTail"
            type="button"
            class="tree-return-tail"
            @pointerdown.stop
            @click.stop="returnToBottom"
          >
            回到最新
          </button>
        </div>
        <div v-if="persistentGraph.diagnostics.length" class="graph-diagnostic" role="alert">
          <span>执行图数据异常（{{ persistentGraph.diagnostics.length }}）</span>
          <button type="button" :disabled="recoveringGraph" @click.stop="recoverGraph">
            {{ recoveringGraph ? '同步中…' : '重新同步' }}
          </button>
          <small v-if="recoveryError">{{ recoveryError }}</small>
        </div>
        <svg
          v-if="overlayPlacements.length"
          class="crt-anchor-lines"
          width="100%"
          height="100%"
          aria-hidden="true"
        >
          <line
            v-for="placement in overlayPlacements"
            :key="`${placement.id}:line`"
            :x1="placement.line.from.x"
            :y1="placement.line.from.y"
            :x2="placement.line.to.x"
            :y2="placement.line.to.y"
          />
        </svg>
        <div
          v-for="placement in crtPlacements"
          :key="placement.id"
          class="run-crt-anchor"
          :class="`is-${placement.placement}`"
          :style="{
            left: `${placement.left}px`,
            top: `${placement.top}px`,
            zIndex: `calc(var(--nx-z-run-crt) + ${placement.windowZ})`,
          }"
        >
          <AnchoredRunCrt
            v-if="crtById.get(placement.id)"
            :card="crtById.get(placement.id)!"
            :pinned="pinnedCrtIds.has(placement.id)"
            :max-height="placement.panel.height"
            @pin="pinCrt(placement.id)"
            @unpin="unpinCrt(placement.id)"
            @close="closeCrt(placement.id)"
            @focus="focusCrt(placement.id)"
            @drag="dragCrt(placement.id, $event)"
          />
        </div>
        <div v-if="crtVisibility.hiddenPassive" class="crt-overflow-summary" role="status">
          +{{ crtVisibility.hiddenPassive }} 个后台运行
        </div>
        <div
          v-for="view in defaultPopoverViews"
          :key="view.model.id"
          v-measure-height="recordActionPopoverHeight(view.model.id)"
          :style="{
            left: `${view.placement.left}px`,
            top: `${view.placement.top}px`,
            zIndex: 'var(--nx-z-blocking-interaction)',
          }"
          class="node-detail-anchor is-action-default"
          :class="`is-${view.placement.placement}`"
          @pointerdown.stop
          @pointermove.stop
          @pointerup.stop
          @click.stop
          @wheel.stop
        >
          <ExecutionNodePopover
            :node="view.display"
            :fold-node="view.anchor.kind === 'fold' ? view.anchor : undefined"
            :related-edges="view.relatedEdges"
            :pinned="false"
            :max-height="view.placement.panel.height"
            :selected-call-id="selectedActionCall(view.model)"
            :chat-id="view.model.chatId"
            :question="view.model.question"
            :draggable="true"
            @select-call="selectActionCall(view.model.id, $event)"
            @drag="dragActionPopover(view.model.id, $event)"
          />
        </div>
        <Transition
          :css="false"
          @before-enter="detailMotion.onBeforeEnter"
          @enter="detailMotion.onEnter"
          @leave="detailMotion.onLeave"
          @enter-cancelled="detailMotion.onEnterCancelled"
          @leave-cancelled="detailMotion.onLeaveCancelled"
        >
          <div
            v-if="detailNode && detailAnchorStyle && !defaultPopoverAnchorIds.has(detailNode.id)"
            ref="detailAnchorEl"
            :style="detailAnchorStyle"
            class="node-detail-anchor"
            :class="detailPlacement ? `is-${detailPlacement.placement}` : undefined"
            @pointerenter="keepNodeDetailOpen"
            @pointerleave="leaveNodeDetail"
            @pointerdown.stop
            @pointermove.stop
            @pointerup.stop
            @wheel.stop
          >
            <FoldTabRail
              v-if="detailNode.kind === 'fold' && detailNode.fold && detailPlacement"
              :members="detailNode.fold.members"
              :selected-member-id="detailFoldMember?.id"
              :unread-count="unreadFoldMembers.get(detailNode.id)"
              :anchor-x="detailPlacement.nodeOffset.x"
              :anchor-y="detailPlacement.nodeOffset.y"
              :side="foldRailSide"
              @select="detailNode && selectFoldMember(detailNode.id, $event)"
              @interaction="detailNode && onFoldRailInteraction(detailNode.id, $event)"
            />
            <ExecutionNodePopover
              v-if="detailDisplayNode"
              :node="detailDisplayNode"
              :fold-node="detailNode.kind === 'fold' ? detailNode : undefined"
              :related-edges="detailRelatedEdges"
              :pinned="detailPinned"
              :max-height="detailMaxHeight"
              :selected-call-id="selectedCallId"
              :detail-branch-available="detailBranchAvailable"
              :detail-branch-unavailable-reason="detailBranchUnavailableReason"
              :draggable="true"
              :wrap="detailWrap"
              :size-label="detailSizeLabel"
              @select-call="selectedCallId = $event"
              @branch="requestBranch"
              @close="closeNodeDetail"
              @drag="dragDetailPopover"
              @drag-end="finishDetailDrag"
              @toggle-wrap="toggleDetailWrap"
              @cycle-size="cycleDetailSize"
            />
          </div>
        </Transition>
      </div>
    </div>
    <GenerationTreeDialog
      v-if="generationDialogIndex !== undefined"
      :root-chat-id="rootChatId"
      :generation-index="generationDialogIndex"
      @close="generationDialogIndex = undefined"
    />
  </section>
</template>

<style scoped lang="less" src="./MessageBranchTree.styles.less"></style>
