<script setup lang="ts">
/**
 * GlobalTab：全局配置（config.global）的散落编排器。
 *
 * 职责分离后只承担「交互编排」：
 *  - 持有画布容器（canvasRef）+ 可见卡顺序（visibleAnchors）+ useCardScatter 散落引擎。
 *  - provide(SCATTER_KEY) 把散落 API 注入各 ScatterCard（交互壳），业务卡片不感知散落细节。
 *  - 初始化可选段（memory 双层 / logger / file_compression / watchdog）保证子卡 v-model 可绑。
 *  - 左下数字索引 Teleport 到弹窗 footer；散落视觉/拖拽/置顶/入场全在各 ScatterCard。
 *
 * 散落浮动玻璃卡片布局（plans/1-2-floating-willow.md §7）：
 *  - 7 张卡按 SCATTER_TABLE 散落 + 静态旋转，pinwheel 部分重叠，玻璃遮挡后卡。
 *  - 每次进入 global tab 触发坠落入场动画；SettingsDialog v-if 卸载 → 每次重开重置散落。
 *  - 窄屏 (<760px) 回退堆叠滚动；左下数字索引点数字置顶对应卡。
 */
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
  out.push('memory-global', 'memory-workspace')
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
        点卡或左下数字置顶；长按卡片再移动可拖拽重排；进入本页时卡片坠落就位。
      </p>
    </template>

    <div ref="canvasRef" class="global-canvas" :class="{ 'is-ready': ready }">
      <ScatterCard anchor="default" accent="#d946ef" radius="16px 9px 13px 8px" v-slot="{ no }">
        <SupervisionCard :global="draft.global" :no="no" />
      </ScatterCard>

      <ScatterCard anchor="editor" accent="#60a5fa" radius="9px 16px 8px 13px" v-slot="{ no }">
        <EditorCard :global="draft.global" :no="no" />
      </ScatterCard>

      <ScatterCard anchor="limits" accent="#38bdf8" radius="14px 8px 15px 9px" v-slot="{ no }">
        <LimitsCard :global="draft.global" :no="no" />
      </ScatterCard>

      <ScatterCard
        v-if="draft.global.logger"
        anchor="logger"
        accent="#2dd4bf"
        radius="8px 14px 10px 16px"
        v-slot="{ no }"
      >
        <LoggerCard :logger="draft.global.logger!" :no="no" />
      </ScatterCard>

      <ScatterCard
        v-if="draft.global.file_compression"
        anchor="compression"
        accent="#8b5cf6"
        radius="15px 9px 17px 8px"
        v-slot="{ no }"
      >
        <CompressionCard :compression="draft.global.file_compression!" :no="no" />
      </ScatterCard>

      <ScatterCard
        anchor="memory-global"
        accent="#34d399"
        radius="8px 15px 9px 13px"
        v-slot="{ no }"
      >
        <MemoryCard scope="global" :memory="draft.memory!" :no="no" />
      </ScatterCard>

      <ScatterCard
        anchor="memory-workspace"
        accent="#06b6d4"
        radius="13px 8px 15px 10px"
        v-slot="{ no }"
      >
        <MemoryCard scope="workspace" :memory="draft.memory!" :no="no" />
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
          :title="`置顶卡片 ${cardNumber(a)}`"
          @click.stop="raise(a)"
        >
          {{ cardNumber(a) }}
        </button>
      </div>
    </Teleport>
  </TabShell>
</template>

<style scoped lang="less">
// ── 散落画布：填满 .shell-scroll，position:relative 容纳 absolute 卡 ──
.global-canvas {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
  width: 100%;
  height: 100%;
  padding: 6px;
  box-sizing: border-box;
}
// 布局未就绪时（隐藏挂载 / 首帧 0,0）隐藏卡，防初始 7 张叠在左上角闪烁；ready 后由 entry / 静态 opacity 接管。
// .neon-block 在子组件 ScatterCard，须 :deep 穿透。
.global-canvas:not(.is-ready) :deep(.neon-block) {
  opacity: 0;
}

// ── 窄屏兜底：散落失效，回退堆叠滚动（卡级窄屏样式在各 ScatterCard） ──
@media (max-width: 760px) {
  .global-canvas {
    position: static;
    display: flex;
    flex-direction: column;
    gap: 8px;
    height: auto;
    padding: 0;
  }
}
</style>

<!--
  非 scoped：:has() 跨组件选择 .shell-scroll（由 TabShell 渲染）。
  精确命中「内含 .global-canvas 的」.shell-scroll（= GlobalTab 自己的 scroll 容器；global-canvas 是其直接子）。
  不用 .tab-body:has(.global-canvas) .shell-scroll——那会命中同 .tab-body 内其他 tab 的 shell-scroll，
  因为 GlobalTab v-show 常驻挂载，global-canvas 总在 DOM。仅在 ≥761px 把它改 overflow:hidden，让散落画布铺满。
-->
<style lang="less">
@media (min-width: 761px) {
  .shell-scroll:has(> .global-canvas) {
    overflow: hidden;
    overflow-y: hidden;
    padding-right: 0;
    gap: 0;
  }
}
// 左下数字索引（Teleport 到 #settings-footer-nav，故须非 scoped）：点数字置顶对应卡。
.global-card-index {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.global-card-no {
  min-width: 20px;
  height: 20px;
  padding: 0 5px;
  box-sizing: border-box;
  border: 1px solid color-mix(in srgb, var(--ink) 16%, transparent);
  border-radius: 999px;
  background: var(--surface-soft);
  color: color-mix(in srgb, var(--ink) 60%, transparent);
  font:
    800 11px/20px ui-monospace,
    SFMono-Regular,
    monospace;
  text-align: center;
  cursor: pointer;
  transition:
    background 0.15s ease,
    border-color 0.15s ease,
    color 0.15s ease,
    transform 0.15s ease,
    box-shadow 0.15s ease;
}
.global-card-no:hover {
  transform: translateY(-1px);
  border-color: color-mix(in srgb, var(--tab-color, #06b6d4) 50%, transparent);
  color: color-mix(in srgb, var(--ink) 85%, transparent);
}
.global-card-no.active {
  background: color-mix(in srgb, var(--tab-color, #06b6d4) 22%, var(--surface));
  border-color: color-mix(in srgb, var(--tab-color, #06b6d4) 60%, transparent);
  color: color-mix(in srgb, var(--accent-ink) 85%, transparent);
  box-shadow: 0 2px 8px color-mix(in srgb, var(--tab-color, #06b6d4) 30%, transparent);
}
</style>
