<script setup lang="ts">
/**
 * CommandsTab：内置指令配置面板。
 *
 * 职责（重构后）：**不再编辑指令正文**——指令不可在前端增删定制，正文由文件系统维护。
 * - 只读枚举 .chery/command/*.md（command.list）→ 展示存在的指令 + 描述。
 * - 为 compact 提供阈值配置项（warn / auto / min_context_limit），绑定 draft.global.command，
 *   由 SettingsDialog 主「保存」按钮走 config.save 持久化。
 * - 缺失 compact.md → compact 标记「不可用」，阈值配置禁用（缺失 md 既不可用）。
 * - compact 无开关：可用性只由 brain 上下文容量门槛（min_context_limit）+ compact.md 存在决定。
 *
 * 数据流：
 * - 进入 tab → command.list 拉全部 .md 条目（只读）
 * - warn/auto/min 文本输入 → 解析为 Threshold/token 写回 draft.global.command（@change 提交）
 * - 主「保存」（SettingsDialog）→ config.save → 持久化 global.command
 */
import { computed, onMounted, ref } from 'vue'
import { Refresh } from '@element-plus/icons-vue'
import { agentApi, type CommandInfo, type ConfigDto } from '@/services/agentApi'
import {
  formatThreshold,
  formatTokenCount,
  parseThreshold,
  parseTokenCount,
} from '@/features/agent/composables/commands'
import TabShell, { type IndexItem } from '@/components/layout/TabShell.vue'
import LabelTip from './LabelTip.vue'

const props = defineProps<{ draft: ConfigDto }>()
const emit = defineEmits<{ (e: 'error', msg: string): void }>()

const commands = ref<CommandInfo[]>([])
const loadingList = ref(false)

/** warn/auto/min 文本输入本地态（自由输入，@change 解析写回 draft）。 */
const warnText = ref('')
const autoText = ref('')
const minText = ref('')
/** 各字段上一个合法值，非法输入时回退到此（避免脏态驻留）。 */
const warnLastValid = ref('60%')
const autoLastValid = ref('80%')
const minLastValid = ref('32k')

/**
 * 整串正则校验：只允许「数字（可含一个小数点）+ 可选后缀 %/k/K」，后缀一旦出现即终结（后面禁输任何字符）。
 *  el-input @input 事件参数为 string；非法串直接回退到上一个合法值。
 *  过渡态：空串 / 单独 `.` 允许，便于用户起手输入。
 */
const THRESHOLD_PREFIX_RE = /^(?:\d+\.?\d*|\d*\.\d+)[%kK]?$/

function filterThresholdInput(value: string, target: 'warn' | 'auto' | 'min'): void {
  const ok = value === '' || value === '.' || THRESHOLD_PREFIX_RE.test(value)
  if (!ok) {
    if (target === 'warn') warnText.value = warnLastValid.value
    else if (target === 'auto') autoText.value = autoLastValid.value
    else minText.value = minLastValid.value
    return
  }
  // 合法且非空 → 记为新的 lastValid（空串不覆盖，防止清空时丢失锚点）
  if (value !== '') {
    if (target === 'warn') warnLastValid.value = value
    else if (target === 'auto') autoLastValid.value = value
    else minLastValid.value = value
  }
}

function onError(msg: string): void {
  emit('error', msg)
}
function emitError(err: unknown): void {
  const e = err as { message?: string }
  onError(e?.message ?? String(err))
}

async function loadCommands(): Promise<void> {
  loadingList.value = true
  try {
    commands.value = await agentApi.listCommands()
  } catch (err) {
    emitError(err)
  } finally {
    loadingList.value = false
  }
}

/** draft.global.command 缺省时补空对象，供字段写入。 */
function ensureCommand(): NonNullable<ConfigDto['global']['command']> {
  if (!props.draft.global.command) props.draft.global.command = {}
  return props.draft.global.command
}

/** compact.md 是否存在（决定 compact 是否可用）。 */
const compactAvailable = computed(() => commands.value.some((c) => c.name === 'compact'))

/** 除 compact 外的其它指令（只读展示，无配置项）。 */
const otherCommands = computed(() => commands.value.filter((c) => c.name !== 'compact'))

