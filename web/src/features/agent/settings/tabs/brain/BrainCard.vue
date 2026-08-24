<script setup lang="ts">
/**
 * BrainCard：单颗 brain 名片。
 * 从 BrainsTab 拆出，承载连接字段 + 运行能力 + 媒体能力矩阵。
 * 改名/复制/删除需操作 draft.llm.brain 全量（保序重建 + 迁移角色引用），故 prop 传 draft。
 */
import { CopyDocument, Delete, Refresh, Document } from '@element-plus/icons-vue'
import { ref, computed, watch, toRaw } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  agentApi,
  type BrainConfigDto,
  type ConfigDto,
  type MediaCapabilitiesDto,
  type ThinkingLevel,
} from '@/services/agentApi'
import { PROVIDERS } from '../../config/constants'
import { PROVIDER_META, isProviderLabelRedundant, isProviderIconAsset } from './providerMeta'
import ConfirmPopover from '@/components/confirm/ConfirmPopover.vue'
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

// ── 密钥下拉刷新 ────────────────────────────────────────────────
/** 本地副本：初始来自父级 envVars，刷新按钮重拉 env.list 更新（用户改 .env 后立即可见）。 */
const keyOptions = ref<string[]>([...props.envVars])
const keyLoading = ref(false)
watch(
  () => props.envVars,
  (vars) => {
    keyOptions.value = [...vars]
  },
)
async function refreshKeyOptions(): Promise<void> {
  keyLoading.value = true
  try {
    keyOptions.value = await agentApi.listEnvVars()
  } catch (err) {
    onError(err instanceof Error ? err.message : '刷新密钥列表失败')
  } finally {
    keyLoading.value = false
  }
}

type ConnectionTestState = 'idle' | 'pending' | 'success' | 'error'
const connectionTestState = ref<ConnectionTestState>('idle')
const connectionTestMessage = ref('')
const isMockProvider = computed(() => props.cfg.provider === 'mock')
let connectionTestReqId = 0

watch(
  () => [props.cfg.provider, props.cfg.url, props.cfg.key, props.cfg.model] as const,
  () => {
    connectionTestReqId += 1
    connectionTestState.value = 'idle'
    connectionTestMessage.value = ''
  },
)

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
    connectionTestState.value = 'error'
    connectionTestMessage.value = '请先填写适配器和地址'
    return
  }
  modelLoading.value = true
  try {
    const res = await agentApi.fetchModels(provider, url, key || undefined)
    if (res.error) {
      connectionTestState.value = 'error'
      connectionTestMessage.value = res.error
      return
    }
    modelOptions.value = res.models
    // 刷新成功：清掉之前的错误提示（与测试连接共用同一消息区）
    connectionTestState.value = 'idle'
    connectionTestMessage.value = ''
  } catch (err) {
    connectionTestState.value = 'error'
    connectionTestMessage.value = err instanceof Error ? err.message : String(err)
  } finally {
    modelLoading.value = false
  }
}

async function testConnection(): Promise<void> {
  const { provider, url, key, model } = props.cfg
  if (provider === 'mock') return
  if (!provider || !url || !model) {
    connectionTestState.value = 'error'
    connectionTestMessage.value = '请先填写适配器、地址和型号'
    return
  }

  const reqId = ++connectionTestReqId
  connectionTestState.value = 'pending'
  connectionTestMessage.value = ''
  try {
    const result = await agentApi.testConnection(provider, url, key || undefined, model)
    if (reqId !== connectionTestReqId) return
    if (result.ok) {
      connectionTestState.value = 'success'
      connectionTestMessage.value = '连接成功'
    } else {
      connectionTestState.value = 'error'
      connectionTestMessage.value = result.error
    }
  } catch (err) {
    if (reqId !== connectionTestReqId) return
    connectionTestState.value = 'error'
    connectionTestMessage.value = err instanceof Error ? err.message : String(err)
  }
}

// ── helpers ───────────────────────────────────────────────────────

function onError(msg: string): void {
  emit('error', msg)
}

