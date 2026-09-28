<script setup lang="ts">
/**
 * RoleConfigPopover：单角色编制配置卡（el-popover 内部内容）。
 * 从 AgentDialog 拆出，负责 brain/senseGroup 选择 + 资料卡展示。
 */
import { computed, ref } from 'vue'
import { LLM_PROTOCOL_CATALOG, type LlmProtocol } from '@chery/protocol'
import {
  type BrainConfigDto,
  type BrainInfo,
  type ConfigDto,
  type RuntimeSelection,
  type SenseGroupOption,
  type SenseToolInfo,
} from '@/application/backend/public'
import { createRoleConfigModel, THINKING_LABEL as roleConfigModelTHINKING_LABEL } from './roleConfigModel'
import ThinkingLevelSwitch from './ThinkingLevelSwitch.vue'

const props = withDefaults(
  defineProps<{
    role: string
    selection: RuntimeSelection
    brains: BrainInfo[]
    senseGroups: readonly SenseGroupOption[]
    config: ConfigDto | null
    senseTools: SenseToolInfo[]
    isPrimary: boolean
    primaryRole: string
    roleUsage?: { used: number; total: number; usage: number } | null
    /** 工作台堆叠卡把角色名移到整组卡片外框时隐藏卡内标题。 */
    showRoleName?: boolean
    /** 工作台堆叠卡专用：显示思考等级悬停入口 + 泰拉瑞亚风切换（仅该场景开启）。 */
    showThinkingControl?: boolean
    /** v1.0 只读模式：仅展示资料卡、隐藏大脑/器官组选择区（workbench rail 角色 popout 用；
     *  发送消息角色卡不传该 prop，保持可操作）。 */
    readonly?: boolean
  }>(),
  { readonly: false, showRoleName: true, showThinkingControl: false },
)

const emit = defineEmits<{
  (e: 'update:selection', val: RuntimeSelection): void
}>()

// local computed for v-model:selection — two-way binding via getter/setter
const localSelection = computed({
  get: () => props.selection,
  set: (val) => emit('update:selection', val),
})

// 角色配置 helper 与 AgentDialog 共用同一实现（runtime/roleConfigModel.ts），数据源来自 props。
const { brainInfo, brainConfig, supportsTools, selectBrain, senseEntries, senseName, senseTool } =
  createRoleConfigModel({
    brains: () => props.brains,
    config: () => props.config,
    senseGroups: () => props.senseGroups,
    senseTools: () => props.senseTools,
  })

/** 思考档位 → 显示文字（资料卡 💭 tooltip 用）。
 *  档位值来自 `.chery/model-catalog.yaml` 的 wire.thinking[].display，是开放字符串
 *  （如 DeepSeek 的 `max`）。除固定档位外补一批常见档位，保证任意返回值都有中文名；
 *  仍未命中的走调用处兜底（原样显示）。
 *  注意：档位可能同时出现 xhigh 与 max（如 gpt-6 目录 [.., xhigh, max]），
 *  两者必须用不同中文名，避免切换面板出现两个「最高」。 */
// 思考档位 → 中文：共享表在 roleConfigModel.ts（与工作台用量条同源）；
// 档位说明见上方注释，仍未命中的走调用处兜底（原样显示）。
const THINKING_LABEL = roleConfigModelTHINKING_LABEL

/** 返回思考档位中文；off / 无配置 → null（不显示 💭）。 */
function thinkingLabel(cfg: BrainConfigDto | undefined): string | null {
  const level = cfg?.thinking ?? 'off'
  return level === 'off' ? null : (THINKING_LABEL[level] ?? null)
}

function formatContextLimit(limit: number | undefined): string {
  if (limit === undefined) return '—'
  if (limit >= 1000) return `${Math.round(limit / 1000)}k`
  return String(limit)
}

function formatTokens(value: number): string {
  if (value >= 1000) return `${Math.round(value / 1000)}k`
  return String(value)
}

/** API 协议标识 → 中文/官方标签（胶囊 hover 详情用）。 */
function protocolLabel(protocol: LlmProtocol | undefined): string {
  if (!protocol) return '—'
  return LLM_PROTOCOL_CATALOG.find((entry) => entry.id === protocol)?.label ?? protocol
}

