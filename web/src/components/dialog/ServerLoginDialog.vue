<script setup lang="ts">
/**
 * ServerLoginDialog：后端服务对接弹窗。
 * 输入后端服务地址 + 用户名/密码。
 * 授权规则：本地 loopback 直连不鉴权（隐藏用户名/密码）；远端地址需登录（签发双 token）。
 * 登录 / 设置地址成功后 reload，让 bootstrap 以新连接目标 + token 重新初始化。
 */
import { computed, ref, watch } from 'vue'
import { useAuthStore, hostOf, isLoopbackHost, normalizeAddress } from '@/stores/auth'

const props = defineProps<{ visible: boolean }>()
const emit = defineEmits<{ (e: 'update:visible', v: boolean): void }>()

const auth = useAuthStore()

const DEFAULT_LOCAL = 'http://localhost:8183'
const address = ref(auth.serverAddress || DEFAULT_LOCAL)
const username = ref('')
const password = ref('')
const busy = ref(false)
const error = ref<string | null>(null)

const isLocal = computed(() => {
  const host = hostOf(normalizeAddress(address.value))
  return host !== '' ? isLoopbackHost(host) : true
})

watch(
  () => props.visible,
  (open) => {
    if (!open) return
    address.value = auth.serverAddress || DEFAULT_LOCAL
    username.value = ''
    password.value = ''
    error.value = null
  },
)

async function submit(): Promise<void> {
  const base = normalizeAddress(address.value)
  if (!base) {
    error.value = '请输入后端服务地址'
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
        error.value = '请输入用户名与密码'
        return
      }
      await auth.login(base, username.value, password.value)
    }
    emit('update:visible', false)
    window.location.reload()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '连接失败'
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

      <el-alert v-if="error" type="error" :closable="false" :title="error" class="login-error" />

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
</style>