/** 模板占位符（如 <YOUR_OPENAI_COMPATIBLE_URL>）视为空：不渲染占位文本，仅显示 placeholder。 */
const PLACEHOLDER_PATTERN = /^<[^>]*>$/
function isTemplatePlaceholder(value: string | undefined): boolean {
  return !!value && PLACEHOLDER_PATTERN.test(value.trim())
}
/** 地址输入框模型：模板占位符显示为空（placeholder 呈现），写入时按真实值落草稿。 */
const urlModel = computed({
  get: () => (isTemplatePlaceholder(props.cfg.url) ? '' : (props.cfg.url ?? '')),
  set: (v: string) => {
    props.cfg.url = v
  },
})

// ── info tip 文案（结构化多行，.label-tip-popper pre-line 渲染，\n 分点） ──
const ADAPTER_TIP = [
  'provider：决定 API 方言，支持：',
  '· openai / deepseek / ollama —— OpenAI 兼容协议',
  '· 智谱 / anthropic —— 各自原生协议',
  '· mock —— 离线模拟，无需网络',
  '',
  '选 anthropic 时右侧「官方」勾选框开启 redacted_thinking 完整回传协议；关闭则按兼容模式处理。',
].join('\n')
const KEY_TIP = [
  'key：API 密钥，从 .env 变量中选择（$ENV 占位符）。',
  '· 本地服务（LM Studio / vLLM / Ollama OpenAI 模式）不校验 key，可直接输入任意字符串（如 lm-studio）',
  '· 留空会触发运行期鉴权失败',
  '',
  '修改 .env 后点右侧「刷新」按钮，新密钥立即可选并生效，无需重启。',
].join('\n')
const URL_TIP = [
  'url：请求地址，支持 $ENV 占位从环境变量注入。',
  '· 未勾选「完整 URL」：自动补全——无路径时补版本段+端点（openai/deepseek/bigmodel → …/v1/chat/completions，anthropic → …/v1/messages）；已含版本段（如 /v1）只拼端点',
  '· 勾选「完整 URL」：后端不拼接任何字符串，请求地址即你填写的整个 URL（须含版本段与端点，如 https://api.openai.com/v1/chat/completions）',
  '· ollama 填 host（如 http://localhost:11434），无版本段概念',
].join('\n')

/** 复制文本到剪贴板（非 HTTPS / 旧 Electron 走 execCommand 降级）。 */
async function copyMessage(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
    } else {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    ElMessage.success('已复制')
  } catch {
    ElMessage.error('复制失败')
  }
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

/** 当前 brain 是否官方 Anthropic（影响 redacted_thinking 回传策略）；
 *  仅 provider=anthropic 时生效；其它 provider 始终 false。 */
function anthropicOfficial(cfg: BrainConfigDto): boolean {
  return cfg.provider === 'anthropic' && cfg.anthropicCompat?.official === true
}
function setAnthropicOfficial(cfg: BrainConfigDto, value: unknown): void {
  if (cfg.provider !== 'anthropic') return
  if (!cfg.anthropicCompat) cfg.anthropicCompat = {}
  cfg.anthropicCompat.official = value === true
}