const indexItems = computed<IndexItem[]>(() => [
  {
    label: 'compact',
    anchor: 'compact',
    description: '上下文过长时整理关键事实与进度，避免信息丢失',
  },
  ...otherCommands.value.map((c) => ({
    label: c.name,
    anchor: c.name,
    description: c.description || '无描述',
  })),
])

/** 从 draft 播种文本输入（draft 在 mount 前已由 SettingsDialog 加载）。 */
function syncTextFromDraft(): void {
  const cmd = props.draft.global.command
  warnText.value = formatThreshold(cmd?.warn ?? { unit: 'percent', value: 0.6 })
  autoText.value = formatThreshold(cmd?.auto ?? { unit: 'percent', value: 0.8 })
  minText.value = formatTokenCount(cmd?.min_context_limit ?? 32000)
  // 同步 lastValid 锚点（与初始展示一致）
  warnLastValid.value = warnText.value
  autoLastValid.value = autoText.value
  minLastValid.value = minText.value
}

function applyWarn(): void {
  const parsed = parseThreshold(warnText.value)
  if (!parsed) {
    onError('warn 阈值必须为 数字 + % 或 k（如 60% 或 96k）')
    warnText.value = formatThreshold(
      props.draft.global.command?.warn ?? { unit: 'percent', value: 0.6 },
    )
    return
  }
  ensureCommand().warn = parsed
}
function applyAuto(): void {
  const parsed = parseThreshold(autoText.value)
  if (!parsed) {
    onError('auto 阈值必须为 数字 + % 或 k（如 80% 或 100k）')
    autoText.value = formatThreshold(
      props.draft.global.command?.auto ?? { unit: 'percent', value: 0.8 },
    )
    return
  }
  ensureCommand().auto = parsed
}
function applyMin(): void {
  const parsed = parseTokenCount(minText.value)
  if (parsed == null) {
    onError('min_context_limit 必须为 数字 + k（如 32k）')
    minText.value = formatTokenCount(props.draft.global.command?.min_context_limit ?? 32000)
    return
  }
  ensureCommand().min_context_limit = parsed
}

/** 输入合法性（标红）。 */
const warnValid = computed(() => parseThreshold(warnText.value) !== null)
const autoValid = computed(() => parseThreshold(autoText.value) !== null)
const minValid = computed(() => parseTokenCount(minText.value) !== null)

onMounted(async () => {
  await loadCommands()
  syncTextFromDraft()
})
</script>

