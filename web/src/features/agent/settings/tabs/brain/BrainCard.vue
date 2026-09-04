<script setup lang="ts">
/** Brain editor card; every setting change mutates the parent draft only. */
import { CopyDocument, Delete, Refresh, Document } from '@element-plus/icons-vue'
import { ref, computed, watch, toRaw } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  agentApi,
  type BrainConfigDto,
  type ConfigDto,
  type MediaCapabilitiesDto,
} from '@/application/backend/public'
import { PROVIDERS } from '../../config/constants'
import { PROVIDER_META, isProviderLabelRedundant, isProviderIconAsset } from './providerMeta'
import ConfirmPopover from '@/components/confirm/ConfirmPopover.vue'
import EditableTitle from '@/features/agent/settings/controls/EditableTitle.vue'
import LabelTip from '../config/LabelTip.vue'
import ThinkingLevelKnob from '../../controls/ThinkingLevelKnob.vue'
import MediaCapabilityGrid from '../config/MediaCapabilityGrid.vue'
import { useModelRecommendation } from './useModelRecommendation'
import {
  LLM_PROTOCOL_CATALOG,
  findLlmProviderDefinition,
  legacyProtocolForProvider,
  resolveLlmProviderDefaultUrl,
  type LlmProtocol,
} from '@chery/protocol'

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

const CONTEXT_LIMIT_OPTIONS = [128, 250, 256, 512, 1024] as const

/** 模板占位符（如 <YOUR_OPENAI_COMPATIBLE_URL>）视为空：不渲染占位文本，仅显示 placeholder。 */
const PLACEHOLDER_PATTERN = /^<[^>]*>$/
function isTemplatePlaceholder(value: string | undefined): boolean {
  return !!value && PLACEHOLDER_PATTERN.test(value.trim())
}

const providerDefinition = computed(() => findLlmProviderDefinition(props.cfg.provider))
const supportedProtocols = computed(() => providerDefinition.value?.protocols ?? [])
const effectiveProtocol = computed<LlmProtocol | undefined>(
  () =>
    props.cfg.protocol ??
    legacyProtocolForProvider(props.cfg.provider) ??
    providerDefinition.value?.defaultProtocol,
)
const protocolModel = computed<LlmProtocol | undefined>({
  get: () => effectiveProtocol.value,
  set: (value) => {
    const previousDefault = resolveLlmProviderDefaultUrl(
      props.cfg.provider,
      effectiveProtocol.value,
    )
    const shouldReplaceUrl =
      !props.cfg.url || isTemplatePlaceholder(props.cfg.url) || props.cfg.url === previousDefault
    props.cfg.protocol = value
    const nextDefault = resolveLlmProviderDefaultUrl(props.cfg.provider, value)
    if (shouldReplaceUrl && nextDefault) props.cfg.url = nextDefault
  },
})
function protocolLabel(protocol: LlmProtocol): string {
  return LLM_PROTOCOL_CATALOG.find((entry) => entry.id === protocol)?.label ?? protocol
}

watch(
  () => props.cfg.provider,
  (provider, previous) => {
    if (provider === previous) return
    const definition = findLlmProviderDefinition(provider)
    if (!definition) return
    const previousDefinition = findLlmProviderDefinition(previous)
    const previousDefaults = new Set(
      [
        previousDefinition?.defaultUrl,
        ...Object.values(previousDefinition?.protocolUrls ?? {}),
      ].filter((url): url is string => typeof url === 'string'),
    )
    const shouldReplaceUrl =
      !props.cfg.url || isTemplatePlaceholder(props.cfg.url) || previousDefaults.has(props.cfg.url)
    props.cfg.protocol = definition.defaultProtocol
    const nextDefault = resolveLlmProviderDefaultUrl(provider, definition.defaultProtocol)
    if (shouldReplaceUrl && nextDefault) props.cfg.url = nextDefault
  },
)

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
const isMockProvider = computed(() => effectiveProtocol.value === 'mock')
let connectionTestReqId = 0