/** 器官组内单个能力入口的 hover 说明：工具 label · description。 */
function senseToolTitle(entry: string): string {
  const tool = senseTool(entry)
  if (!tool) return senseName(entry)
  return `${tool.label} · ${tool.description}`
}

/** 当前角色在 config.roles 中的默认 brain / senseGroup（无配置 → 空串，不标 ★）。 */
const roleDefault = computed<{ brain: string; senseGroup: string }>(() => {
  const cfg = props.config?.roles?.[props.role]
  return {
    brain: cfg?.brain ?? '',
    senseGroup: cfg?.senseGroup ?? '',
  }
})

// ── ① 名称/模型 大小字互切（大脑选择区 choice-slot） ────────────
/** true=名称大字、模型小字；false=模型大字、名称小字。大脑区块标题 ⇄ 一键切换。 */
const nameIsBig = ref(true)

// ── ② 思考等级：悬停入口 + 泰拉瑞亚风切换（仅工作台堆叠卡） ──────
</script>

<template>
  <el-card
    shadow="never"
    class="role-card terraria-role-card"
    :class="{ 'is-readonly': readonly }"
    :aria-label="`${role} 的临时编制${readonly ? '（只读）' : ''}`"
  >
    <ThinkingLevelSwitch v-if="showThinkingControl" :selection="selection" :brain-config="brainConfig(selection.brain)" @update:selection="emit('update:selection', $event)" />

    <div class="profile-hero">
      <el-avatar :size="52" class="profile-avatar">{{ role.slice(0, 1) }}</el-avatar>
      <div class="profile-identity">
        <strong v-if="showRoleName">{{ role }}</strong>
        <div class="profile-summary">
          <span class="identity-kind">{{ isPrimary ? '♛ 小组组长' : '✦ 小组成员' }}</span>
          <span v-if="readonly" class="identity-readonly" aria-label="只读">🔒 只读</span>
          <span class="brain-name">◈ {{ selection.brain || '未选择大脑' }}</span>
        </div>
        <div class="brain-facts" aria-label="当前大脑参数">
          <span class="brain-fact-text"
            ><b>模型</b>{{ brainConfig(selection.brain)?.model ?? '—' }}</span
          >
          <span class="brain-fact-text"
            ><b>上下文</b
            >{{
              formatContextLimit(
                brainInfo(selection.brain)?.contextLimit ??
                  brainConfig(selection.brain)?.contextLimit,
              )
            }}</span
          >
          <span v-if="roleUsage" class="brain-fact-text role-usage-fact">
            <b>已用</b>{{ formatTokens(roleUsage.used) }}/{{ formatTokens(roleUsage.total) }} ·
            {{ Math.round(roleUsage.usage * 100) }}%
          </span>
          <el-tooltip
            v-if="thinkingLabel(brainConfig(selection.brain))"
            :content="`思考（${thinkingLabel(brainConfig(selection.brain))}）`"
            placement="top"
          >
            <span class="brain-fact-icon">💭</span>
          </el-tooltip>
          <el-tooltip v-if="supportsTools(selection.brain)" content="工具调用" placement="top">
            <span class="brain-fact-icon">🔧</span>
          </el-tooltip>
          <el-tooltip
            v-if="brainConfig(selection.brain)?.capabilities?.input?.image"
            content="模型支持图像输入"
            placement="top"
          >
            <span class="brain-fact-icon cap-input">🖼️</span>
          </el-tooltip>
          <el-tooltip
            v-if="brainConfig(selection.brain)?.capabilities?.input?.video"
            content="模型支持视频输入"
            placement="top"
          >
            <span class="brain-fact-icon cap-input">🎞️</span>
          </el-tooltip>
          <el-tooltip
            v-if="brainConfig(selection.brain)?.capabilities?.input?.audio"
            content="模型支持音频输入"
            placement="top"
          >
            <span class="brain-fact-icon cap-input">🔊</span>
          </el-tooltip>
          <el-tooltip
            v-if="brainConfig(selection.brain)?.capabilities?.generate?.image"
            content="模型支持图像生成"
            placement="top"
          >
            <span class="brain-fact-icon cap-generate">🎨</span>
          </el-tooltip>
          <el-tooltip
            v-if="brainConfig(selection.brain)?.capabilities?.generate?.video"
            content="模型支持视频生成"
            placement="top"
          >
            <span class="brain-fact-icon cap-generate">🎬</span>
          </el-tooltip>
          <el-tooltip
            v-if="brainConfig(selection.brain)?.capabilities?.generate?.audio"
            content="模型支持音频生成"
            placement="top"
          >
            <span class="brain-fact-icon cap-generate">🎵</span>
          </el-tooltip>
        </div>
        <div
          v-if="senseEntries(selection.senseGroup).length"
          class="profile-sense-icons"
          aria-label="已启用能力"
        >
          <el-tooltip
            v-for="entry in senseEntries(selection.senseGroup)"
            :key="entry"
            :content="`${senseTool(entry)?.label ?? senseName(entry)} · ${senseTool(entry)?.description ?? '未提供能力说明'}`"
            placement="top"
          >
            <span class="profile-sense-icon">{{ senseTool(entry)?.icon ?? '⚙' }}</span>
          </el-tooltip>
        </div>
      </div>
    </div>

    <div v-if="!readonly" class="profile-settings">
      <section class="profile-setting">
        <div class="setting-heading">
          <span class="setting-icon">◈</span>
          <span>大脑</span>
        </div>
        <button
          type="button"
          class="brain-swap-toggle"
          :aria-label="nameIsBig ? '把模型切换为大字显示' : '把名称切换为大字显示'"
          @click="nameIsBig = !nameIsBig"
        >
          <span aria-hidden="true">⇄</span>
        </button>
        <div class="choice-list" role="radiogroup" aria-label="选择模型">
          <span v-for="brain in brains" :key="brain.name" class="choice-slot">
            <el-tooltip
              placement="top"
              :show-after="150"
              :hide-after="0"
              popper-class="role-detail-popper"
            >
              <template #content>
                <div class="role-detail" aria-label="大脑详情">
                  <div class="role-detail-title">{{ brain.name }}</div>
                  <div class="role-detail-row">
                    <span class="role-detail-key">模型</span>
                    <span class="role-detail-value">{{
                      brainConfig(brain.name)?.model ?? '—'
                    }}</span>
                  </div>
                  <div class="role-detail-row">
                    <span class="role-detail-key">API 协议</span>
                    <span class="role-detail-value">{{
                      protocolLabel(brainConfig(brain.name)?.protocol)
                    }}</span>
                  </div>
                  <div class="role-detail-row">
                    <span class="role-detail-key">上下文限制</span>
                    <span class="role-detail-value">{{
                      formatContextLimit(
                        brainInfo(brain.name)?.contextLimit ??
                          brainConfig(brain.name)?.contextLimit,
                      )
                    }}</span>
                  </div>
                  <div class="role-detail-row">
                    <span class="role-detail-key">工具调用</span>
                    <span class="role-detail-value">{{
                      supportsTools(brain.name) ? '支持' : '不支持'
                    }}</span>
                  </div>
                  <div class="role-detail-row">
                    <span class="role-detail-key">深度思考</span>
                    <span class="role-detail-value">{{
                      thinkingLabel(brainConfig(brain.name)) ?? '关闭'
                    }}</span>
                  </div>
                </div>
              </template>
              <button
                type="button"
                class="choice-option"
                :class="{ selected: localSelection.brain === brain.name }"
                :aria-checked="localSelection.brain === brain.name"
                role="radio"
                @click="selectBrain(localSelection, brain.name)"
              >
                <span class="choice-name" :class="nameIsBig ? 'is-big' : 'is-small'">{{
                  brain.name
                }}</span>
                <span class="choice-model" :class="nameIsBig ? 'is-small' : 'is-big'">{{
                  brainConfig(brain.name)?.model ?? '—'
                }}</span>
                <span
                  v-if="brain.name === roleDefault.brain"
                  class="choice-default"
                  aria-label="默认"
                  >★</span
                >
              </button>
            </el-tooltip>
          </span>
        </div>
      </section>

      <section v-if="supportsTools(localSelection.brain)" class="profile-setting sense-setting">
        <div class="setting-heading">
          <span class="setting-icon">✦</span>
          <span>器官组</span>
        </div>
        <div class="choice-list" role="radiogroup" aria-label="选择器官组">
          <span v-for="group in senseGroups" :key="group.name" class="choice-slot">
            <el-tooltip
              placement="top"
              :show-after="150"
              :hide-after="0"
              popper-class="role-detail-popper"
            >
              <template #content>
                <div class="role-detail" aria-label="器官组详情">
                  <div class="role-detail-title">{{ group.name }}</div>
                  <div class="sense-detail-tools">
                    <span
                      v-for="entry in senseEntries(group.name)"
                      :key="entry"
                      class="sense-detail-tool"
                      :title="senseToolTitle(entry)"
                    >
                      {{ senseTool(entry)?.icon ?? '⚙' }}
                    </span>
                    <span v-if="!senseEntries(group.name).length" class="sense-detail-empty"
                      >无工具</span
                    >
                  </div>
                </div>
              </template>
              <button
                type="button"
                class="choice-option"
                :class="{ selected: localSelection.senseGroup === group.name }"
                :aria-checked="localSelection.senseGroup === group.name"
                role="radio"
                @click="localSelection.senseGroup = group.name"
              >
                <span class="choice-option-label">{{ group.name }}</span>
                <span
                  v-if="group.name === roleDefault.senseGroup"
                  class="choice-default"
                  aria-label="默认"
                  >★</span
                >
              </button>
            </el-tooltip>
          </span>
        </div>
      </section>
      <p v-else class="runtime-note">该模型不支持 Tool Call，仅可进行对话与已标记的媒体理解。</p>
    </div>
    <div v-if="!readonly" class="runtime-note">仅本次会话，服务重启后失效</div>
  </el-card>
