<script setup lang="ts">
/**
 * ServerLoginDialog：后端服务对接弹窗。
 * 输入后端服务地址 + 用户名/密码。
 * 授权规则：本地 loopback 直连不鉴权（隐藏用户名/密码）；远端地址需登录（签发双 token）。
 * 登录 / 设置地址成功后 reload，让 bootstrap 以新连接目标 + token 重新初始化。
 */
import { computed, ref, watch } from 'vue'
import {
  useAuthStore,
  hostOf,
  isLoopbackHost,
  normalizeAddress,
  type AuthError,
} from '@/stores/auth'

const props = defineProps<{ visible: boolean }>()
const emit = defineEmits<{ (e: 'update:visible', v: boolean): void }>()

const auth = useAuthStore()

const DEFAULT_LOCAL = 'http://localhost:8183'
const address = ref(auth.serverAddress || DEFAULT_LOCAL)
const username = ref('')
const password = ref('')
const busy = ref(false)
const error = ref<AuthError | null>(null)
const showRaw = ref(false)

const isLocal = computed(() => {
  const host = hostOf(normalizeAddress(address.value))
  return host !== '' ? isLoopbackHost(host) : true
})

/** 错误图标（按 kind 映射） */
const errorIcon = computed(() => {
  switch (error.value?.kind) {
    case 'network':
      return '🔌'
    case 'cors':
      return '🚫'
    case 'timeout':
      return '⏱️'
    case 'credential':
      return '🔑'
    case 'http':
      return '⚠️'
    default:
      return '❗'
  }
})

watch(
  () => props.visible,
  (open) => {
    if (!open) return
    address.value = auth.serverAddress || DEFAULT_LOCAL
    username.value = ''
    password.value = ''
    error.value = null
    showRaw.value = false
  },
)

async function submit(): Promise<void> {
  const base = normalizeAddress(address.value)
  if (!base) {
    error.value = {
      kind: 'unknown',
      title: '请输入后端服务地址',
      detail: '后端服务地址不能为空，例如 http://127.0.0.1:8183',
    }
    return
  }
  busy.value = true
  error.value = null
  try {
    if (isLocal.value) {
      // 本地直连：不鉴权，仅设置目标地址。
      auth.setServerAddress(base)
    } else {
      if (!username.value || !password.value) {
        error.value = {
          kind: 'unknown',
          title: '请输入用户名与密码',
          detail: '远端地址需登录访问，用户名与密码均为必填。',
        }
        return
      }
      await auth.login(base, username.value, password.value)
    }
    emit('update:visible', false)
    window.location.reload()
  } catch (cause) {
    // 兼容：之前测试可能仍抛 Error（如从其他 store 调用）
    error.value =
      cause && typeof cause === 'object' && 'kind' in cause
        ? (cause as AuthError)
        : {
            kind: 'unknown',
            title: '登录失败',
            detail: cause instanceof Error ? cause.message : '未知错误',
            raw: cause,
          }
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <el-dialog
    :model-value="visible"
    title="连接后端服务"
    width="420px"
    :close-on-click-modal="false"
    @update:model-value="emit('update:visible', $event)"
  >
    <el-form label-position="top" @submit.prevent="submit">
      <el-form-item label="后端服务地址">
        <el-input v-model="address" placeholder="http://127.0.0.1:8183" />
      </el-form-item>

      <el-alert
        v-if="isLocal"
        type="success"
        :closable="false"
        title="本地服务直连，无需登录"
        description="loopback 地址信任豁免，可直接连接。"
      />

      <template v-else>
        <el-form-item label="用户名">
          <el-input v-model="username" autocomplete="username" />
        </el-form-item>
        <el-form-item label="密码">
          <el-input v-model="password" type="password" show-password autocomplete="current-password" />
        </el-form-item>
      </template>

      <el-alert
        v-if="error"
        type="error"
        :closable="false"
        :title="`${errorIcon}  ${error.title}`"
        show-icon
        class="login-error"
      >
        <template #default>
          <div class="error-body">
            <p class="error-detail">{{ error.detail }}</p>
            <p v-if="error.backendMessage" class="error-backend">
              <span class="error-label">后端：</span>{{ error.backendMessage }}
            </p>
            <p v-if="error.status" class="error-status">
              <el-tag size="small" type="danger" effect="plain">HTTP {{ error.status }}</el-tag>
            </p>
            <button
              v-if="error.raw"
              type="button"
              class="error-toggle"
              @click="showRaw = !showRaw"
            >
              {{ showRaw ? '收起' : '查看' }}原始错误
            </button>
            <pre v-if="showRaw && error.raw" class="error-raw">{{
              error.raw instanceof Error ? `${error.raw.name}: ${error.raw.message}` : error.raw
            }}</pre>
          </div>
        </template>
      </el-alert>

      <div class="dialog-footer">
        <el-button @click="emit('update:visible', false)">取消</el-button>
        <el-button type="primary" :loading="busy" @click="submit">
          {{ isLocal ? '连接' : '登录并连接' }}
        </el-button>
      </div>
    </el-form>
  </el-dialog>
</template>

<style scoped lang="less">
.login-error {
  margin-bottom: 12px;
}
.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}
.error-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.error-detail {
  margin: 0;
  color: var(--el-text-color-regular);
  line-height: 1.55;
}
.error-label {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.error-backend,
.error-status {
  margin: 0;
  font-size: 12px;
}
.error-toggle {
  align-self: flex-start;
  background: none;
  border: none;
  padding: 2px 0;
  color: var(--el-color-primary);
  cursor: pointer;
  font-size: 12px;
  text-decoration: underline;
}
.error-toggle:hover {
  color: var(--el-color-primary-light-3);
}
.error-raw {
  margin: 4px 0 0;
  padding: 8px 10px;
  background: var(--el-fill-color-light);
  border-radius: 4px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 120px;
  overflow: auto;
}
</style>