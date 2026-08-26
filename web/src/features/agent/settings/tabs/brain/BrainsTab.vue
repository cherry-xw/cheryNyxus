<script setup lang="ts">
import { computed, ref } from 'vue'
import { Plus } from '@element-plus/icons-vue'
import type { ConfigDto } from '@/application/backend/public'
import { PROVIDER_META, isProviderIconAsset, type ProviderId } from './providerMeta'
import BrainCard from './BrainCard.vue'
import ResourceWorkbench, { type ResourceRailItem } from '../agent/ResourceWorkbench.vue'

const props = defineProps<{ draft: ConfigDto; envVars: string[] }>()
const emit = defineEmits<{ (e: 'error', msg: string): void }>()
const selected = ref('')
const newName = ref('')
const current = computed(() => props.draft.llm.brain[selected.value])

function isProviderId(value: string): value is ProviderId {
  return value in PROVIDER_META
}

/** 容量按 1024 进位显示（K → M → G）；旧 config 无 contextLimit 时按 add() 默认 128K 兜底。 */
const DEFAULT_CONTEXT_LIMIT = 128000
function formatContextLimit(value: number | undefined): string {
  const v = value ?? DEFAULT_CONTEXT_LIMIT
  const k = v / 1000
  if (k < 1024) return `${trim(k)}K`
  const m = k / 1024
  if (m < 1024) return `${trim(m)}M`
  return `${trim(m / 1024)}G`
}
/** 整数去小数；否则保留 1 位小数（去尾零）。 */
function trim(n: number): string {
  const r = Math.round(n * 10) / 10
  return Number.isInteger(r) ? `${r}` : `${r}`
}

const items = computed<ResourceRailItem[]>(() =>
  Object.entries(props.draft.llm.brain).map(([name, cfg]) => {
    const provider = cfg.provider && isProviderId(cfg.provider) ? cfg.provider : undefined
    const meta = provider ? PROVIDER_META[provider] : undefined
    const isAsset = provider ? isProviderIconAsset(provider) : false
    return {
      key: name,
      label: name,
      // 无品牌资源（mock emoji）走 avatar 文本通道；其他走 avatarIcon 图片通道。
      avatar: meta && !isAsset ? meta.icon : undefined,
      avatarIcon: meta && isAsset ? meta.icon : undefined,
      capacity: formatContextLimit(cfg.contextLimit),
      meta: cfg.model || '未配置模型',
      badge: cfg.capabilities?.toolCall === false ? '💬' : '🔧',
    }
  }),
)

function add(): void {
  const name = newName.value.trim()
  if (!name) return
  if (props.draft.llm.brain[name]) {
    emit('error', `大脑 "${name}" 已存在`)
    return
  }
  props.draft.llm.brain[name] = { model: '', provider: 'openai', contextLimit: 128000 }
  newName.value = ''
  selected.value = name
}
</script>

<template>
  <section class="brains-workspace">
    <div class="brain-hints">
      <p class="sect-hint">
        选择左侧核心后在右侧编辑。连接、运行能力和媒体能力集中在一张详情面板中。
      </p>
      <p class="warn-hint">删除仍被角色引用的大脑会导致配置校验失败。</p>
    </div>
    <ResourceWorkbench
      v-model="selected"
      :items="items"
      search-placeholder="搜索大脑"
      :glow-rail="true"
    >
      <template #rail-actions>
        <el-popover trigger="click" placement="bottom-start" :width="230">
          <template #reference
            ><button type="button" class="rail-add" aria-label="新增大脑"><Plus /></button
          ></template>
          <div class="new-brain">
            <el-input v-model="newName" placeholder="新大脑名" @keydown.enter="add" /><button
              type="button"
              class="primary-btn"
              @click="add"
            >
              创建
            </button>
          </div>
        </el-popover>
      </template>
      <BrainCard
        v-if="current"
        :key="selected"
        detail-mode
        :name="selected"
        :idx="Object.keys(draft.llm.brain).indexOf(selected)"
        :cfg="current"
        :draft="draft"
        :env-vars="envVars"
        @error="emit('error', $event)"
        @renamed="selected = $event"
        @duplicated="selected = $event"
      />
    </ResourceWorkbench>
  </section>
</template>

<style scoped lang="less">
@import '../../config/shared.less';
.brains-workspace {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.brains-workspace :deep(.resource-workbench) {
  flex: 1;
}
.brain-hints {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.rail-add {
  width: 27px;
  height: 27px;
  border: 1px solid color-mix(in srgb, var(--tab-color, @accent) 38%, transparent);
  border-radius: 7px;
  background: color-mix(in srgb, var(--tab-color, @accent) 14%, transparent);
  color: color-mix(in srgb, var(--tab-color, @accent) 75%, @ink);
  cursor: pointer;
}
.rail-add svg {
  width: 13px;
}
.new-brain {
  display: flex;
  gap: 5px;
}
.primary-btn {
  border: 0;
  border-radius: 6px;
  background: var(--tab-color, @accent);
  font-weight: 600;
  cursor: pointer;
  padding: 0 11px;
}
</style>