/** 地址输入框示例（随 provider 变化；未勾选默认自动补全版本段+端点，勾选「完整 URL」则提示填完整请求地址） */
const urlPlaceholder = computed(() => {
  if (props.cfg.provider === 'ollama') return '如 http://localhost:11434'
  if (props.cfg.provider === 'mock') return 'mock 无需真实地址'
  if (props.cfg.fullUrl === true) {
    return props.cfg.provider === 'anthropic'
      ? '完整 URL，如 https://api.anthropic.com/v1/messages'
      : '完整 URL，如 https://api.openai.com/v1/chat/completions'
  }
  if (props.cfg.provider === 'anthropic') {
    return '如 https://api.anthropic.com → 自动补全为 …/v1/messages'
  }
  return '如 https://api.openai.com → 自动补全为 …/v1/chat/completions'
})

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
  props.draft.llm.brain[newName] = structuredClone(toRaw(src))
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
          <ConfirmPopover
            :title="`删除大脑「${name}」？`"
            :impact="removeImpact"
            @confirm="removeBrain"
          >
            <template #trigger>
              <button type="button" class="icon-btn danger" aria-label="删除" @click.stop>
                <Delete class="ico" />
              </button>
            </template>
          </ConfirmPopover>
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
        <div class="section-heading connection-heading">
          <span class="heading-text">连接<small>模型与服务</small></span>
          <button
            type="button"
            class="connection-test-btn"
            :class="{ pending: connectionTestState === 'pending' }"
            :disabled="connectionTestState === 'pending' || isMockProvider"
            :title="isMockProvider ? '离线模拟无需测试' : '测试地址与密钥是否连通'"
            @click="testConnection"
          >
            <span v-if="connectionTestState === 'pending'" class="dot spinning" />
            <span
              v-else
              class="dot"
              :class="{
                success: connectionTestState === 'success',
                error: connectionTestState === 'error',
                idle: connectionTestState === 'idle',
              }"
            />
            {{ connectionTestState === 'pending' ? '测试中' : '测试连接' }}
          </button>
          <el-tooltip
            v-if="
              isMockProvider || connectionTestState === 'success' || connectionTestState === 'error'
            "
            :content="isMockProvider ? '离线模拟无需测试' : connectionTestMessage"
            placement="top"
            :show-after="120"
          >
            <div
              class="connection-test-message"
              :class="connectionTestState === 'idle' ? 'muted' : connectionTestState"
            >
              <span class="message-text">{{
                isMockProvider ? '离线模拟无需测试' : connectionTestMessage
              }}</span>
              <button
                v-if="!isMockProvider"
                type="button"
                class="copy-btn"
                aria-label="复制消息"
                title="复制完整消息"
                @click.stop="copyMessage(connectionTestMessage)"
              >
                <CopyDocument class="ico" />
              </button>
            </div>
          </el-tooltip>
        </div>
        <div class="brain-fields connection-fields">
          <label class="field field-wide">
            <LabelTip label="地址" :tip="URL_TIP" />
            <div class="url-input-row">
              <el-input
                v-model="urlModel"
                class="mono-input"
                :placeholder="urlPlaceholder"
              />
              <el-tooltip
                content="勾选=后端不拼接任何字符串，请求地址即填写的整个 URL（须含版本段与端点）；未勾选=无路径时自动补 /v1 + 端点"
                placement="top"
                :show-after="120"
              >
                <el-checkbox
                  :model-value="cfg.fullUrl === true"
                  class="fullurl-checkbox"
                  @change="(v: unknown) => (cfg.fullUrl = v === true)"
                >
                  完整 URL
                </el-checkbox>
              </el-tooltip>
            </div>
          </label>
          <label class="field">
            <LabelTip label="适配器" :tip="ADAPTER_TIP" />
            <div class="provider-row">
              <el-select v-model="cfg.provider" size="small" class="provider-select">
                <el-option v-for="p in PROVIDERS" :key="p" :value="p">
                  <template #default>
                    <span class="provider-option">
                      <img
                        v-if="isProviderIconAsset(p)"
                        class="provider-icon-img"
                        :src="PROVIDER_META[p].icon"
                        :alt="PROVIDER_META[p].label"
                      />
                      <span v-else class="provider-icon-emoji" aria-hidden="true">{{
                        PROVIDER_META[p].icon
                      }}</span>
                      <!-- 中文在前、英文在后；同名折叠：openai/OpenAI、ollama/Ollama、anthropic/Anthropic 折叠为仅 label；mock / bigmodel 显示「value · label」 -->
                      <template v-if="isProviderLabelRedundant(p)">
                        <span class="provider-label">{{ PROVIDER_META[p].label }}</span>
                      </template>
                      <template v-else>
                        <span class="provider-label">{{ PROVIDER_META[p].label }}</span>
                        <span class="provider-sep">·</span>
                        <span class="provider-value">{{ p }}</span>
                      </template>
                    </span>
                  </template>
                </el-option>
              </el-select>
              <el-checkbox
                v-if="cfg.provider === 'anthropic'"
                :model-value="anthropicOfficial(cfg)"
                class="official-checkbox"
                @change="(v: unknown) => setAnthropicOfficial(cfg, v)"
              >
                官方
              </el-checkbox>
            </div>
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
              <el-tooltip
                :content="modelLoading ? '正在获取模型列表…' : '获取最新模型列表；亦可测试连通'"
                placement="top"
                :show-after="120"
                :disabled="false"
              >
                <button
                  type="button"
                  class="icon-btn refresh-btn"
                  aria-label="刷新模型列表"
                  :disabled="modelLoading"
                  @click="refreshModels"
                >
                  <Refresh class="ico" :class="{ spinning: modelLoading }" />
                </button>
              </el-tooltip>
            </div>
          </label>
          <div class="field">
            <div class="label-with-action">
              <LabelTip label="密钥" :tip="KEY_TIP" />
              <button
                type="button"
                class="icon-btn"
                aria-label="打开 .env 文件"
                title="打开 .env 文件编辑密钥"
                @click="openEnvFile"
              >
                <Document class="ico" />
              </button>
              <button
                type="button"
                class="icon-btn"
                aria-label="刷新密钥列表"
                title="重新读取 .env，刷新密钥下拉选项"
                :disabled="keyLoading"
                @click="refreshKeyOptions"
              >
                <Refresh class="ico" :class="{ spinning: keyLoading }" />
              </button>
            </div>
            <el-select
              v-model="cfg.key"
              filterable
              allow-create
              clearable
              class="mono-input"
              placeholder="选择 .env 变量（如 OPENAI_API_KEY）"
              size="small"
            >
              <el-option v-for="v in keyOptions" :key="v" :value="`$${v}`" :label="v" />
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
              tip="推理模型的思考强度档位（按当前 model 暴露不同档位）。off=关闭；on=由模型决定；low/medium/high/xhigh 由 provider 映射，需在「⚙ 全局」开启思考总闸。"
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
  border: 1px solid color-mix(in srgb, var(--ink) 9%, transparent);
  border-radius: 8px;
  background: var(--surface-soft);
}

