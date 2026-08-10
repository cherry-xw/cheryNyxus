<script setup lang="ts">
/**
 * RoleConfigPopover：单角色编制配置卡（el-popover 内部内容）。
 * 从 AgentDialog 拆出，负责 brain/senseGroup 选择 + 资料卡展示。
 */
import { computed } from 'vue'
import type {
  BrainConfigDto,
  BrainInfo,
  ConfigDto,
  RuntimeSelection,
  SenseGroupOption,
  SenseToolInfo,
  ThinkingLevel,
} from '@/services/agentApi'

const props = defineProps<{
  role: string
  selection: RuntimeSelection
  brains: BrainInfo[]
  senseGroups: readonly SenseGroupOption[]
  config: ConfigDto | null
  senseTools: SenseToolInfo[]
  isPrimary: boolean
  primaryRole: string
}>()

const emit = defineEmits<{
  (e: 'update:selection', val: RuntimeSelection): void
}>()

// local computed for v-model:selection — two-way binding via getter/setter
const localSelection = computed({
  get: () => props.selection,
  set: (val) => emit('update:selection', val),
})

function brainInfo(name: string): BrainInfo | undefined {
  return props.brains.find((brain) => brain.name === name)
}

function brainConfig(name: string) {
  return props.config?.llm.brain[name]
}

/** 思考档位 → 显示文字（资料卡 💭 tooltip 用）。 */
const THINKING_LABEL: Record<ThinkingLevel, string> = {
  off: '关闭',
  on: '思考',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '最高',
}

/** 返回思考档位中文；off / 无配置 → null（不显示 💭）。 */
function thinkingLabel(cfg: BrainConfigDto | undefined): string | null {
  const level = cfg?.thinking ?? 'off'
  return level === 'off' ? null : (THINKING_LABEL[level] ?? null)
}

function supportsTools(brainName: string): boolean {
  return brainConfig(brainName)?.capabilities?.toolCall !== false
}

function selectBrain(selection: RuntimeSelection, brain: string): void {
  selection.brain = brain
  if (!supportsTools(brain)) {
    selection.senseGroup = ''
    selection.mcpServers = []
  } else if (!selection.senseGroup) {
    selection.senseGroup =
      props.senseGroups.find((g) => g.default)?.name ?? props.senseGroups[0]?.name ?? ''
  }
}

function senseEntries(group: string): string[] {
  return props.config?.sense_groups?.[group] ?? []
}

function senseName(entry: string): string {
  return entry.split(':')[0] ?? entry
}

function senseTool(entry: string): SenseToolInfo | undefined {
  return props.senseTools.find((tool) => tool.name === senseName(entry))
}

function formatContextLimit(limit: number | undefined): string {
  if (limit === undefined) return '—'
  if (limit >= 1000) return `${Math.round(limit / 1000)}k`
  return String(limit)
}

/** 当前角色在 config.roles 中的默认 brain / senseGroup（无配置 → 空串，不标 ★）。 */
const roleDefault = computed<{ brain: string; senseGroup: string }>(() => {
  const cfg = props.config?.roles?.[props.role]
  return {
    brain: cfg?.brain ?? '',
    senseGroup: cfg?.senseGroup ?? '',
  }
})
</script>

