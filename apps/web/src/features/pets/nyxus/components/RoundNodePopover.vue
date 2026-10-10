<script setup lang="ts">
import { computed, useAttrs } from 'vue'
import { useRenderedMarkdown } from '@/composables/useRenderedMarkdown'
import type { PositionedExecutionNode } from '../graph/executionLayout'
import type { ExecutionNode } from '../graph/executionGraph'
import type { ExecutionNodePopoverControllerProps } from './useExecutionNodePopoverController'
import ExecutionNodePopover from './ExecutionNodePopover.vue'

/**
 * 整轮（轮次档位）三段式详情：第一段用户提问（顶）、第二段左轮选中的内部成员
 * （复用 ExecutionNodePopover，全部弹窗 props 经 $attrs 透传）、第三段主 Agent
 * 最终结论（底）。节点本体仍为 40×40 图标，三段信息只在详情弹窗内呈现。
 */
defineOptions({ inheritAttrs: false })

const props = defineProps<{
  /** 轮次节点（kind === 'round'，含 fold.members 与 round 锚点）。 */
  roundNode: PositionedExecutionNode
  /** 左轮当前选中的内部成员（详情中段）；无内部步骤（纯问答轮次）时为 undefined。 */
  memberNode?: ExecutionNode
}>()

/** 其余弹窗 props/事件从父级透传；此处只做类型化以便 v-bind 通过类型检查。 */
const attrs = useAttrs() as ExecutionNodePopoverControllerProps & Record<string, unknown>

const opening = computed<ExecutionNode | undefined>(() => {
  const node = props.roundNode
  if (node.kind !== 'round' || !node.round || !node.fold) return undefined
  return node.fold.projectionNodes.find((item) => item.id === node.round!.openingNodeId)
})
const reply = computed<ExecutionNode | undefined>(() => {
  const node = props.roundNode
  if (node.kind !== 'round' || !node.round || !node.fold) return undefined
  return node.fold.projectionNodes.find((item) => item.id === node.round!.replyNodeId)
})
const renderedOpening = useRenderedMarkdown(
  computed(() => opening.value?.content ?? ''),
  { mode: 'full' },
)
const renderedReply = useRenderedMarkdown(computed(() => reply.value?.content ?? ''), {
  mode: 'full',
})
</script>

<template>
  <div class="round-detail" role="group" aria-label="整轮详情">
    <section v-if="opening" class="round-section is-question">
      <small class="round-section-label">用户提问</small>
      <div class="markdown-body round-section-copy" v-html="renderedOpening.html.value" />
    </section>
    <ExecutionNodePopover v-if="memberNode" v-bind="attrs" :node="memberNode" />
    <section v-if="reply" class="round-section is-reply">
      <small class="round-section-label">最终结论</small>
      <div class="markdown-body round-section-copy" v-html="renderedReply.html.value" />
    </section>
  </div>
</template>

<style scoped lang="less">
.round-detail {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
  min-width: 0;
  height: 100%;
  box-sizing: border-box;

  // 常驻（pinned）时成员弹窗占满剩余高度并自滚动，提问/结论两段保持固定。
  :deep(.node-popover) {
    flex: 1 1 auto;
    min-height: 0;
  }
}

.round-section {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  border: 1px solid var(--nx-border-soft);
  border-radius: 6px;
  background: color-mix(in srgb, var(--nx-bg) 60%, transparent);
  flex: 0 0 auto;
  min-width: 0;
}

.round-section-label {
  font-size: 11px;
  line-height: 1.4;
  color: var(--nx-text-soft);
  opacity: 0.85;
}

.round-section-copy {
  font-size: 12px;
  line-height: 1.55;
  color: var(--nx-text);
  max-height: 96px;
  overflow-y: auto;
  min-width: 0;
  word-break: break-word;
}
</style>
