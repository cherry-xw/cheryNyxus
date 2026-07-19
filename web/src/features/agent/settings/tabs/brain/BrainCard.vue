<script setup lang="ts">
/**
 * BrainCard：单颗 brain 名片。
 * 从 BrainsTab 拆出，承载连接字段 + 运行能力 + 媒体能力矩阵。
 * 改名/复制/删除需操作 draft.llm.brain 全量（保序重建 + 迁移角色引用），故 prop 传 draft。
 */
import { CopyDocument, Delete, Refresh, Document } from '@element-plus/icons-vue'
import { ref, computed, watch } from 'vue'
import { ElMessageBox } from 'element-plus'
import {
  agentApi,
  type BrainConfigDto,
  type ConfigDto,
  type MediaCapabilitiesDto,
  type ThinkingLevel,
} from '@/services/agentApi'
import { PROVIDERS } from '../../config/constants'
import ConfirmDialog from '@/components/confirm/ConfirmDialog.vue'
import EditableTitle from '@/components/input/EditableTitle.vue'
import LabelTip from '../config/LabelTip.vue'
import ThinkingLevelKnob from '../../controls/ThinkingLevelKnob.vue'
import MediaCapabilityGrid from '../config/MediaCapabilityGrid.vue'

// Chevron icon (element-plus doesn't export a small one, use inline SVG)
const ChevronIcon = {
  template: `<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 2l4 4-4 4"/></svg>`,
}

const props = defineProps<{
  name: string
  idx: number
  cfg: BrainConfigDto
  draft: ConfigDto
  envVars: string[]
  detailMode?: boolean
}>()

const emit = defineEmits<{
  (e: 'error', msg: string): void
  (e: 'renamed', name: string): void
  (e: 'duplicated', name: string): void
}>()

const CONTEXT_LIMIT_OPTIONS = [128, 256, 512, 1024] as const

// 删大脑二次确认（重删 → ConfirmDialog 居中 modal）
const removeDialog = ref(false)
const removeImpact = computed(() => {
  const referringRoles = Object.entries(props.draft.roles ?? {})
    .filter(([, cfg]) => cfg.brain === props.name)
    .map(([name]) => name)
  return referringRoles.length
    ? [
        `引用此大脑的 ${referringRoles.length} 个角色（${referringRoles.join('、')}）将失去大脑绑定，需重新分配。`,
      ]
    : ['没有角色引用此大脑。']
})

// ── 折叠/展开 ────────────────────────────────────────────────────
const expanded = ref(props.detailMode ?? false)

/** 折叠态单行摘要：model / $KEY（provider 已由 avatar 上的 vendor logo 承载）。 */
const brainSummary = computed(() => {
  const parts: string[] = []
  if (props.cfg.model) parts.push(props.cfg.model)
  if (props.cfg.key) parts.push(props.cfg.key)
  return parts.length ? parts.join(' / ') : '未配置'
})

// ── model 下拉刷新 ──────────────────────────────────────────────
const modelOptions = ref<Array<{ id: string; name?: string }>>([])
const modelLoading = ref(false)

// ── 深度思考档位（按 model 后端查） ────────────────────────────────
/** 当前 brain 的 model 支持的 ThinkingLevel 子集；未拉取或失败时 = ["off","on"] 兜底。 */
const thinkingLevels = ref<readonly ThinkingLevel[]>(['off', 'on'])
let thinkingLevelsReqId = 0

async function refreshThinkingLevels(): Promise<void> {
  const model = props.cfg.model
  if (!model) {
    thinkingLevels.value = ['off', 'on']
    return
  }
  // 简易 debounce：取消在途请求（每次自增 reqId，回包时校验）
  const reqId = ++thinkingLevelsReqId
  try {
    const levels = await agentApi.getThinkingLevels([model])
    if (reqId !== thinkingLevelsReqId) return // 被新请求覆盖
    const got = levels[model]
    if (got && got.length > 0) {
      thinkingLevels.value = got
      // 若当前 cfg.thinking 不在新档位列表里，重置为第一个（不静默保存，留给用户感知）
      if (!got.includes(props.cfg.thinking ?? 'off')) {
        props.cfg.thinking = got[0]
      }
    } else {
      thinkingLevels.value = ['off', 'on']
    }
  } catch {
    if (reqId !== thinkingLevelsReqId) return
    thinkingLevels.value = ['off', 'on']
  }
}