<template>
  <el-card shadow="never" class="role-card" :aria-label="`${role} 的临时编制`">
    <div class="profile-hero">
      <el-avatar :size="52" class="profile-avatar">{{ role.slice(0, 1) }}</el-avatar>
      <div class="profile-identity">
        <strong>{{ role }}</strong>
        <div class="profile-summary">
          <span class="identity-kind">{{ isPrimary ? '♛ 小组组长' : '✦ 小组成员' }}</span>
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

    <div class="profile-settings">
      <section class="profile-setting">
        <div class="setting-heading">
          <span class="setting-icon">◈</span>
          <span>大脑</span>
        </div>
        <div class="choice-list" role="radiogroup" aria-label="选择模型">
          <span v-for="brain in brains" :key="brain.name" class="choice-slot">
            <button
              type="button"
              class="choice-option"
              :class="{ selected: localSelection.brain === brain.name }"
              :aria-checked="localSelection.brain === brain.name"
              role="radio"
              @click="selectBrain(localSelection, brain.name)"
            >
              <span class="choice-option-label">{{ brain.name }}</span>
              <span v-if="brain.name === roleDefault.brain" class="choice-default" aria-label="默认"
                >★</span
              >
            </button>
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
          </span>
        </div>
      </section>
      <p v-else class="runtime-note">该模型不支持 Tool Call，仅可进行对话与已标记的媒体理解。</p>
    </div>
    <div class="runtime-note">仅本次会话，服务重启后失效</div>
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
  background: linear-gradient(
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
  font-size: 20px;
  font-weight: 800;
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
    font-size: 16px;
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
  color: var(--accent-ink);
  font-weight: 750;
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
  font-size: 10px;

  .brain-fact-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  b {
    margin-right: 3px;
    color: color-mix(in srgb, var(--ink) 42%, transparent);
    font-weight: 700;
  }

  .brain-fact-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border: 1px solid color-mix(in srgb, var(--ink) 12%, transparent);
    background: var(--surface-soft);
    font-size: 11px;
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
  font-size: 11px;
  cursor: pointer;
}

.profile-settings {
  display: grid;
  grid-template-columns: 3fr 2fr;
  gap: 6px;
}

.profile-setting {
  min-width: 0;
  padding: 7px 8px;
  border: 1px solid color-mix(in srgb, var(--ink) 10%, transparent);
  border-radius: 8px;
  background: var(--surface);
}

.sense-setting {
  background: var(--surface-soft);
}

.setting-heading {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 4px;
  color: color-mix(in srgb, var(--ink) 68%, transparent);
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.03em;
}

.setting-icon {
  color: #d99717;
  font-size: 13px;
  line-height: 1;
}

.choice-list {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 3px;
  interpolate-size: allow-keywords;
}

.choice-slot {
  position: relative;
  display: inline-block;
  flex: none;
  width: 64px;
  height: 21px;
}

.choice-option {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  min-width: 100%;
  max-width: 100%;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 5px;
  overflow: hidden;
  border: 1px solid transparent;
  border-radius: 5px;
  background: color-mix(in srgb, var(--ink) 4.5%, transparent);
  color: color-mix(in srgb, var(--ink) 64%, transparent);
  font: inherit;
  font-size: 10px;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
  transition:
    width 0.18s ease,
    max-width 0.18s ease,
    background-color 0.15s ease,
    border-color 0.15s ease,
    color 0.15s ease;

  &:hover {
    z-index: 2;
    width: max-content;
    max-width: max-content;
    overflow: visible;
    background: var(--surface-hover);
    box-shadow: 0 2px 7px color-mix(in srgb, var(--ink) 14%, transparent);
    color: color-mix(in srgb, var(--ink) 82%, transparent);
  }

  &.selected {
    border-color: color-mix(in srgb, var(--accent) 33%, transparent);
    background: color-mix(in srgb, var(--accent) 16%, transparent);
    color: var(--accent-ink);
    font-weight: 750;

    &:hover {
      background: color-mix(in srgb, var(--accent) 15%, transparent);
    }
  }
}

.choice-option-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.choice-default {
  flex: none;
  color: #bd8215;
  font-size: 10px;
  line-height: 1;
  text-shadow: 0 1px 0 rgba(255, 255, 255, 0.65);
}

.runtime-note {
  color: color-mix(in srgb, var(--ink) 46%, transparent);
  font-size: 9px;
  line-height: 1.2;
  text-align: right;
}

@media (max-width: 440px) {
  .profile-settings {
    grid-template-columns: 1fr;
  }
}
</style>