<template>
  <TabShell tab-key="commands" :index-items="indexItems">
    <template #hints>
      <p class="sect-hint">
        指令由 <code>.chery/command/*.md</code> 维护，此处只读枚举；每个指令的说明见其悬浮卡。
      </p>
    </template>

    <template #popper="{ item }">
      <div class="index-card">
        <div class="index-card-title">{{ item.label as string }}</div>
        <div class="index-card-line">
          <b>说明</b><span>{{ item.description as string }}</span>
        </div>
      </div>
    </template>

    <!-- compact 阈值配置卡 -->
    <article class="card compact-card" data-anchor="compact">
      <span class="card-idx">1</span>
      <header class="card-head">
        <span class="card-title">compact</span>
        <span v-if="!compactAvailable" class="badge warn">不可用 · 缺失 compact.md</span>
      </header>

      <p v-if="!compactAvailable" class="unavail-hint">
        <code>.chery/command/compact.md</code> 不存在，compact
        指令不可用。阈值配置禁用；恢复文件后刷新列表即可。
      </p>

      <div class="field-row compact-row">
        <label class="field">
          <LabelTip
            label="警告阈值"
            tip="上下文占用达到这个比例时，界面会提示你，但不会自动压缩。填 60% 或 96k"
          />
          <el-input
            v-model="warnText"
            :class="{ invalid: !warnValid }"
            :disabled="!compactAvailable"
            placeholder="60% 或 96k"
            @input="(v: string) => filterThresholdInput(v, 'warn')"
            @change="applyWarn"
          />
        </label>

        <label class="field">
          <LabelTip
            label="自动压缩"
            tip="上下文占用达到这个比例时，会自动压缩上下文。填 80% 或 100k"
          />
          <el-input
            v-model="autoText"
            :class="{ invalid: !autoValid }"
            :disabled="!compactAvailable"
            placeholder="80% 或 100k"
            @input="(v: string) => filterThresholdInput(v, 'auto')"
            @change="applyAuto"
          />
        </label>

        <label class="field">
          <LabelTip
            label="最小上下文容量"
            tip="brain 的总容量低于这个值时，compact 功能会自动禁用，防止压爆上下文。填 32k"
          />
          <el-input
            v-model="minText"
            :class="{ invalid: !minValid }"
            :disabled="!compactAvailable"
            placeholder="32k"
            @input="(v: string) => filterThresholdInput(v, 'min')"
            @change="applyMin"
          />
        </label>
      </div>
    </article>

    <!-- 其它指令：只读 -->
    <article
      v-for="(c, i) in otherCommands"
      :key="c.name"
      class="card readonly-card"
      :data-anchor="c.name"
    >
      <span class="card-idx">{{ i + 2 }}</span>
      <header class="card-head">
        <span class="card-title">{{ c.name }}</span>
      </header>
      <p class="readonly-desc">{{ c.description || '（无描述）' }}</p>
    </article>

    <article v-if="!loadingList && commands.length === 0" class="card empty-card">
      <span class="card-idx">·</span>
      <header class="card-head"><span class="empty-title">没有指令文件</span></header>
      <p class="empty-hint">
        <code>.chery/command/</code> 目录为空，compact 不可用。在文件系统新增
        <code>compact.md</code> 后点「刷新列表」。
      </p>
    </article>

    <footer class="foot-actions">
      <button type="button" class="ghost-btn" :disabled="loadingList" @click="loadCommands">
        <Refresh class="ico" /> {{ loadingList ? '加载中…' : '刷新列表' }}
      </button>
    </footer>
  </TabShell>
</template>

<style scoped lang="less">
@import '../../config/shared.less';

code {
  font-family: ui-monospace, SFMono-Regular, Consolas, 'Courier New', monospace;
  font-size: 11px;
  padding: 1px 4px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--ink) 8%, transparent);
}

.compact-card,
.readonly-card {
  .field + .field {
    margin-top: 8px;
  }
}

// 压缩指令三阈值一行横排：等宽 flex，紧凑不撑高
.compact-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  .field {
    flex: 1 1 0;
    min-width: 110px;
  }
  .field + .field {
    margin-top: 0;
  }
}

.card-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.card-title {
  font-size: 14px;
  font-weight: 600;
  color: color-mix(in srgb, var(--ink) 88%, transparent);
}

.badge.warn {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--danger) 18%, transparent);
  color: var(--danger);
}

.unavail-hint {
  margin: 4px 0 8px;
  font-size: 11px;
  color: var(--danger);
}

.readonly-desc {
  margin-top: 4px;
  font-size: 12px;
  color: color-mix(in srgb, var(--ink) 70%, transparent);
}

.empty-card {
  text-align: center;
  .empty-title {
    font-size: 14px;
    font-weight: 600;
    color: color-mix(in srgb, var(--ink) 80%, transparent);
  }
  .empty-hint {
    margin-top: 6px;
    font-size: 11px;
    color: color-mix(in srgb, var(--ink) 60%, transparent);
  }
}

.foot-actions {
  display: flex;
  gap: 8px;
  padding: 10px 12px;
  margin: 8px 0 4px;
  border-top: 1px dashed color-mix(in srgb, var(--ink) 12%, transparent);
  .ghost-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
}

.ghost-btn {
  padding: 5px 10px;
  border: 1px solid color-mix(in srgb, var(--ink) 16%, transparent);
  border-radius: 6px;
  background: var(--surface-soft);
  color: color-mix(in srgb, var(--ink) 80%, transparent);
  font-size: 11px;
  cursor: pointer;
  &:hover:not(:disabled) {
    background: var(--surface);
    color: color-mix(in srgb, var(--ink) 92%, transparent);
  }
  &:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
}

:deep(.invalid .el-input__wrapper) {
  box-shadow: 0 0 0 1px var(--danger) inset;
}

.ico {
  width: 12px;
  height: 12px;
}
</style>
