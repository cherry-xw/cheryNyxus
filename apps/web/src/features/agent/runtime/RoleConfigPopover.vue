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
    /** 只读模式：仅展示资料卡、隐藏大脑/器官组选择区（workbench rail 角色 popout 用；
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

function isCapSupported(val: unknown): boolean {
  return val === true || val === 'supported'
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
            v-if="isCapSupported(brainConfig(selection.brain)?.capabilities?.input?.image)"
            content="模型支持图像输入"
            placement="top"
          >
            <span class="brain-fact-icon cap-input">🖼️</span>
          </el-tooltip>
          <el-tooltip
            v-if="isCapSupported(brainConfig(selection.brain)?.capabilities?.input?.video)"
            content="模型支持视频输入"
            placement="top"
          >
            <span class="brain-fact-icon cap-input">🎞️</span>
          </el-tooltip>
          <el-tooltip
            v-if="isCapSupported(brainConfig(selection.brain)?.capabilities?.input?.audio)"
            content="模型支持音频输入"
            placement="top"
          >
            <span class="brain-fact-icon cap-input">🔊</span>
          </el-tooltip>
          <el-tooltip
            v-if="isCapSupported(brainConfig(selection.brain)?.capabilities?.output?.image)"
            content="模型原生支持图像输出"
            placement="top"
          >
            <span class="brain-fact-icon cap-generate">🎨</span>
          </el-tooltip>
          <el-tooltip
            v-if="isCapSupported(brainConfig(selection.brain)?.capabilities?.output?.video)"
            content="模型原生支持视频输出"
            placement="top"
          >
            <span class="brain-fact-icon cap-generate">🎬</span>
          </el-tooltip>
          <el-tooltip
            v-if="isCapSupported(brainConfig(selection.brain)?.capabilities?.output?.audio)"
            content="模型原生支持音频输出"
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

<style scoped lang="less" src="./RoleConfigPopover.scoped.less"></style>

<!-- 胶囊 hover 详情（el-tooltip teleport 到 body，需非 scoped 全局样式） -->
<style lang="less" src="./RoleConfigPopover.popovers.less"></style>
