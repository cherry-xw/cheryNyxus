<script setup lang="ts">
/**
 * TerminalSettingsTab：终端连接预设（SSH）配置。
 * 预设摘要保存在本地 AES-GCM 加密存储，密码只交给后端凭据服务保存；删除走二次确认。
 * 每个预设是一张小卡（网格排列）；点「修改」直接在卡片内换成输入框（含密码框）。
 * 新增入口放在顶部「本页说明」同一行的右侧。
 */
import { computed, onMounted, ref } from 'vue'
import { Delete, Edit, Plus, Promotion } from '@element-plus/icons-vue'
import { agentApi } from '@/application/backend/public'
import { useWorkspaceStore } from '@/application/public'
import {
  readTerminalPresets,
  writeTerminalPresets,
  type TerminalPreset,
} from '@/features/agent/workbench/terminal/presets'
import { desktopBridge } from '@/features/desktop/desktopBridge'
import ConfirmPopover from '@/components/confirm/ConfirmPopover.vue'
import TabShell, { type IndexItem } from '@/features/agent/settings/components/TabShell.vue'
import TerminalPresetForm, { type TerminalDraft } from './TerminalPresetForm.vue'
import { uuid } from '@/utils/uuid'

const emit = defineEmits<{ error: [message: string] }>()
const workspace = useWorkspaceStore()
const presets = ref<TerminalPreset[]>([])
const saving = ref(false)
const editingId = ref<string | null>(null)
const formOpen = ref(false)
const editing = computed(() => editingId.value !== null)

/** 底部序号导航：每预设一项，popper 显示连接信息。 */
const indexItems = computed<IndexItem[]>(() =>
  presets.value.map((preset) => ({
    label: preset.label,
    host: preset.host,
    port: preset.port,
    username: preset.username,
  })),
)

onMounted(() => {
  void readTerminalPresets().then((items) => {
    presets.value = items
  })
})
function clearDraft(): void {
  editingId.value = null
  formOpen.value = false
}
function createPreset(): void {
  editingId.value = null
  formOpen.value = true
}
function editPreset(preset: TerminalPreset): void {
  editingId.value = preset.id
  formOpen.value = false
}
async function save(form: TerminalDraft): Promise<void> {
  if (saving.value) return
  saving.value = true
  try {
    const credential = await agentApi.saveCredential(
      `SSH ${form.host.trim()}`,
      form.username.trim(),
      form.password,
    )
    const preset: TerminalPreset = {
      id: editingId.value ?? uuid(),
      label: form.label.trim(),
      kind: 'ssh',
      host: form.host.trim(),
      port: form.port,
      username: form.username.trim(),
      auth: 'saved',
      credentialId: credential.id,
    }
    presets.value = [...presets.value.filter((item) => item.id !== preset.id), preset]
    await writeTerminalPresets(presets.value)
    clearDraft()
  } catch (cause) {
    emit('error', cause instanceof Error ? cause.message : '保存终端预设失败')
  } finally {
    saving.value = false
  }
}
function remove(id: string): void {
  presets.value = presets.value.filter((item) => item.id !== id)
  if (editingId.value === id) clearDraft()
  void writeTerminalPresets(presets.value)
}
function openTerminal(preset: TerminalPreset): void {
  const bridge = desktopBridge()
  if (bridge) {
    bridge.openWindow({ kind: 'terminal', presetId: preset.id, presetName: preset.label })
    return
  }
  workspace.openOrFocusWindow({
    resourceKey: `terminal:${preset.id}`,
    title: preset.label ? `Terminal // ${preset.label}` : 'Terminal',
    context: { kind: 'terminal', presetId: preset.id, presetName: preset.label },
    geometry: { width: 860, height: 560 },
  })
}
</script>

