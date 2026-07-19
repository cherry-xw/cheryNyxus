<script setup lang="ts">
/**
 * MediaTab：媒体服务（config.media）独立管理。
 * 每服务 = 命名实体（type + url + model + key + enabled + maxUploadMb）。
 * 预设通过 PresetConfig.mediaImage/mediaVideo/mediaAudio 引用此处服务名。
 * 增删改走 EditableTitle + ConfirmPopover；合法性由后端 config.save 校验 fail loud。
 */
import { ref, computed } from 'vue'
import { Delete } from '@element-plus/icons-vue'
import type { ConfigDto, MediaKindDto } from '@/services/agentApi'
import ConfirmPopover from '@/components/confirm/ConfirmPopover.vue'
import EditableTitle from '@/components/input/EditableTitle.vue'
import TabShell, { type IndexItem } from '@/components/layout/TabShell.vue'

const props = defineProps<{ draft: ConfigDto; envVars: string[] }>()
const emit = defineEmits<{ (e: 'error', msg: string): void }>()

const newServiceName = ref('')

const MEDIA_TYPES: { value: MediaKindDto; label: string; icon: string }[] = [
  { value: 'image', label: '图片', icon: '🖼️' },
  { value: 'video', label: '视频', icon: '🎬' },
  { value: 'audio', label: '音频', icon: '🎵' },
]

function typeLabel(type: MediaKindDto): string {
  return MEDIA_TYPES.find((t) => t.value === type)?.label ?? type
}
function typeIcon(type: MediaKindDto): string {
  return MEDIA_TYPES.find((t) => t.value === type)?.icon ?? '📦'
}

function addService(): void {
  const name = newServiceName.value.trim()
  if (!name) return
  if (!props.draft.media) props.draft.media = {}
  if (props.draft.media[name]) {
    emit('error', `媒体服务 "${name}" 已存在`)
    return
  }
  props.draft.media[name] = { type: 'image', url: '', enabled: false }
  newServiceName.value = ''
}

function removeService(name: string): void {
  if (!props.draft.media) return
  delete props.draft.media[name]
  // 清理预设引用：如果预设指向被删服务，清空对应字段
  if (props.draft.presets) {
    for (const preset of Object.values(props.draft.presets)) {
      if (preset.mediaImage === name) preset.mediaImage = undefined
      if (preset.mediaVideo === name) preset.mediaVideo = undefined
      if (preset.mediaAudio === name) preset.mediaAudio = undefined
    }
  }
}

function renameService(oldName: string, newName: string): void {
  if (!props.draft.media) return
  const cfg = props.draft.media[oldName]
  const rebuilt = {} as typeof props.draft.media
  for (const [k, v] of Object.entries(props.draft.media)) {
    if (k === oldName) rebuilt[newName] = cfg!
    else rebuilt[k] = v
  }
  props.draft.media = rebuilt
  // 迁移预设引用
  if (props.draft.presets) {
    for (const preset of Object.values(props.draft.presets)) {
      if (preset.mediaImage === oldName) preset.mediaImage = newName
      if (preset.mediaVideo === oldName) preset.mediaVideo = newName
      if (preset.mediaAudio === oldName) preset.mediaAudio = newName
    }
  }
  emit('error', '')
}
function validateRename(newName: string): string | null {
  if (!props.draft.media) return null
  return props.draft.media[newName] ? `媒体服务 "${newName}" 已存在` : null
}

const indexItems = computed<IndexItem[]>(() => {
  const services = props.draft.media ?? {}
  return Object.entries(services).map(([name, cfg]) => ({
    label: name,
    type: cfg.type,
    enabled: cfg.enabled === true,
  }))
})
</script>

<template>
  <TabShell tab-key="media" :index-items="indexItems">
    <template #hints>
      <p class="sect-hint">
        每个媒体服务是独立实体：选择类型（图/音/视），配置网关地址，在「预设」中挂载给团队使用。
      </p>
    </template>
    <template #popper="{ item }">
      <div class="index-card">
        <div class="index-card-title">{{ item.label as string }}</div>
        <div class="index-card-line">
          <b>类型</b
          ><span
            >{{ typeIcon(item.type as MediaKindDto) }}
            {{ typeLabel(item.type as MediaKindDto) }}</span
          >
        </div>
        <div class="index-card-line">
          <b>状态</b><span>{{ item.enabled ? '已启用' : '未启用' }}</span>
        </div>
      </div>
    </template>

    <article v-for="(cfg, sname, idx) in draft.media" :key="sname" class="card" :data-anchor="idx">
      <span class="card-idx">{{ idx + 1 }}</span>
      <header class="card-head">
        <EditableTitle
          :model-value="sname as string"
          :validate="validateRename"
          @rename="(n: string) => renameService(sname as string, n)"
          @error="(msg: string) => emit('error', msg)"
        >
          <template #actions>
            <ConfirmPopover
              :title="`确认删除媒体服务「${sname}」？`"
              @confirm="removeService(sname as string)"
            >
              <template #trigger>
                <button type="button" class="icon-btn danger" aria-label="删除媒体服务">
                  <Delete class="ico" />
                </button>
              </template>
            </ConfirmPopover>
          </template>
        </EditableTitle>
      </header>

      <div class="card-grid">
        <label class="field">
          <span class="lbl">类型</span>
          <el-select v-model="cfg.type" placeholder="选择类型">
            <el-option
              v-for="t in MEDIA_TYPES"
              :key="t.value"
              :value="t.value"
              :label="`${t.icon} ${t.label}`"
            />
          </el-select>
        </label>
        <label class="field">
          <span class="lbl">启用</span>
          <el-switch v-model="cfg.enabled" />
        </label>
      </div>

      <div class="field">
        <span class="lbl">网关地址</span>
        <el-input v-model="cfg.url" class="mono-input" placeholder="https://media-gateway/..." />
      </div>

      <div class="card-grid card-grid-3">
        <label class="field">
          <span class="lbl">模型</span>
          <el-input v-model="cfg.model" placeholder="可选" />
        </label>
        <label class="field">
          <span class="lbl">上传上限（MiB）</span>
          <el-input-number v-model="cfg.maxUploadMb" :min="1" :controls="false" placeholder="100" />
        </label>
        <label class="field">
          <span class="lbl">密钥</span>
          <el-select
            v-model="cfg.key"
            filterable
            allow-create
            clearable
            class="mono-input"
            placeholder="选择 .env 变量"
          >
            <el-option v-for="v in envVars" :key="v" :value="`$${v}`" :label="`$${v}`" />
          </el-select>
        </label>
      </div>
    </article>

    <p v-if="!draft.media || !Object.keys(draft.media).length" class="empty">
      暂无媒体服务。输入名称后新建一个。
    </p>

    <div class="add-row">
      <el-input
        v-model="newServiceName"
        placeholder="新服务名（如 qwen-vision / whisper）"
        @keydown.enter="addService"
      />
      <button type="button" class="ghost-btn" @click="addService">+ 新增服务</button>
    </div>
  </TabShell>
</template>

<style scoped lang="less">
@import '../../config/shared.less';

.card-grid-3 {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}
</style>