// 监听 model 变化重新拉档位；首次挂载也拉一次
watch(
  () => props.cfg.model,
  () => {
    void refreshThinkingLevels()
  },
  { immediate: true },
)

async function refreshModels(): Promise<void> {
  const { provider, url, key } = props.cfg
  if (!provider || !url) {
    onError('请先填写适配器和地址')
    return
  }
  modelLoading.value = true
  try {
    const res = await agentApi.fetchModels(provider, url, key || undefined)
    if (res.error) {
      onError(res.error)
      return
    }
    modelOptions.value = res.models
  } catch (err) {
    onError(err instanceof Error ? err.message : String(err))
  } finally {
    modelLoading.value = false
  }
}

// ── helpers ───────────────────────────────────────────────────────

function onError(msg: string): void {
  emit('error', msg)
}

/** 设置页默认以 K 为单位编辑，配置仍保存完整数值。 */
function displayContextLimit(value: number | undefined): number | undefined {
  return value === undefined ? undefined : value / 1000
}
function updateContextLimit(cfg: { contextLimit?: number }, value: unknown): void {
  const limit = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(limit) || limit <= 0) return
  cfg.contextLimit = limit * 1000
}
function capabilities(cfg: BrainConfigDto) {
  return (cfg.capabilities ??= {})
}
function mediaCapabilities(cfg: BrainConfigDto, key: 'input' | 'generate') {
  const caps = capabilities(cfg)
  return (caps[key] ??= {})
}
function toggleMediaCapability(
  cfg: BrainConfigDto,
  group: 'input' | 'generate',
  kind: keyof MediaCapabilitiesDto,
): void {
  const media = mediaCapabilities(cfg, group)
  media[kind] = media[kind] !== true
}
function toolCallEnabled(cfg: BrainConfigDto): boolean {
  return cfg.capabilities?.toolCall !== false
}
function setToolCall(cfg: BrainConfigDto, value: unknown): void {
  capabilities(cfg).toolCall = value as boolean
  if (value === false) capabilities(cfg).generate = {}
}

// ── brain mutations ───────────────────────────────────────────────

function removeBrain(): void {
  delete props.draft.llm.brain[props.name]
}
/** 改名：保序重建 brain + 迁移 default/roles 引用。 */
function renameBrain(newName: string): void {
  const cfg = props.draft.llm.brain[props.name]
  if (!cfg) return
  // 重建对象保持原顺序（不能 delete+add，否则新 key 跳到末尾）
  const brains = props.draft.llm.brain
  const rebuilt = {} as typeof brains
  for (const [k, v] of Object.entries(brains)) {
    if (k === props.name) rebuilt[newName] = cfg
    else rebuilt[k] = v
  }
  props.draft.llm.brain = rebuilt
  // 迁移角色引用，避免 roles 指向已改名 brain 触发校验失败。
  if (props.draft.roles) {
    for (const sa of Object.values(props.draft.roles)) {
      if (sa.brain === props.name) sa.brain = newName
    }
  }
  emit('error', '')
  emit('renamed', newName)
}
function validateRename(newName: string): string | null {
  return props.draft.llm.brain[newName] ? `大脑 "${newName}" 已存在` : null
}
function duplicateBrain(): void {
  const src = props.draft.llm.brain[props.name]
  if (!src) return
  let newName = `${props.name}_copy`
  let i = 2
  while (props.draft.llm.brain[newName]) newName = `${props.name}_copy_${i++}`
  props.draft.llm.brain[newName] = structuredClone(src)
  emit('error', '')
  emit('duplicated', newName)
}

/**
 * 打开 .env 文件（密钥存储位置）。
 * 使用 utils.openFile RPC，让后端用配置的编辑器或系统默认打开。
 * 未配置编辑器时弹出提示，告知将使用系统默认编辑器。
 */
async function openEnvFile(): Promise<void> {
  // 检查是否已配置编辑器
  if (!props.draft.global.textEditor) {
    try {
      await ElMessageBox.alert(
        '未配置文本编辑器，将使用系统默认编辑器打开文件。如需指定编辑器，请在「⚙ 全局」设置中配置。',
        '提示',
        {
          confirmButtonText: '确定',
          type: 'info',
        },
      )
    } catch {
      // 用户关闭弹窗，继续执行
    }
  }

  try {
    await agentApi.openFile('.env')
  } catch (err) {
    onError(err instanceof Error ? err.message : '打开文件失败')
  }
}
</script>