const MODELS_SUGGESTION_MARKER = '；排查建议：'
const connectionTestMessageView = computed(() => {
  const message = connectionTestMessage.value
  const markerIndex = message.indexOf(MODELS_SUGGESTION_MARKER)
  if (markerIndex < 0) return { original: message, suggestion: '' }
  return {
    original: message.slice(0, markerIndex),
    suggestion: message.slice(markerIndex + MODELS_SUGGESTION_MARKER.length),
  }
})

/**
 * 测试连接按钮禁用原因（null=可测）：前置字段缺失时按钮置灰 + 悬停引导缺什么，
 * 而非可点后报错——交互上先选后测。
 */
const connectionBlockedBy = computed<string | null>(() => {
  if (isMockProvider.value) return '离线模拟无需测试'
  if (!props.cfg.provider) return '请先选择服务'
  if (!effectiveProtocol.value) return '请先选择 API 协议'
  // url/model 可能是模板占位符（<YOUR_...>）：UI 显示为空但字符串非空，须归一后判断
  if (!props.cfg.url || isTemplatePlaceholder(props.cfg.url)) return '请先填写地址'
  if (!props.cfg.key) return '请先填写密钥'
  if (!props.cfg.model || isTemplatePlaceholder(props.cfg.model)) return '请先选择模型'
  return null
})
/** 测试连接按钮禁用：pending 中或前置字段缺失。 */
const connectionTestDisabled = computed(
  () => connectionTestState.value === 'pending' || connectionBlockedBy.value !== null,
)
/** 按钮悬停提示：pending → 测试中；字段缺失 → 缺什么；否则 → 连通说明。 */
const connectionTestTip = computed(() => {
  if (connectionTestState.value === 'pending') return '正在测试连接…'
  return connectionBlockedBy.value ?? '测试地址与密钥是否连通'
})

/** 刷新模型按钮禁用原因（null=可点）：mock 无需拉取模型；缺失前置字段置灰 + 悬停引导。 */
const refreshModelsBlockedBy = computed<string | null>(() => {
  if (isMockProvider.value) return '离线模拟无需刷新模型'
  if (!props.cfg.provider) return '请先选择服务'
  if (!effectiveProtocol.value) return '请先选择 API 协议'
  if (!props.cfg.url || isTemplatePlaceholder(props.cfg.url)) return '请先填写地址'
  if (!props.cfg.key) return '请先填写密钥'
  return null
})
const refreshModelsDisabled = computed(
  () => modelLoading.value || refreshModelsBlockedBy.value !== null,
)
const refreshTip = computed(() => {
  if (modelLoading.value) return '正在获取模型列表…'
  return refreshModelsBlockedBy.value ?? '获取最新模型列表；亦可测试连通'
})

watch(
  () =>
    [
      props.cfg.provider,
      props.cfg.protocol,
      props.cfg.url,
      props.cfg.key,
      props.cfg.model,
    ] as const,
  () => {
    connectionTestReqId += 1
    connectionTestState.value = 'idle'
    connectionTestMessage.value = ''
  },
)

// ── 模型目录识别、推荐与 thinking wire 档位 ───────────────────────
const { contextLimitTip, modelRuleNotice, modelUnmatched, thinkingLevels, thinkingTip } =
  useModelRecommendation({
  cfg: props.cfg,
  effectiveProtocol: () => effectiveProtocol.value,
  supportedProtocols: () => supportedProtocols.value,
  setProtocol: (protocol) => {
    protocolModel.value = protocol
  },
  isPlaceholderModel: isTemplatePlaceholder,
})

