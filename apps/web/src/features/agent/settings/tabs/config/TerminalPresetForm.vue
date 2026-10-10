<script setup lang="ts">
/**
 * TerminalPresetForm：终端预设表单（新增 / 编辑共用）。
 * 自身持有可编辑字段副本；保存时把完整字段提交给父级，
 * 密码只在本次提交中交给后端凭据服务，不落本地预设列表。
 */
import { computed, reactive } from 'vue'
import { Key } from '@element-plus/icons-vue'
import LabelTip from './LabelTip.vue'

export interface TerminalDraft {
  label: string
  host: string
  port: number
  username: string
  password: string
}

const props = defineProps<{
  initial: TerminalDraft
  editing: boolean
  saving: boolean
}>()
const emit = defineEmits<{ save: [draft: TerminalDraft]; cancel: [] }>()

const form = reactive<TerminalDraft>({ ...props.initial })

const canSave = computed(
  () =>
    !!form.label.trim() &&
    !!form.host.trim() &&
    !!form.username.trim() &&
    !!form.password &&
    Number.isInteger(form.port) &&
    form.port > 0 &&
    form.port <= 65535,
)
</script>

<template>
  <form class="preset-form" @submit.prevent="emit('save', { ...form })">
    <label class="field">
      <span class="lbl">预设名称</span>
      <el-input v-model="form.label" autocomplete="off" placeholder="如：生产服务器" />
    </label>
    <label class="field">
      <span class="lbl">主机名或 IP</span>
      <el-input v-model="form.host" autocomplete="off" placeholder="example.com 或 192.168.1.10" />
    </label>
    <label class="field">
      <span class="lbl">端口</span>
      <el-input-number v-model="form.port" :min="1" :max="65535" controls-position="right" />
    </label>
    <label class="field">
      <span class="lbl">用户名</span>
      <el-input v-model="form.username" autocomplete="username" />
    </label>
    <label class="field">
      <LabelTip
        label="密码"
        tip="只交给后端凭据服务加密保存，不会显示在预设列表；编辑时需重新输入。"
      />
      <el-input
        v-model="form.password"
        type="password"
        autocomplete="new-password"
        :placeholder="editing ? '编辑时需重新输入密码' : ''"
        show-password
      />
    </label>
    <div class="form-actions">
      <button type="submit" class="primary-btn" :disabled="!canSave || saving">
        <Key class="ico" />{{ saving ? '保存中…' : '保存预设' }}
      </button>
      <button type="button" class="ghost-btn" @click="emit('cancel')">取消</button>
    </div>
    <p class="hint preset-form-help">
      首次连接时由后端自动记录 SSH 主机指纹并持续核对，指纹变化会拒绝连接；密码不会回传到前端。
    </p>
  </form>
</template>

<style scoped lang="less">
@import '../../config/shared.less';

.preset-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

// 输入框 / 数字框 focus 边框跟随终端 tab 主题色
:deep(.el-input),
:deep(.el-input-number) {
  --el-color-primary: var(--tab-color, @accent);
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
  font-weight: 400;
  cursor: pointer;
  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
}

.preset-form-help {
  margin: 0;
}
</style>