<template>
  <article class="card" :class="{ 'brain-expanded': expanded, 'brain-detail-mode': detailMode }">
    <span class="card-idx">{{ idx + 1 }}</span>
    <header class="card-head brain-head" @click="!detailMode && (expanded = !expanded)">
      <ChevronIcon v-if="!detailMode" class="brain-chevron ico" :class="{ expanded }" />
      <EditableTitle
        :model-value="name"
        :validate="validateRename"
        @rename="renameBrain"
        @error="onError"
        @click.stop
      >
        <template #actions>
          <button type="button" class="icon-btn" aria-label="复制" @click.stop="duplicateBrain">
            <CopyDocument class="ico" />
          </button>
          <button
            type="button"
            class="icon-btn danger"
            aria-label="删除"
            @click.stop="removeDialog = true"
          >
            <Delete class="ico" />
          </button>
        </template>
      </EditableTitle>
    </header>
    <!-- 折叠态摘要 -->
    <div v-if="!expanded && !detailMode" class="brain-summary" @click="expanded = true">
      <span>{{ brainSummary }}</span>
    </div>
    <!-- 展开态详情 -->
    <div v-else class="brain-detail">
      <section class="brain-section">
        <div class="section-heading"><span>连接</span><small>模型与服务</small></div>
        <div class="brain-fields connection-fields">
          <label class="field field-wide">
            <LabelTip label="地址" tip="url：服务地址，可用 $ENV 占位从环境变量注入" />
            <el-input
              v-model="cfg.url"
              class="mono-input"
              placeholder="$OLLAMA_HOST 或 https://..."
            />
          </label>
          <label class="field">
            <LabelTip label="适配器" tip="provider：openai / ollama / mock，决定 API 方言" />
            <el-select v-model="cfg.provider" size="small">
              <el-option v-for="p in PROVIDERS" :key="p" :label="p" :value="p" />
            </el-select>
          </label>
          <label class="field">
            <span class="lbl">型号 *</span>
            <div class="model-input-row">
              <el-select
                v-model="cfg.model"
                filterable
                allow-create
                default-first-option
                class="mono-input model-select"
                placeholder="gpt-3.5-turbo"
                size="small"
              >
                <el-option
                  v-for="m in modelOptions"
                  :key="m.id"
                  :label="m.name ?? m.id"
                  :value="m.id"
                />
              </el-select>
              <button
                type="button"
                class="icon-btn refresh-btn"
                aria-label="刷新模型列表"
                :disabled="modelLoading"
                @click="refreshModels"
              >
                <Refresh class="ico" :class="{ spinning: modelLoading }" />
              </button>
            </div>
          </label>
          <div class="field">
            <div class="label-with-action">
              <LabelTip label="密钥" tip="key：API 密钥，从 .env 变量中选择（$ENV 占位符）" />
              <button
                type="button"
                class="icon-btn"
                aria-label="打开 .env 文件"
                title="打开 .env 文件编辑密钥"
                @click="openEnvFile"
              >
                <Document class="ico" />
              </button>
            </div>
            <el-select
              v-model="cfg.key"
              filterable
              allow-create
              clearable
              class="mono-input"
              placeholder="选择 .env 变量（如 $OPENAI_API_KEY）"
              size="small"
            >
              <el-option v-for="v in envVars" :key="v" :value="`$${v}`" :label="`$${v}`" />
            </el-select>
          </div>
        </div>
      </section>

      <section class="brain-section runtime-capability-section">
        <div class="section-heading">
          <span>运行与能力</span><small>上下文、推理、工具与媒体</small>
        </div>
        <div class="runtime-controls">
          <label class="field">
            <LabelTip label="记忆容量" tip="默认单位为 K；下拉可选常用容量，也可直接输入数值。" />
            <el-select
              filterable
              allow-create
              default-first-option
              :model-value="displayContextLimit(cfg.contextLimit)"
              placeholder="128"
              @update:model-value="(value: unknown) => updateContextLimit(cfg, value)"
            >
              <el-option
                v-for="limit in CONTEXT_LIMIT_OPTIONS"
                :key="limit"
                :label="`${limit}K`"
                :value="limit"
              />
            </el-select>
          </label>
          <label class="field">
            <LabelTip label="每分钟限额" tip="rpm：每分钟请求上限，空 = 不限" />
            <el-input-number v-model="cfg.rpm" :controls="false" placeholder="不限" />
          </label>
          <div class="compact-toggle">
            <div><span class="lbl">工具调用</span><span class="hint">允许调用工具</span></div>
            <el-switch
              :model-value="toolCallEnabled(cfg)"
              @change="(v: unknown) => setToolCall(cfg, v)"
            />
          </div>
          <div class="thinking-field">
            <LabelTip
              label="深度思考"
              tip="推理模型的思考强度档位（按当前 model 暴露不同档位）。off=不发思考参数；thinking=由模型决定；low/medium/high=强度递增（仅推理模型有效），需在「⚙ 全局」开启思考总闸。"
            />
            <ThinkingLevelKnob v-model="cfg.thinking" :levels="thinkingLevels" />
          </div>
        </div>
        <MediaCapabilityGrid
          :input="mediaCapabilities(cfg, 'input')"
          :generate="mediaCapabilities(cfg, 'generate')"
          :disabled="!toolCallEnabled(cfg)"
          @toggle="(group, kind) => toggleMediaCapability(cfg, group, kind)"
        />
      </section>
    </div>
    <ConfirmDialog
      v-model="removeDialog"
      icon="🗑️"
      :title="`删除大脑「${name}」？`"
      :impact="removeImpact"
      tab-color="#5ee7ff"
      @confirm="removeBrain"
    />
  </article>
