<script setup lang="ts">
/** Global settings cards share a measured scatter layout and draft. */
import { computed, provide, ref, watch } from 'vue'
import type { ConfigDto } from '@/application/backend/public'
import TabShell from '@/features/agent/settings/components/TabShell.vue'
import { SCATTER_KEY, useCardScatter, type GlobalCardAnchor } from '../useCardScatter'
import ScatterCard from './cards/ScatterCard.vue'
import SupervisionCard from './cards/SupervisionCard.vue'
import EditorCard from './cards/EditorCard.vue'
import LimitsCard from './cards/LimitsCard.vue'
import LoggerCard from './cards/LoggerCard.vue'
import CompressionCard from './cards/CompressionCard.vue'
import MemoryCard from './cards/MemoryCard.vue'
import MotionCard from './cards/MotionCard.vue'

const props = defineProps<{ draft: ConfigDto }>()

/** memory 段可能未在 config.yaml 中定义（config.get 返回 undefined），初始化双层空白对象供 v-model 绑定。 */
watch(
  () => props.draft.memory,
  (mem) => {
    if (!mem) {
      props.draft.memory = { global: {}, workspace: {} }
    } else {
      if (!mem.global) mem.global = {}
      if (!mem.workspace) mem.workspace = {}
    }
  },
  { immediate: true },
)

/** 模块墙需要每个拼图区都有内容；缺省段初始化为空配置，仍由各字段 placeholder 表达系统默认值。 */
watch(
  () => props.draft.global,
  (global) => {
    if (!global.logger) global.logger = {}
    if (!global.file_compression) global.file_compression = {}
    if (!global.watchdog) global.watchdog = {}
  },
  { immediate: true },
)

/** 画布容器（.global-canvas）。 */
const canvasRef = ref<HTMLElement | null>(null)

/** 当前实际渲染的卡 anchor 顺序（logger / compression 按配置 v-if 动态出现）。决定 cardNumber 编号 + entry 顺序。 */
const visibleAnchors = computed<GlobalCardAnchor[]>(() => {
  const out: GlobalCardAnchor[] = ['default', 'editor', 'limits']
  if (props.draft.global.logger) out.push('logger')
  if (props.draft.global.file_compression) out.push('compression')
  out.push('memory-global', 'memory-workspace', 'motion')
  return out
})

const scatter = useCardScatter(canvasRef, visibleAnchors)
provide(SCATTER_KEY, scatter)

const { ready, isActive, activeAnchor, cardNumber, raise } = scatter
</script>

<template>
  <TabShell tab-key="global">
    <template #hints>
      <p class="sect-hint">
        所有会话共用的运行规则。留空的数值将使用系统默认值，输入后才会覆盖默认设置。
      </p>
      <p class="sect-hint">
        卡片可部分遮挡；点击卡片或左下数字置顶，长按空白处拿起并在画布内自由拖动。
      </p>
    </template>

    <div ref="canvasRef" class="global-canvas" :class="{ 'is-ready': ready }">
      <ScatterCard v-slot="{ no }" anchor="default" accent="var(--accent)">
        <SupervisionCard :global="draft.global" :no="no" />
      </ScatterCard>

      <ScatterCard v-slot="{ no }" anchor="editor" accent="var(--accent)">
        <EditorCard :global="draft.global" :no="no" />
      </ScatterCard>

      <ScatterCard v-slot="{ no }" anchor="limits" accent="var(--accent)">
        <LimitsCard :global="draft.global" :no="no" />
      </ScatterCard>

      <ScatterCard
        v-if="draft.global.logger"
        v-slot="{ no }"
        anchor="logger"
        accent="var(--accent)"
      >
        <LoggerCard :logger="draft.global.logger!" :no="no" />
      </ScatterCard>

      <ScatterCard
        v-if="draft.global.file_compression"
        v-slot="{ no }"
        anchor="compression"
        accent="var(--accent)"
      >
        <CompressionCard :compression="draft.global.file_compression!" :no="no" />
      </ScatterCard>

      <ScatterCard v-slot="{ no }" anchor="memory-global" accent="var(--accent)">
        <MemoryCard scope="global" :memory="draft.memory!" :no="no" />
      </ScatterCard>

      <ScatterCard v-slot="{ no }" anchor="memory-workspace" accent="var(--accent)">
        <MemoryCard scope="workspace" :memory="draft.memory!" :no="no" />
      </ScatterCard>
      <ScatterCard v-slot="{ no }" anchor="motion" accent="var(--accent)">
        <MotionCard :no="no" />
      </ScatterCard>
    </div>

    <!-- 左下数字索引：Teleport 到弹窗 footer 左侧（关闭/保存之左）；点数字置顶对应卡 -->
    <Teleport defer to="#settings-footer-nav">
      <div v-if="isActive" class="global-card-index">
        <button
          v-for="a in visibleAnchors"
          :key="a"
          type="button"
          class="global-card-no"
          :class="{ active: activeAnchor === a }"
          :aria-label="`置顶卡片 ${cardNumber(a)}`"
          @click.stop="raise(a)"
        >
          {{ cardNumber(a) }}
        </button>
      </div>
    </Teleport>
  </TabShell>
</template>

<style scoped lang="less">
.global-canvas {
  position: relative;
  flex: 1 1 auto;
  height: 100%;
  min-height: 0;
  min-width: 0;
  width: 100%;
  box-sizing: border-box;
}
.global-canvas:not(.is-ready) :deep(.neon-block) {
  opacity: 0;
}
.global-card-index {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.global-card-no {
  min-width: 24px;
  height: 24px;
  padding: 0 5px;
  border: 1px solid var(--border);
  border-radius: 0;
  background: var(--surface-soft);
  color: var(--ink);
  font: 400 12px/22px monospace;
  cursor: pointer;
}
.global-card-no:hover,
.global-card-no.active {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
}
</style>

<style lang="less">
.shell-scroll:has(> .global-canvas) {
  overflow: hidden;
  padding-right: 0;
  gap: 0;
}
</style>
