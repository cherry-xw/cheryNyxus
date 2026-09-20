<script setup lang="ts">
/**
 * TerminalSettingsTab：终端连接预设（SSH）配置。
 * 预设摘要保存在本地 AES-GCM 加密存储，密码只交给后端凭据服务保存；删除走二次确认。
 * 列表样式与其它设置 tab 一致（TabShell 外壳 + 卡片 + 底部序号导航）。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { Delete, Edit, Key, Plus, Promotion } from '@element-plus/icons-vue'
import { agentApi } from '@/application/backend/public'
import { useWorkspaceStore } from '@/application/public'
import { readTerminalPresets, writeTerminalPresets, type TerminalPreset } from '@/features/agent/workbench/terminal/presets'
import { desktopBridge } from '@/features/desktop/desktopBridge'
import ConfirmPopover from '@/components/confirm/ConfirmPopover.vue'
import TabShell, { type IndexItem } from '@/features/agent/settings/components/TabShell.vue'
import LabelTip from './LabelTip.vue'

const emit = defineEmits<{ error: [message: string] }>()
const workspace = useWorkspaceStore()
const presets = ref<TerminalPreset[]>([])
const saving = ref(false)
const editingId = ref<string | null>(null)
const formOpen = ref(false)
const draft = reactive({ label: '', host: '', port: 22, username: '', password: '' })
const editing = computed(() => editingId.value !== null)
const canSave = computed(() => !!draft.label.trim() && !!draft.host.trim() && !!draft.username.trim() && !!draft.password && Number.isInteger(draft.port) && draft.port > 0 && draft.port <= 65535)

/** 底部序号导航：每预设一项，popper 显示连接信息。 */
const indexItems = computed<IndexItem[]>(() =>
  presets.value.map((preset) => ({
    label: preset.label,
    host: preset.host,
    port: preset.port,
    username: preset.username,
  })),
)