</template>

<style scoped lang="less">
@import '../../config/shared.less';

.brain-head {
  cursor: pointer;
}
.brain-detail-mode .brain-head {
  cursor: default;
}

.brain-layout {
  display: grid;
  gap: 10px;
}

.brain-section {
  padding: 10px;
  border: 1px solid rgba(36, 38, 45, 0.09);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.46);
}

.section-heading {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin-bottom: 8px;

  > span {
    color: rgba(20, 22, 26, 0.8);
    font-size: 12px;
    font-weight: 800;
  }

  small {
    color: rgba(20, 22, 26, 0.42);
    font-size: 10px;
  }
}

// 「运行与能力」section：标题浮动脱流不占高，runtime-controls 上移与之重叠，降低卡片高度
.runtime-capability-section {
  position: relative;
}

.runtime-capability-section .section-heading {
  position: absolute;
  top: 10px;
  left: 10px;
  right: 25%; // 留右侧深度思考 knob 列位，避免遮挡
  margin-bottom: 0;
  z-index: 5;
}

.brain-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.connection-fields {
  grid-template-columns: repeat(3, minmax(0, 1fr));
  // 小尺寸 el-select（24px）配套：gap 缩小、label 字号 10px，与 .media-row 同模式。
  gap: 6px;
  .field {
    gap: 2px;
    :deep(.lbl) {
      font-size: 10px;
    }
  }
}

.label-with-action {
  display: flex;
  align-items: center;
  gap: 4px;

  .icon-btn {
    width: 12px;
    height: 12px;
    padding: 0;
    border: none;
    background: transparent;
    color: rgba(20, 22, 26, 0.38);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;

    &:hover {
      color: var(--tab-color, @accent);
    }

    .ico {
      width: 12px;
      height: 12px;
    }
  }
}

.field-wide {
  grid-column: 1 / -1;
}

.model-input-row {
  display: flex;
  gap: 4px;
  align-items: center;

  .model-select {
    flex: 1;
    min-width: 0;
  }
}

.refresh-btn {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(36, 38, 45, 0.12);
  border-radius: 5px;
  background: #fff;
  cursor: pointer;
  transition: background 0.15s;

  &:hover {
    background: rgba(36, 38, 45, 0.04);
  }
  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .ico {
    width: 12px;
    height: 12px;
  }
  .spinning {
    animation: spin 1s linear infinite;
  }
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

.runtime-controls {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  align-items: end;
}

.compact-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  height: 60px;
  padding: 7px 9px;
  border: 1px solid rgba(36, 38, 45, 0.1);
  border-radius: 6px;
  background: #fff;

  > div {
    display: grid;
    gap: 2px;
  }
}

// 深度思考旋钮（ThinkingLevelKnob）：与其他 3 列同宽，高度自适应 label-tip 模式
.thinking-field {
  display: grid;
  gap: 4px;
  align-self: end;
}

@media (max-width: 760px) {
  .runtime-controls {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  // 窄屏控件换行，标题浮动会遮挡控件 → 回正常流
  .runtime-capability-section .section-heading {
    position: static;
    right: auto;
    margin-bottom: 8px;
  }
}

@media (max-width: 420px) {
  .runtime-controls {
    grid-template-columns: 1fr;
  }
}
</style>