.section-heading {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin-bottom: 8px;

  > span {
    color: color-mix(in srgb, var(--ink) 80%, transparent);
    font-size: 12px;
    font-weight: 600;
  }

  small {
    color: color-mix(in srgb, var(--ink) 62%, transparent);
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

// 连接 section 标题：左侧标题、右侧测试连接按钮（与大脑模块同色调）
.connection-heading {
  align-items: center;

  .heading-text {
    display: inline-flex;
    align-items: baseline;
    gap: 6px;
  }
}

.connection-test-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px;
  font-size: 10.5px;
  font-weight: 600;
  color: color-mix(in srgb, var(--tab-color, @accent) 78%, @ink);
  background: color-mix(in srgb, var(--tab-color, @accent) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--tab-color, @accent) 35%, transparent);
  border-radius: 999px;
  cursor: pointer;
  transition:
    background 0.15s,
    border-color 0.15s,
    color 0.15s;

  &:hover:not(:disabled) {
    background: color-mix(in srgb, var(--tab-color, @accent) 18%, transparent);
    border-color: color-mix(in srgb, var(--tab-color, @accent) 55%, transparent);
  }

  &:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: color-mix(in srgb, var(--ink) 25%, transparent);

    &.success {
      background: var(--el-color-success);
    }
    &.error {
      background: var(--el-color-danger);
    }
    &.idle {
      background: color-mix(in srgb, var(--ink) 25%, transparent);
    }

    &.spinning {
      background: transparent;
      border: 1.5px solid color-mix(in srgb, var(--tab-color, @accent) 45%, transparent);
      border-top-color: color-mix(in srgb, var(--tab-color, @accent) 90%, transparent);
      animation: spin 0.8s linear infinite;
    }
  }
}

.connection-test-message {
  margin-left: 12px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  max-width: 280px;

  &.success {
    color: var(--el-color-success);
  }
  &.error {
    color: var(--el-color-danger);
  }
  &.muted {
    color: color-mix(in srgb, var(--ink) 62%, transparent);
  }
}

