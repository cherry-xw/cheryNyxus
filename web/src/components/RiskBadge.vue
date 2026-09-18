<script setup lang="ts">
/**
 * RiskBadge：工具调用的安全风险徽章（跨 feature 共享）。
 * 显示规则（用户确认）：统一风险徽章 + 展开详情——安全=绿 / 中=黄 / 高=红 / 未知=灰。
 * - auth 缺省（旧数据 / 无判定）→ 显示「未知」，避免把未评估误标为安全。
 * - compact=true：仅显示徽章 chip（RunningTools / LiteToolCallDetail 等紧凑场景），不展开 findings。
 * - dotOnly=true：仅显示语义色小圆点（折叠工具调用标签模式用），hover 圆点 el-tooltip 显示内容，不用 title。
 * - 非 compact 且有 findings：点击徽章展开/收起详情（severity/message/fragment）。
 * 样式：字重 400 / 圆角 tag（用户确认与其他圆角 tag 一致，2026-09-17）/ 语义色 token（--success/--warning/--danger）。
 */
import { computed, ref } from 'vue'
import { riskLevelOf, RISK_LEVEL_LABEL, type ToolSecurityShape } from '@/domain/chat/securityRisk'

const props = defineProps<{
  /** 安全授权判定（ToolAuthorization / ToolAuthorizationDto 均结构兼容）；缺省 = 无判定 */
  auth?: ToolSecurityShape | null
  /** compact：仅徽章 chip，不渲染展开按钮与详情 */
  compact?: boolean
  /** dotOnly：仅渲染语义色小圆点（折叠工具调用标签内），hover 圆点出 tip（内容 = 等级 + 判定数） */
  dotOnly?: boolean
}>()

const expanded = ref(false)
const level = computed(() => riskLevelOf(props.auth))
const label = computed(() => RISK_LEVEL_LABEL[level.value])
const findings = computed(() => props.auth?.findings ?? [])
const expandable = computed(() => !props.compact && findings.value.length > 0)
/** dotOnly / compact 的 tip 内容：等级 + 判定数（走 el-tooltip，不用原生 title，遵守 AGENTS.md 说明呈现方式优先级）。 */
const chipTip = computed(() =>
  `${label.value}${findings.value.length ? `（${findings.value.length} 项判定）` : ''}`,
)
const dotTip = chipTip

function toggle(): void {
  if (!expandable.value) return
  expanded.value = !expanded.value
}
</script>

<template>
  <!-- dotOnly：折叠标签里的小圆点，hover 圆点 el-tooltip 显示内容（不用原生 title） -->
  <span v-if="dotOnly" class="risk-dot-badge" :class="[`is-${level}`]">
    <el-tooltip :content="dotTip" placement="top" :show-after="150" :hide-after="0">
      <span class="risk-dot" role="img" :aria-label="dotTip" tabindex="0" />
    </el-tooltip>
  </span>
  <span v-else class="risk-badge" :class="[`is-${level}`]">
    <!-- compact：chip 本身即说明载体，hover chip el-tooltip 显「等级（N 项判定）」（不用原生 title） -->
    <el-tooltip
      v-if="compact"
      :content="chipTip"
      placement="top"
      :show-after="150"
      :hide-after="0"
    >
      <span class="risk-chip" role="img" :aria-label="chipTip">
        <span class="risk-dot" aria-hidden="true" />
        <span class="risk-label">{{ label }}</span>
      </span>
    </el-tooltip>
    <!-- 非 compact：chip 可见文字即等级，展开 affordance 由 hover 边框 + aria-expanded 承担，不叠加冗余 title -->
    <component
      v-else
      :is="expandable ? 'button' : 'span'"
      :type="expandable ? 'button' : undefined"
      class="risk-chip"
      :class="{ 'is-expandable': expandable }"
      :aria-expanded="expandable ? expanded : undefined"
      @click="toggle"
    >
      <span class="risk-dot" aria-hidden="true" />
      <span class="risk-label">{{ label }}</span>
    </component>
    <ul v-if="!compact && expanded && findings.length" class="risk-findings">
      <li v-for="(finding, index) in findings" :key="`${finding.code}-${index}`">
        <span class="finding-severity">{{ finding.severity }}</span>
        <span class="finding-message">{{ finding.message }}</span>
        <code v-if="finding.fragment" class="finding-fragment">{{ finding.fragment }}</code>
      </li>
    </ul>
  </span>
</template>

<style scoped lang="less">
.risk-badge {
  display: inline-flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  font-weight: 400;
  line-height: 1.2;
}

.risk-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 8px;
  border: 1px solid var(--border-strong);
  border-radius: 999px; /* 圆角 tag：与其他圆角 tag 风格一致（用户确认 2026-09-17） */
  background: var(--surface);
  color: var(--ink);
  font-size: 12px;
  font-weight: 400;
  cursor: default;
  transition:
    background 100ms ease,
    border-color 100ms ease;

  &.is-expandable {
    cursor: pointer;

    &:hover {
      border-color: color-mix(in srgb, var(--ink) 55%, transparent);
    }
  }

  .risk-dot {
    flex-shrink: 0;
    width: 6px;
    height: 6px;
    border-radius: 50%;
  }

  .risk-label {
    white-space: nowrap;
  }
}

.risk-badge.is-safe {
  .risk-chip {
    background: color-mix(in srgb, var(--success) 10%, var(--surface));
    color: var(--success);
  }

  .risk-dot {
    background: var(--success);
  }
}

.risk-badge.is-medium {
  .risk-chip {
    background: color-mix(in srgb, var(--warning) 12%, var(--surface));
    color: var(--warning);
  }

  .risk-dot {
    background: var(--warning);
  }
}

.risk-badge.is-high {
  .risk-chip {
    background: color-mix(in srgb, var(--danger) 12%, var(--surface));
    color: var(--danger);
  }

  .risk-dot {
    background: var(--danger);
  }
}

.risk-badge.is-unknown {
  .risk-chip {
    background: color-mix(in srgb, var(--ink) 8%, var(--surface));
    color: color-mix(in srgb, var(--ink) 62%, transparent);
  }

  .risk-dot {
    background: color-mix(in srgb, var(--ink) 45%, transparent);
  }
}

.risk-findings {
  margin: 0;
  padding: 4px 6px;
  border: 1px solid var(--border);
  border-radius: 0;
  background: var(--surface-soft);
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-width: 280px;
}

.risk-findings li {
  display: flex;
  flex-direction: column;
  gap: 1px;
  font-size: 12px;
  overflow-wrap: anywhere;
}

/* dotOnly：折叠工具调用标签内的语义色小圆点（hover 圆点出 tip）。 */
.risk-dot-badge {
  display: inline-flex;
  align-items: center;
  flex: none;
  line-height: 1;

  .risk-dot {
    display: block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    outline: none;
    cursor: help;
  }
}

.risk-dot-badge.is-safe {
  .risk-dot {
    background: var(--success);
  }
}

.risk-dot-badge.is-medium {
  .risk-dot {
    background: var(--warning);
  }
}

.risk-dot-badge.is-high {
  .risk-dot {
    background: var(--danger);
  }
}

.risk-dot-badge.is-unknown {
  .risk-dot {
    background: color-mix(in srgb, var(--ink) 45%, transparent);
  }
}

.finding-severity {
  color: var(--danger);
  font-size: 12px;
  text-transform: uppercase;
}

.finding-message {
  color: var(--ink);
}

.finding-fragment {
  white-space: pre-wrap;
  color: color-mix(in srgb, var(--ink) 68%, transparent);
  font-size: 12px;
}
</style>