onMounted(() => { void readTerminalPresets().then((items) => { presets.value = items }) })
function clearDraft(): void { editingId.value = null; formOpen.value = false; Object.assign(draft, { label: '', host: '', port: 22, username: '', password: '' }) }
function createPreset(): void { clearDraft(); formOpen.value = true }
function editPreset(preset: TerminalPreset): void { editingId.value = preset.id; formOpen.value = true; Object.assign(draft, { label: preset.label, host: preset.host, port: preset.port, username: preset.username, password: '' }) }
async function save(): Promise<void> {
  if (!canSave.value || saving.value) return
  saving.value = true
  try {
    const credential = await agentApi.saveCredential(`SSH ${draft.host.trim()}`, draft.username.trim(), draft.password)
    const preset: TerminalPreset = { id: editingId.value ?? crypto.randomUUID(), label: draft.label.trim(), kind: 'ssh', host: draft.host.trim(), port: draft.port, username: draft.username.trim(), auth: 'saved', credentialId: credential.id }
    presets.value = [...presets.value.filter((item) => item.id !== preset.id), preset]
    await writeTerminalPresets(presets.value)
    clearDraft()
  } catch (cause) { emit('error', cause instanceof Error ? cause.message : '保存终端预设失败') } finally { saving.value = false }
}
function remove(id: string): void { presets.value = presets.value.filter((item) => item.id !== id); if (editingId.value === id) clearDraft(); void writeTerminalPresets(presets.value) }
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

    <!-- 预设卡片 -->
    <article
      v-for="(preset, idx) in presets"
      :key="preset.id"
      class="card"
      :data-anchor="idx"
    >
      <span class="card-idx">{{ idx + 1 }}</span>
      <header class="card-head">
        <span class="card-name">{{ preset.label }}</span>
        <div class="card-actions">
          <button
            type="button"
            class="ghost-btn connect-btn"
            :aria-label="`打开终端 ${preset.label}`"
            @click="openTerminal(preset)"
          >
            <Promotion class="ico" />打开终端
          </button>
          <button
            type="button"
            class="icon-btn"
            :aria-label="`编辑预设 ${preset.label}`"
            @click="editPreset(preset)"
          >
            <Edit class="ico" />
          </button>
          <ConfirmPopover :title="`删除终端预设「${preset.label}」？`" @confirm="remove(preset.id)">
            <template #trigger>
              <button type="button" class="icon-btn danger" :aria-label="`删除预设 ${preset.label}`">
                <Delete class="ico" />
              </button>
            </template>
          </ConfirmPopover>
        </div>
      </header>
      <p class="preset-meta">{{ preset.host }}:{{ preset.port }} · {{ preset.username }} · SSH</p>
    </article>

    <!-- 空状态 -->
    <p v-if="!presets.length && !formOpen" class="empty preset-empty">
      还没有保存的终端预设，点下方「新增预设」添加第一个 SSH 连接。
    </p>

    <!-- 新增 / 编辑表单 -->
    <article v-if="formOpen" class="card preset-form-card">
      <header class="card-head">
        <span class="card-title">{{ editing ? '编辑预设' : '新增预设' }}</span>
      </header>
      <form class="preset-form" @submit.prevent="save">
        <div class="card-grid">
          <label class="field">
            <span class="lbl">预设名称</span>
            <el-input v-model="draft.label" autocomplete="off" placeholder="如：生产服务器" />
          </label>
          <label class="field">
            <span class="lbl">主机名或 IP</span>
            <el-input v-model="draft.host" autocomplete="off" placeholder="example.com 或 192.168.1.10" />
          </label>
          <label class="field">
            <span class="lbl">端口</span>
            <el-input-number v-model="draft.port" :min="1" :max="65535" controls-position="right" />
          </label>
          <label class="field">
            <span class="lbl">用户名</span>
            <el-input v-model="draft.username" autocomplete="username" />
          </label>
          <label class="field form-wide">
            <LabelTip
              label="密码"
              tip="只交给后端凭据服务加密保存，不会显示在预设列表；编辑时需重新输入。"
            />
            <el-input
              v-model="draft.password"
              type="password"
              autocomplete="new-password"
              :placeholder="editing ? '编辑时需重新输入密码' : ''"
              show-password
            />
          </label>
        </div>
        <div class="form-actions">
          <button type="submit" class="primary-btn" :disabled="!canSave || saving">
            <Key class="ico" />{{ saving ? '保存中…' : '保存预设' }}
          </button>
          <button v-if="editing" type="button" class="ghost-btn" @click="clearDraft">取消</button>
        </div>
        <p class="hint preset-form-help">
          首次连接时由后端自动记录 SSH 主机指纹并持续核对，指纹变化会拒绝连接；密码不会回传到前端。
        </p>
      </form>
    </article>

    <!-- 底部新增入口 -->
    <footer class="foot-actions">
      <button type="button" class="ghost-btn" :disabled="formOpen" @click="createPreset">
        <Plus class="ico" />新增预设
      </button>
    </footer>
  </TabShell>
</template>

<style scoped lang="less">
@import '../../config/shared.less';

// 预设摘要：等宽展示连接目标，与卡片内操作区分开
.preset-meta {
  margin: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
  color: color-mix(in srgb, var(--ink) 66%, transparent);
}

// 预设名过长时单行省略，避免挤掉右侧操作按钮
.card-head .card-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

// 「打开终端」是卡片主操作，悬停跟随 tab 主题色，与编辑/删除图标按钮拉开层级
.connect-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  font-size: 13px;
  white-space: nowrap;
  &:hover:not(:disabled) {
    border-color: color-mix(in srgb, var(--tab-color, @accent) 60%, transparent);
    background: color-mix(in srgb, var(--tab-color, @accent) 8%, transparent);
    color: color-mix(in srgb, var(--tab-color, @accent) 75%, @ink);
  }
}

.preset-empty {
  margin: 16px 0 0;
}

// 表单卡片（无 card-idx，去掉共享 card-head 预留的 28px 左距）
.preset-form-card .card-head {
  padding-left: 0;
  .card-title {
    font-size: 15px;
    font-weight: 600;
    color: color-mix(in srgb, var(--ink) 88%, transparent);
  }
}

.preset-form {
  display: flex;
  flex-direction: column;
  gap: 10px;

  .form-wide {
    grid-column: 1 / -1;
  }

  .form-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 2px;
  }

  .primary-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 14px;
    border: none;
    border-radius: 6px;
    background: var(--tab-color, @accent);
    color: var(--accent-ink);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    &:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  }

  .preset-form-help {
    margin: 0;
  }
}

// 输入框 / 数字框 focus 边框跟随终端 tab 主题色
:deep(.el-input),
:deep(.el-input-number) {
  --el-color-primary: var(--tab-color, @accent);
}

// 底部新增入口
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
</style>