async function refreshModels(): Promise<void> {
  const { provider, url, key } = props.cfg
  if (!provider || !url) {
    connectionTestState.value = 'error'
    connectionTestMessage.value = '请先选择服务、协议并填写地址'
    return
  }
  modelLoading.value = true
  try {
    const res = await agentApi.fetchModels(
      provider,
      url,
      key || undefined,
      props.cfg.fullUrl === true,
      effectiveProtocol.value,
    )
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
    connectionTestMessage.value = '请先选择服务、协议并填写地址和模型'
    return
  }

  const reqId = ++connectionTestReqId
  connectionTestState.value = 'pending'
  connectionTestMessage.value = ''
  try {
    const result = await agentApi.testConnection(
      provider,
      url,
      key || undefined,
      model,
      props.cfg.fullUrl === true,
      effectiveProtocol.value,
    )
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

/** 地址输入框模型：模板占位符显示为空（placeholder 呈现），写入时按真实值落草稿。 */
const urlModel = computed({
  get: () => (isTemplatePlaceholder(props.cfg.url) ? '' : (props.cfg.url ?? '')),
  set: (v: string) => {
    props.cfg.url = v
  },
})
/** 模型输入框模型：占位符（<YOUR_MODEL_NAME>）显示为空，placeholder 呈现；写入落草稿。 */
const modelModel = computed({
  get: () => (isTemplatePlaceholder(props.cfg.model) ? '' : (props.cfg.model ?? '')),
  set: (v: string) => {
    props.cfg.model = v
  },
})

// ── info tip 文案（结构化多行，.label-tip-popper pre-line 渲染，\n 分点） ──
const PROVIDER_TIP = [
  '服务：请求实际发往的官方厂商、中转站或自定义入口。',
  '它只提供默认地址和可选协议，不再决定消息解析方式。',
].join('\n')
const PROTOCOL_TIP = [
  'API 协议：决定请求体、流事件、工具调用与思考内容的解析方式。',
  '协议应匹配服务入口实际暴露的端点。',
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
  '· 未勾选「完整 URL」：版本段（/v1 等）由你填写，后端按所选协议拼 /chat/completions、/responses 或 /messages',
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
  if (cfg.provider === 'deepseek') return false
  return (
    cfg.anthropicCompat?.official ??
    (cfg.protocol === 'anthropic-messages' &&
      (cfg.provider === 'anthropic' || cfg.provider === 'minimax'))
  )
}
function setAnthropicOfficial(cfg: BrainConfigDto, value: unknown): void {
  if (effectiveProtocol.value !== 'anthropic-messages' || cfg.provider === 'deepseek') return
  if (!cfg.anthropicCompat) cfg.anthropicCompat = {}
  cfg.anthropicCompat.official = value === true
}

/** 地址输入框示例（随 provider 变化）：未勾选填 base（须含版本段，端点自动拼接）；勾选「完整 URL」填完整请求地址 */
const urlPlaceholder = computed(() => {
  if (effectiveProtocol.value === 'ollama-chat') return '如 http://localhost:11434'
  if (effectiveProtocol.value === 'mock') return 'mock 无需真实地址'
  if (props.cfg.fullUrl === true) {
    if (effectiveProtocol.value === 'anthropic-messages') {
      return '完整 URL，如 https://api.anthropic.com/v1/messages'
    }
    if (effectiveProtocol.value === 'openai-responses') {
      return '完整 URL，如 https://api.openai.com/v1/responses'
    }
    return '完整 URL，如 https://api.openai.com/v1/chat/completions'
  }
  if (effectiveProtocol.value === 'anthropic-messages') {
    return '须含版本段，如 https://api.anthropic.com/v1 → 自动拼 /messages'
  }
  if (effectiveProtocol.value === 'openai-responses') {
    return '须含版本段，如 https://api.openai.com/v1 → 自动拼 /responses'
  }
  return '须含版本段，如 https://api.openai.com/v1 → 自动拼 /chat/completions'
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
/** 用配置的文本编辑器（或系统默认）打开 CHERY_DIR 相对路径文件；未配置编辑器时先提示一次。 */
async function openConfigFile(path: string, fallbackError: string): Promise<void> {
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
    await agentApi.openFile(path)
  } catch (err) {
    onError(err instanceof Error ? err.message : fallbackError)
  }
}

async function openEnvFile(): Promise<void> {
  await openConfigFile('.env', '打开文件失败')
}

/** 模型未匹配目录规则时，从规则提示行一键打开模型目录规则文件补充匹配规则。 */
async function openModelRuleFile(): Promise<void> {
  await openConfigFile('.chery/model-catalog.yaml', '打开模型规则文件失败')
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
          <el-tooltip
            :content="connectionTestTip"
            placement="top"
            :show-after="120"
            popper-class="brain-action-tip"
          >
            <span class="connection-test-btn-wrap">
              <button
                type="button"
                class="connection-test-btn"
                :class="{ pending: connectionTestState === 'pending' }"
                :disabled="connectionTestDisabled"
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
            </span>
          </el-tooltip>
          <div
            v-if="
              isMockProvider || connectionTestState === 'success' || connectionTestState === 'error'
            "
            class="connection-test-message"
            :class="connectionTestState === 'idle' ? 'muted' : connectionTestState"
          >
            <span v-if="connectionTestMessageView.suggestion" class="message-text formatted-text">
              <span class="message-row">
                <span class="message-label">原始错误</span>
                <span class="message-value">{{ connectionTestMessageView.original }}</span>
              </span>
              <span class="message-row suggestion-row">
                <span class="message-label">排查建议</span>
                <span class="message-value">{{ connectionTestMessageView.suggestion }}</span>
              </span>
            </span>
            <span v-else class="message-text">{{
              isMockProvider ? '离线模拟无需测试' : connectionTestMessageView.original
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
        </div>
        <div class="brain-fields connection-fields">
          <div class="field priority-url">
            <div class="label-with-action">
              <LabelTip label="地址" :tip="URL_TIP" />
              <el-tooltip
                content="勾选=后端不拼接任何字符串，请求地址即填写的整个 URL（须含版本段与端点）；未勾选=填版本段（如 /v1），后端自动拼端点"
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
            <el-input v-model="urlModel" class="mono-input" :placeholder="urlPlaceholder" size="small" />
          </div>
          <div class="field priority-key">
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
          <label class="field priority-model">
            <span class="lbl">模型 *</span>
            <div class="model-input-row">
              <el-select
                v-model="modelModel"
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
                :content="refreshTip"
                placement="top"
                :show-after="120"
                popper-class="brain-action-tip"
              >
                <span class="icon-btn-wrap">
                  <button
                    type="button"
                    class="icon-btn refresh-btn"
                    aria-label="刷新模型列表"
                    :disabled="refreshModelsDisabled"
                    @click="refreshModels"
                  >
                    <Refresh class="ico" :class="{ spinning: modelLoading }" />
                  </button>
                </span>
              </el-tooltip>
            </div>
          </label>
          <label class="field secondary-field">
            <LabelTip label="服务" :tip="PROVIDER_TIP" />
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
                v-if="effectiveProtocol === 'anthropic-messages' && cfg.provider !== 'deepseek'"
                :model-value="anthropicOfficial(cfg)"
                class="official-checkbox"
                @change="(v: unknown) => setAnthropicOfficial(cfg, v)"
              >
                完整思考块
              </el-checkbox>
            </div>
          </label>
          <label class="field secondary-field">
            <LabelTip label="API 协议" :tip="PROTOCOL_TIP" />
            <el-select v-model="protocolModel" size="small" class="provider-select">
              <el-option
                v-for="protocol in supportedProtocols"
                :key="protocol"
                :value="protocol"
                :label="protocolLabel(protocol)"
              />
            </el-select>
          </label>
          <div
            class="model-rule-note field-wide"
            :class="{ 'is-unmatched': modelUnmatched }"
            role="note"
          >
            <span class="model-rule-note-icon" aria-hidden="true">{{
              modelUnmatched ? '!' : 'i'
            }}</span>
            <span>{{ modelRuleNotice }}</span>
            <button
              v-if="modelUnmatched"
              type="button"
              class="model-rule-edit-btn"
              @click="openModelRuleFile"
            >
              编辑规则
            </button>
          </div>
        </div>
      </section>

      <section class="brain-section">
        <div class="section-heading">
          <span>运行与能力</span><small>上下文、推理、工具与媒体</small>
        </div>
        <div class="runtime-controls">
          <label class="field">
            <LabelTip label="上下文上限" :tip="contextLimitTip" />
            <el-select
              filterable
              allow-create
              default-first-option
              :model-value="displayContextLimit(cfg.contextLimit)"
              placeholder="未设置（未知）"
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
            <LabelTip label="深度思考" :tip="thinkingTip" />
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

<style scoped lang="less" src="./BrainCard.styles.less"></style>