</template>

<style scoped lang="less">
.role-card {
  width: 100%;
  overflow: hidden;
  border-color: color-mix(in srgb, var(--ink) 12%, transparent);
  border-radius: 12px;
  background: var(--panel);

  :deep(.el-card__body) {
    display: grid;
    gap: 8px;
    padding: 0 12px 10px;
  }
}

.profile-hero {
  margin: 0 -12px;
  padding: 11px 12px 9px;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  background:
    linear-gradient(
      115deg,
      color-mix(in srgb, var(--accent) 20%, transparent),
      color-mix(in srgb, var(--accent) 4%, transparent)
    ),
    var(--surface);
  border-bottom: 1px solid color-mix(in srgb, var(--accent) 14%, transparent);
}

.profile-avatar {
  flex: none;
  border: 2px solid rgba(255, 255, 255, 0.82);
  background: #d99717;
  color: #fff;
  font-size: 22px;
  font-weight: 600;
  box-shadow: 0 2px 8px rgba(129, 88, 15, 0.2);
}

.profile-identity {
  min-width: 0;
  flex: 1;
  display: grid;
  gap: 4px;

  strong {
    overflow: hidden;
    color: var(--ink);
    font-size: 18px;
    line-height: 1.15;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.profile-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 3px 7px;
  color: color-mix(in srgb, var(--ink) 68%, transparent);
}

.identity-kind {
  color: var(--accent);
  font-weight: 600;
}
/* v1.0 只读标（workbench rail 角色 popout）：暖金小 chip，与 identity-kind 同排。 */
.identity-readonly {
  display: inline-flex;
  align-items: center;
  padding: 0 6px;
  border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  color: var(--accent);
  font-size: 12px;
  line-height: 16px;
  font-weight: 600;
}
.brain-name {
  color: color-mix(in srgb, var(--ink) 72%, transparent);
}

.brain-facts {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 3px 5px;
  color: color-mix(in srgb, var(--ink) 65%, transparent);
  font-size: 12px;

  .brain-fact-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  b {
    margin-right: 3px;
    color: color-mix(in srgb, var(--ink) 42%, transparent);
    font-weight: 600;
  }

  .brain-fact-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border: 1px solid color-mix(in srgb, var(--ink) 12%, transparent);
    background: var(--surface-soft);
    font-size: 13px;
    line-height: 1;
    cursor: pointer;

    &.cap-input {
      border-color: rgba(59, 130, 246, 0.28);
      background: color-mix(in srgb, #3b82f6 14%, var(--surface));
    }

    &.cap-generate {
      border-color: rgba(234, 88, 12, 0.3);
      background: color-mix(in srgb, #ea580c 12%, var(--surface));
    }
  }
}

.profile-sense-icons {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
}

.profile-sense-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: 1px solid color-mix(in srgb, var(--ink) 12%, transparent);
  background: var(--surface-soft);
  font-size: 13px;
  cursor: pointer;
}

.profile-settings {
  display: grid;
  grid-template-columns: 1fr; /* 两列改两行：大脑一块、器官组一块 */
  gap: 12px;
}

.profile-setting {
  position: relative;
  min-width: 0;
  margin-top: 9px; /* 标题骑跨上边框（中线与边框线对齐）所需的突出空间 */
  padding: 12px 10px 9px;
  border: 1px solid color-mix(in srgb, var(--ink) 12%, transparent);
  border-radius: 8px;
  background: transparent; /* 让卡片底（--panel）透出，标题盖边框线时与背景无缝 */
}

/* 块标题：盖住上边框线、居左但不盖左上角，标题中线与边框线对齐（legend 式） */
.setting-heading {
  position: absolute;
  top: 0;
  left: 12px; /* 避开左上角圆角 */
  transform: translateY(-50%);
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 6px;
  background: var(--panel); /* 盖住身后的边框线 */
  color: color-mix(in srgb, var(--ink) 68%, transparent);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.03em;
  white-space: nowrap;
}

.setting-icon {
  color: #d99717;
  font-size: 15px;
  line-height: 1;
}

.choice-list {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 6px;
}

.choice-slot {
  display: inline-block;
  flex: none;
  max-width: 100%;
}

/* 子项胶囊：始终全量显示（不依赖 hover 展开），胶囊内不换行 */
.choice-option {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  border: 1px solid color-mix(in srgb, var(--ink) 10%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--ink) 4.5%, transparent);
  color: color-mix(in srgb, var(--ink) 64%, transparent);
  font: inherit;
  font-size: 12px;
  line-height: 1.4;
  white-space: nowrap;
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    border-color 0.15s ease,
    color 0.15s ease;

  &:hover {
    border-color: color-mix(in srgb, var(--accent) 38%, transparent);
    background: var(--surface-hover);
    color: color-mix(in srgb, var(--ink) 82%, transparent);
  }

  &.selected {
    border-color: color-mix(in srgb, var(--accent) 40%, transparent);
    background: color-mix(in srgb, var(--accent) 16%, transparent);
    color: var(--accent);
    font-weight: 400;

    &:hover {
      background: color-mix(in srgb, var(--accent) 15%, transparent);
    }
  }
}

