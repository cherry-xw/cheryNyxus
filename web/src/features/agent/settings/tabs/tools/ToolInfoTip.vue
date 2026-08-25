<script setup lang="ts">
/**
 * ToolInfoTip：器官 tab 已选工具 tag 的 hover 结构化说明（el-tooltip #content 用）。
 * 三段：① 工具名 + 危险 pill；② 完整文档分节（【作用】【能力】【边界】【注意】，注意节强调）；
 *       ③ 监管等级区（等级名着色加粗 + 行为说明 + 继承来源），有重点、不铺叙。
 * popper teleport 到 body，面板背景样式走非 scoped .tool-tip-popper（仿 label-tip-popper）。
 */
import { computed } from 'vue'
import { SUPERVISIONS, SUPERVISION_LABEL } from '../../config/constants'
import { parseSenseDoc } from '../../config/shared'

const props = defineProps<{
  label: string
  doc: string
  dangerous: boolean
  /** 监管等级：'' = 继承；其余 auto/smart/manual。 */
  level: string
  globalSupervision: string
}>()

const sections = computed(() => parseSenseDoc(props.doc))

// 监管等级行为说明（与 GlobalTab 全局监管说明对齐：自动更流畅 / 确认关键操作前询问 / 手动最谨慎）。
const SUPERVISION_DESC: Record<(typeof SUPERVISIONS)[number], string> = {
  auto: 'AI 自行调用，无需确认（更流畅）',
  smart: '安全操作自动执行，敏感操作先问你',
  manual: '最谨慎，每次需手动放行',
}

function levelLabel(level: string): string {
  if (!level) return '继承'
  return SUPERVISION_LABEL[level as (typeof SUPERVISIONS)[number]] ?? level
}
function supervisionDesc(level: string): string {
  const key = (level || props.globalSupervision) as (typeof SUPERVISIONS)[number]
  return SUPERVISION_DESC[key] ?? ''
}
</script>

<template>
  <div class="tool-info-tip">
    <div class="tip-head">
      <span class="tip-title">{{ label }}</span>
      <span v-if="dangerous" class="danger-pill">⚠ 危险器官</span>
    </div>

    <template v-if="sections.length">
      <div
        v-for="sec in sections"
        :key="sec.label"
        class="doc-sec"
        :class="{ 'is-notice': sec.label === '注意' }"
      >
        <div class="sec-label">{{ sec.label }}</div>
        <div class="sec-text">{{ sec.text }}</div>
      </div>
    </template>
    <p v-else-if="doc" class="plain-doc">{{ doc }}</p>

    <div v-if="level || globalSupervision" class="super-section">
      <div class="super-row">
        <span class="lv-name" :class="level ? `lv-${level}` : 'lv-inherit'">{{
          levelLabel(level)
        }}</span>
        <span class="super-hint">点等级标切换</span>
      </div>
      <div class="super-desc">{{ supervisionDesc(level) }}</div>
      <div v-if="!level" class="super-inherit">
        继承全局监管：{{ levelLabel(globalSupervision) }}（{{ globalSupervision }}）
      </div>
    </div>
  </div>
</template>

<style scoped lang="less">
.tool-info-tip {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 200px;
  max-width: 320px;
}
.tip-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.tip-title {
  font-size: 13px;
  font-weight: 600;
}
.danger-pill {
  font-size: 10px;
  line-height: 1;
  padding: 3px 7px;
  border-radius: 999px;
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--danger) 40%, transparent);
}
.doc-sec {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.sec-label {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.05em;
  color: color-mix(in srgb, var(--ink) 56%, transparent);
}
// 【注意】节标强调为危险色，突出"危险点"重点。
.doc-sec.is-notice .sec-label {
  color: var(--danger);
}
.sec-text {
  font-size: 12px;
  line-height: 1.55;
  word-break: break-word;
}
.plain-doc {
  margin: 0;
  font-size: 12px;
  line-height: 1.55;
  word-break: break-word;
}
// 监管等级区：顶部分隔线与文档区隔开；等级名着色加粗有重点，行为说明次要化。
.super-section {
  border-top: 1px solid color-mix(in srgb, var(--ink) 14%, transparent);
  padding-top: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.super-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.lv-name {
  font-size: 12px;
  font-weight: 600;
  // 与 tag 着色语义一致：auto（放权）= 最险 → danger，smart = warning，manual = info
  &.lv-auto {
    color: var(--danger);
  }
  &.lv-smart {
    color: var(--warning);
  }
  &.lv-manual {
    color: var(--info);
  }
  &.lv-inherit {
    color: color-mix(in srgb, var(--ink) 56%, transparent);
    font-style: italic;
  }
}
.super-hint {
  font-size: 10px;
  color: color-mix(in srgb, var(--ink) 52%, transparent);
}
.super-desc {
  font-size: 11px;
  color: color-mix(in srgb, var(--ink) 74%, transparent);
}
.super-inherit {
  font-size: 10px;
  color: color-mix(in srgb, var(--ink) 52%, transparent);
}
</style>

<!--
  popper teleport 到 body，scoped 样式无法穿透根面板，故置非 scoped：
  主题自适应面板背景（仿 styles/element/index.scss 的 label-tip-popper），
  specificity .el-popper.is-dark.tool-tip-popper(0,3,0) > EP .el-popper.is-dark(0,2,0)。
  全局 .el-popper{font-weight:400; b,strong{600}}（index.scss）自动兜底基础字重。
-->
<style lang="less">
.el-popper.is-dark.tool-tip-popper {
  background: var(--panel);
  color: var(--ink);
  border: 1px solid color-mix(in srgb, var(--ink) 14%, transparent);
  box-shadow: 0 5px 14px color-mix(in srgb, var(--ink) 16%, transparent);
  .el-popper__arrow::before {
    background: var(--panel);
    border-color: color-mix(in srgb, var(--ink) 14%, transparent);
  }
}
.el-popper.tool-tip-popper {
  max-width: 360px;
  line-height: 1.5;
  word-break: break-word;
}
</style>