.message-text {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.copy-btn {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  padding: 0;
  border: none;
  background: transparent;
  color: color-mix(in srgb, var(--ink) 32%, transparent);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 3px;
  transition:
    background 0.12s,
    color 0.12s;

  &:hover {
    color: var(--tab-color, @accent);
    background: color-mix(in srgb, var(--ink) 4%, transparent);
  }

  .ico {
    width: 11px;
    height: 11px;
  }
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

// 适配器下拉 + 官方勾选框：同行 flex，仅 anthropic 时显示官方 checkbox
.provider-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.provider-select {
  flex: 1;
  min-width: 0;
}
// 地址输入框 + 「完整 URL」勾选：同行 flex，勾选态语义见 urlPlaceholder/tip
.url-input-row {
  display: flex;
  align-items: center;
  gap: 8px;
  .mono-input {
    flex: 1;
    min-width: 0;
  }
}
.fullurl-checkbox {
  // 同 official-checkbox：主题色勾选 + 固定高度对齐 + 不被压缩换行
  --el-checkbox-checked-bg-color: var(--tab-color, @accent);
  --el-checkbox-checked-border-color: var(--tab-color, @accent);
  --el-checkbox-checked-input-border-color: var(--tab-color, @accent);
  --el-checkbox-checked-icon-color: #fff;
  height: 24px;
  display: inline-flex;
  align-items: center;
  margin: 0;
  padding: 0;
  flex-shrink: 0;
  white-space: nowrap;
}
// el-checkbox 主题色覆盖：勾选态用 tab 主题色（取代默认 primary 蓝）
.official-checkbox {
  --el-checkbox-checked-bg-color: var(--tab-color, @accent);
  --el-checkbox-checked-border-color: var(--tab-color, @accent);
  --el-checkbox-checked-input-border-color: var(--tab-color, @accent);
  --el-checkbox-checked-icon-color: #fff;
  // 固定高度 = el-select size=small 的 24px，与 select 同行中线对齐
  height: 24px;
  display: inline-flex;
  align-items: center;
  margin: 0;
  padding: 0;
  flex-shrink: 0;
  white-space: nowrap;
  font-size: 11px;
  font-weight: 600;
  color: color-mix(in srgb, var(--ink) 60%, transparent);

  :deep(.el-checkbox__label) {
    font-size: 11px;
    font-weight: 600;
    line-height: 1;
    padding-left: 4px;
    color: color-mix(in srgb, var(--ink) 60%, transparent);
  }
  :deep(.el-checkbox__input.is-checked + .el-checkbox__label) {
    color: var(--tab-color, @accent);
  }
}

// 适配器下拉选项：icon + 「value·label」或仅 label（同名时省略 value）
.provider-option {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  line-height: 1;

  .provider-icon-img {
    width: 14px;
    height: 14px;
    object-fit: contain;
    flex-shrink: 0;
  }

  .provider-icon-emoji {
    font-size: 13px;
    line-height: 1;
    // emoji 字体回退，跟全局 sense-icon 保持一致
    font-family:
      ui-rounded, 'Hiragino Sans', 'PingFang SC', 'Noto Sans Symbols 2', 'Apple Color Emoji',
      'Segoe UI Emoji', sans-serif;
  }

  .provider-value {
    color: color-mix(in srgb, var(--ink) 55%, transparent);
    font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
    font-size: 11px;
  }

  .provider-sep {
    color: color-mix(in srgb, var(--ink) 30%, transparent);
    margin: 0 2px;
  }

  .provider-label {
    color: color-mix(in srgb, var(--ink) 86%, transparent);
    font-weight: 600;
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
    color: color-mix(in srgb, var(--ink) 60%, transparent);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;

    &:hover {
      color: var(--tab-color, @accent);
    }
    &:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .ico {
      width: 12px;
      height: 12px;
    }
    .ico.spinning {
      animation: spin 1s linear infinite;
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
  border: 1px solid color-mix(in srgb, var(--ink) 12%, transparent);
  border-radius: 5px;
  background: var(--surface);
  cursor: pointer;
  transition: background 0.15s;

  &:hover {
    background: color-mix(in srgb, var(--ink) 4%, transparent);
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
  border: 1px solid color-mix(in srgb, var(--ink) 10%, transparent);
  border-radius: 6px;
  background: var(--surface);
  // el-switch 开启态跟随 tab 主题色（取代默认 primary 蓝）
  --el-switch-on-color: var(--tab-color, @accent);

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