.choice-option-label {
  min-width: 0;
  white-space: nowrap;
}

.choice-default {
  flex: none;
  color: #bd8215;
  font-size: 12px;
  line-height: 1;
  text-shadow: 0 1px 0 rgba(255, 255, 255, 0.65);
}

.runtime-note {
  color: color-mix(in srgb, var(--ink) 46%, transparent);
  font-size: 12px;
  line-height: 1.2;
  text-align: right;
}

/* Terraria-inspired identity card: a dark inventory panel with hard pixel edges. */
.terraria-role-card {
  --terraria-ink: #f1e4c2;
  --terraria-muted: #b9aa87;
  --terraria-panel: #29231d;
  --terraria-panel-deep: #171411;
  --terraria-edge: #8b6a3e;
  --terraria-edge-dark: #4b3825;
  --terraria-gold: #e4b955;
  --terraria-blue: #76b8d2;
  --terraria-green: #9bc878;
  --terraria-red: #d9785d;

  position: relative;
  border: 3px solid var(--terraria-edge);
  border-radius: 0;
  background: var(--terraria-panel-deep);
  box-shadow:
    0 0 0 2px #0c0b0a,
    inset 0 0 0 1px var(--terraria-edge-dark),
    5px 5px 0 color-mix(in srgb, #000 70%, transparent);
  color: var(--terraria-ink);

  &::before,
  &::after {
    position: absolute;
    z-index: 2;
    width: 7px;
    height: 7px;
    background: var(--terraria-gold);
    content: '';
  }

  &::before {
    top: -3px;
    left: 18px;
  }

  &::after {
    right: 18px;
    bottom: -3px;
  }

  :deep(.el-card__body) {
    gap: 12px;
    padding: 0 14px 13px;
  }

  .profile-hero {
    position: relative;
    margin: 0 -14px;
    padding: 15px 14px 13px;
    border-bottom: 3px solid var(--terraria-edge);
    background: repeating-linear-gradient(
      0deg,
      color-mix(in srgb, var(--terraria-panel) 92%, #000),
      color-mix(in srgb, var(--terraria-panel) 92%, #000) 3px,
      color-mix(in srgb, var(--terraria-panel-deep) 92%, #000) 3px,
      color-mix(in srgb, var(--terraria-panel-deep) 92%, #000) 6px
    );
  }

  .profile-avatar {
    width: 58px;
    height: 58px;
    border: 3px solid var(--terraria-gold);
    border-radius: 0;
    background: var(--terraria-blue);
    box-shadow:
      3px 3px 0 #0c0b0a,
      inset 0 0 0 3px color-mix(in srgb, #fff 24%, transparent);
    color: #11100d;
    font-size: 25px;
    font-weight: 700;
  }

  .profile-identity {
    gap: 6px;

    strong {
      color: var(--terraria-ink);
      font-size: 21px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-shadow: 2px 2px 0 #0c0b0a;
    }
  }

  .profile-summary {
    gap: 4px 9px;
    color: var(--terraria-muted);
    font-size: 13px;
  }

  .identity-kind {
    color: var(--terraria-gold);
    font-weight: 700;
    text-transform: uppercase;
  }

  .identity-readonly {
    padding: 1px 6px;
    border: 1px solid var(--terraria-edge);
    border-radius: 0;
    background: var(--terraria-panel-deep);
    color: var(--terraria-muted);
    font-weight: 400;
  }

  .brain-name {
    color: var(--terraria-blue);
    font-weight: 700;
  }

  .brain-facts {
    gap: 5px 8px;
    color: var(--terraria-muted);

    b {
      color: var(--terraria-gold);
      font-weight: 400;
      text-transform: uppercase;
    }

    .brain-fact-icon {
      width: 20px;
      height: 20px;
      border: 1px solid var(--terraria-edge);
      border-radius: 0;
      background: var(--terraria-panel-deep);
    }

    .cap-input,
    .cap-generate {
      border-color: var(--terraria-edge);
      background: var(--terraria-panel-deep);
    }
  }

  .role-usage-fact {
    color: var(--terraria-green);
  }

  .profile-sense-icons {
    gap: 4px;
  }

  .profile-sense-icon {
    width: 22px;
    height: 22px;
    border: 1px solid var(--terraria-edge);
    border-radius: 0;
    background: var(--terraria-panel);
  }

  .profile-setting {
    margin-top: 11px;
    padding: 15px 11px 10px;
    border: 2px solid var(--terraria-edge-dark);
    border-radius: 0;
    background: var(--terraria-panel);
  }

  .setting-heading {
    left: 10px;
    padding: 1px 7px;
    border: 1px solid var(--terraria-edge);
    border-radius: 0;
    background: var(--terraria-panel-deep);
    color: var(--terraria-gold);
    font-weight: 700;
    letter-spacing: 0.05em;
  }

  .setting-icon {
    color: var(--terraria-gold);
  }

  .choice-list {
    gap: 7px;
  }

  .choice-option {
    min-height: 34px;
    padding: 5px 10px;
    border: 2px solid var(--terraria-edge-dark);
    border-radius: 0;
    background: var(--terraria-panel-deep);
    color: var(--terraria-muted);
    font-size: 13px;
    font-weight: 700;
    box-shadow: 2px 2px 0 #0c0b0a;

    &:hover {
      border-color: var(--terraria-gold);
      background: color-mix(in srgb, var(--terraria-panel) 85%, var(--terraria-gold));
      color: var(--terraria-ink);
    }

    &.selected {
      border-color: var(--terraria-blue);
      background: color-mix(in srgb, var(--terraria-blue) 22%, var(--terraria-panel-deep));
      color: var(--terraria-ink);
      box-shadow:
        2px 2px 0 #0c0b0a,
        inset 0 0 0 1px var(--terraria-blue);
    }
  }

  .choice-default {
    color: var(--terraria-gold);
    text-shadow: none;
  }

  .runtime-note {
    color: var(--terraria-muted);
    text-align: left;
  }
}

/* ── ① 名称/模型 大小字互切（大脑选择区 choice-slot） ─────────────
   每个大脑按钮内「名称 + 模型」同排展示，切换时一个变大一个变小
   （像气球通气：同刻互偿），字号过渡带轻微过冲回弹；不做气球/连线视觉。
   大脑区块右上角的 ⇄ 按钮（与「大脑」标题同骑上边框线、中线对齐）一键切换整组。 */
.brain-swap-toggle {
  position: absolute;
  top: 0;
  right: 12px;
  transform: translateY(-50%); /* 与「大脑」标题一样骑跨上边框线、中线对齐 */
  z-index: 2;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 2px solid var(--terraria-edge-dark);
  border-radius: 0;
  background: var(--terraria-panel-deep);
  color: var(--terraria-muted);
  font-size: 12px;
  line-height: 1;
  box-shadow: 2px 2px 0 #0c0b0a;
  cursor: pointer;
  transition: border-color 0.15s ease, color 0.15s ease;

  &:hover {
    border-color: var(--terraria-gold);
    color: var(--terraria-gold);
  }
}

.choice-name,
.choice-model {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition:
    font-size 0.38s cubic-bezier(0.34, 1.3, 0.64, 1),
    line-height 0.38s cubic-bezier(0.34, 1.3, 0.64, 1),
    color 0.25s ease,
    text-shadow 0.25s ease;

  &.is-big {
    font-size: 18px;
    line-height: 1.15;
    color: var(--terraria-ink);
    font-weight: 700;
    letter-spacing: 0.02em;
    text-shadow: 2px 2px 0 #0c0b0a;
  }

  &.is-small {
    font-size: 9px; /* 超小字：用户明确要求 8-9px 级别 */
    line-height: 1.15;
    color: var(--terraria-muted);
    font-weight: 400;
    letter-spacing: 0.05em;
    text-shadow: 1px 1px 0 #0c0b0a;
  }
}

</style>

<!-- 胶囊 hover 详情（el-tooltip teleport 到 body，需非 scoped 全局样式） -->
<style lang="less">
.role-detail-popper.el-popper {
  --el-popper-padding: 0;
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--ink) 14%, transparent);
  border-radius: 8px;
  background: var(--surface-hover);
  box-shadow: 0 8px 22px color-mix(in srgb, var(--ink) 20%, transparent);
  color: var(--ink);

  .role-detail {
    display: grid;
    gap: 5px;
  }

  .role-detail-title {
    color: var(--ink);
    font-size: 14px;
    font-weight: 600;
    line-height: 1.3;
  }

  .role-detail-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 14px;
    font-size: 13px;
    line-height: 1.4;
    white-space: nowrap;
  }

  .role-detail-key {
    color: color-mix(in srgb, var(--ink) 54%, transparent);
  }

  .role-detail-value {
    color: color-mix(in srgb, var(--ink) 86%, transparent);
  }

  .sense-detail-tools {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    max-width: 240px;
  }

  .sense-detail-tool {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border: 1px solid color-mix(in srgb, var(--ink) 12%, transparent);
    border-radius: 6px;
    background: var(--surface);
    font-size: 13px;
    line-height: 1;
    cursor: default;
  }

  .sense-detail-empty {
    color: color-mix(in srgb, var(--ink) 44%, transparent);
    font-size: 13px;
  }
}
</style>