<template>
  <TabShell tab-key="terminal" :index-items="indexItems">
    <template #hints>
      <p class="sect-hint">保存多个 SSH 连接，打开工作台 Terminal 时可直接选择连接。</p>
      <p class="warn-hint">⚠️ 密码只交给后端凭据服务加密保存，预设列表和界面都不会显示明文。</p>
    </template>
    <template #hints-actions>
      <button
        type="button"
        class="ghost-btn hints-add-btn"
        :disabled="formOpen"
        @click="createPreset"
      >
        <Plus class="ico" />新增预设
      </button>
    </template>
    <template #popper="{ item }">
      <div class="index-card">
        <div class="index-card-title">{{ item.label as string }}</div>
        <div class="index-card-line">
          <b>主机</b><span>{{ item.host as string }}:{{ item.port }}</span>
        </div>
        <div class="index-card-line">
          <b>用户</b><span>{{ item.username as string }}</span>
        </div>
      </div>
    </template>

    <!-- 预设小卡网格 -->
    <div class="preset-grid">
      <!-- 新增表单卡 -->
      <article v-if="formOpen && !editing" class="card preset-card">
        <span class="card-idx">+</span>
        <header class="card-head form-head">
          <span class="card-title">新增预设</span>
        </header>
        <TerminalPresetForm
          :initial="{ label: '', host: '', port: 22, username: '', password: '' }"
          :editing="false"
          :saving="saving"
          @save="save"
          @cancel="clearDraft"
        />
      </article>

      <!-- 预设卡 -->
      <article
        v-for="(preset, idx) in presets"
        :key="preset.id"
        class="card preset-card"
        :data-anchor="idx"
      >
        <!-- 编辑态：直接在卡片内把文本区换成输入框 -->
        <template v-if="editingId === preset.id">
          <span class="card-idx">{{ idx + 1 }}</span>
          <header class="card-head form-head">
            <span class="card-title">编辑预设</span>
          </header>
          <TerminalPresetForm
            :initial="{
              label: preset.label,
              host: preset.host,
              port: preset.port,
              username: preset.username,
              password: '',
            }"
            :editing="true"
            :saving="saving"
            @save="save"
            @cancel="clearDraft"
          />
        </template>
        <!-- 展示态 -->
        <template v-else>
          <span class="card-idx">{{ idx + 1 }}</span>
          <header class="card-head">
            <span class="card-name">{{ preset.label }}</span>
            <div class="card-actions">
              <button
                type="button"
                class="icon-btn"
                :aria-label="`编辑预设 ${preset.label}`"
                @click="editPreset(preset)"
              >
                <Edit class="ico" />
              </button>
              <ConfirmPopover
                :title="`删除终端预设「${preset.label}」？`"
                @confirm="remove(preset.id)"
              >
                <template #trigger>
                  <button
                    type="button"
                    class="icon-btn danger"
                    :aria-label="`删除预设 ${preset.label}`"
                  >
                    <Delete class="ico" />
                  </button>
                </template>
              </ConfirmPopover>
            </div>
          </header>
          <p class="preset-meta">
            {{ preset.host }}:{{ preset.port }} · {{ preset.username }} · SSH
          </p>
          <button
            type="button"
            class="ghost-btn connect-btn"
            :aria-label="`打开终端 ${preset.label}`"
            @click="openTerminal(preset)"
          >
            <Promotion class="ico" />打开终端
          </button>
        </template>
      </article>
    </div>

    <!-- 空状态 -->
    <p v-if="!presets.length && !formOpen" class="empty preset-empty">
      还没有保存的终端预设，点上方「新增预设」添加第一个 SSH 连接。
    </p>
  </TabShell>
</template>

<style scoped lang="less">
@import '../../config/shared.less';

// 预设小卡网格：卡内容量小，一行放多张小卡而不是整行一张
.preset-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 8px;
  align-items: start;
}

.preset-card {
  min-width: 0;
  .card-head {
    flex-wrap: wrap;
    gap: 6px;
  }
  // 预设名过长时单行省略，避免挤掉右侧操作按钮
  .card-name {
    flex: 1;
    min-width: 0;
    font-size: 15px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

// 预设摘要：等宽展示连接目标，与卡片内操作区分开
.preset-meta {
  margin: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
  color: color-mix(in srgb, var(--ink) 66%, transparent);
  overflow-wrap: anywhere;
}

// 「打开终端」是卡片主操作，占满小卡底部，悬停跟随 tab 主题色
.connect-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  width: 100%;
  padding: 4px 10px;
  font-size: 13px;
  white-space: nowrap;
  &:hover:not(:disabled) {
    border-color: color-mix(in srgb, var(--tab-color, @accent) 60%, transparent);
    background: color-mix(in srgb, var(--tab-color, @accent) 8%, transparent);
    color: color-mix(in srgb, var(--tab-color, @accent) 75%, @ink);
  }
}

// 顶部「本页说明」同行右侧的新增按钮：与 ⓘ 按钮等高
.hints-add-btn {
  height: 28px;
  padding: 0 10px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.preset-empty {
  margin: 16px 0 0;
}

// 表单卡标题（新增 / 编辑）
.form-head .card-title {
  font-size: 15px;
  font-weight: 600;
  color: color-mix(in srgb, var(--ink) 88%, transparent);
}
</style>
