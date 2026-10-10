<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { hostOf, isLoopbackHost, normalizeAddress } from '@/domain/auth/serverAddress'
import { useAuthStore, type AuthError, type AuthMode } from '@/stores/auth'
import { useConnectionStore } from '@/stores/connection'

const emit = defineEmits<{ ready: [] }>()
const auth = useAuthStore()
const connection = useConnectionStore()

const address = ref(auth.serverAddress || (typeof window !== 'undefined' ? window.location.origin : ''))
const mode = ref<AuthMode>(auth.mode)
const backendId = ref(auth.backendId)
const availableBackends = ref<Array<{ backendId: string; displayName: string }>>([])
const username = ref(auth.savedUsername)
const password = ref('')
const busy = ref(false)
const error = ref<AuthError | null>(null)

const localTarget = computed(() => mode.value === 'local' && isLoopbackHost(hostOf(normalizeAddress(address.value))))
const needsPassword = computed(() => mode.value === 'relay-password')
const canSubmit = computed(
  () => Boolean(normalizeAddress(address.value)) &&
    (mode.value === 'local'
      ? localTarget.value
      : Boolean(backendId.value) && (!needsPassword.value || Boolean(username.value && password.value))),
)

onMounted(() => {
  if (mode.value === 'relay-oidc' && address.value && !backendId.value) {
    void fetch(`${normalizeAddress(address.value)}/api/backends`, { credentials: 'include' }).then(async (response) => {
      if (!response.ok) return
      const data = await response.json() as { backends?: Array<{ backendId: string; displayName: string }> }
      availableBackends.value = data.backends ?? []
    }).catch(() => undefined)
  }
})

async function submit(): Promise<void> {
  if (!canSubmit.value || busy.value) return
  busy.value = true
  error.value = null
  try {
    const target = normalizeAddress(address.value)
    auth.selectTarget({ address: target, backendId: backendId.value, mode: mode.value })
    connection.disconnect()
    if (localTarget.value) {
      auth.setServerAddress(target)
    } else if (mode.value === 'relay-password') {
      await auth.loginRelayPassword(target, username.value, password.value, backendId.value, false)
    } else {
      if (!backendId.value) {
        window.location.assign(`${target}/api/auth/oidc/start`)
        return
      }
      const response = await fetch(`${target}/api/session/backend`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ backendId: backendId.value }) })
      if (!response.ok) throw new Error('Pocket ID 会话无法绑定到所选后端')
      auth.setServerAddress(`${target}/backend/${backendId.value}`)
    }
    await connection.reconnect({ waitUntilConnected: true })
    emit('ready')
  } catch (cause) {
    error.value = cause as AuthError
    connection.disconnect()
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <main class="preload-shell" aria-labelledby="preload-title">
    <form class="preload-form" @submit.prevent="submit">
      <p class="preload-kicker">CHERYCLAW / AUTH</p>
      <h1 id="preload-title">连接后端</h1>
      <label>
        <span>登录方式</span>
        <select v-model="mode" name="mode">
          <option value="local">本机直连</option>
          <option value="relay-password">中转 + 后端用户名密码</option>
          <option value="relay-oidc">中转 + Pocket ID</option>
        </select>
      </label>
      <label v-if="mode !== 'local'">
        <span>Backend ID</span>
        <select v-if="mode === 'relay-oidc' && availableBackends.length" v-model="backendId" name="backendId" required>
          <option value="" disabled>选择已授权后端</option>
          <option v-for="item in availableBackends" :key="item.backendId" :value="item.backendId">{{ item.displayName }} ({{ item.backendId }})</option>
        </select>
        <input v-else v-model="backendId" name="backendId" autocomplete="off" required />
      </label>
      <label>
        <span>后端地址</span>
        <input v-model="address" name="address" autocomplete="url" inputmode="url" required />
      </label>
      <label v-if="needsPassword">
        <span>用户名</span>
        <input v-model="username" name="username" autocomplete="username" required />
      </label>
      <label v-if="needsPassword">
        <span>密码</span>
        <input v-model="password" name="password" type="password" autocomplete="current-password" required />
      </label>
      <p v-if="localTarget" class="preload-note">本机地址将使用本地连接。</p>
      <p v-else-if="mode === 'relay-oidc'" class="preload-note">Pocket ID 登录需要中转公共配置。</p>
      <p v-if="error" class="preload-error" role="alert">{{ error.detail || error.title || '连接失败，请重试。' }}</p>
      <button type="submit" :disabled="!canSubmit || busy">
        {{ busy ? '正在连接…' : '继续' }}
      </button>
    </form>
  </main>
</template>

<style scoped>
.preload-shell {
  min-height: 100%;
  display: grid;
  place-items: center;
  padding: 24px;
  background: #101316;
  color: #f3f5f6;
  font: 14px/1.5 Inter, ui-sans-serif, system-ui, sans-serif;
}
.preload-form {
  width: min(100%, 360px);
  display: grid;
  gap: 14px;
}
.preload-kicker {
  margin: 0;
  color: #aab4bb;
  font: 11px/1.2 ui-monospace, SFMono-Regular, monospace;
  letter-spacing: .08em;
}
h1 { margin: 0 0 8px; font-size: 24px; font-weight: 600; }
label { display: grid; gap: 6px; }
label span { color: #cbd2d6; font-size: 12px; }
input, button {
  min-height: 40px;
  border: 1px solid #3e484f;
  border-radius: 0;
  background: #171c20;
  color: inherit;
  font: inherit;
  padding: 9px 10px;
}
select {
  min-height: 40px;
  border: 1px solid #3e484f;
  border-radius: 0;
  background: #171c20;
  color: inherit;
  font: inherit;
  padding: 9px 10px;
}
input:focus { outline: 2px solid #7fd6c2; outline-offset: 1px; }
button { background: #7fd6c2; border-color: #7fd6c2; color: #10201d; cursor: pointer; }
button:disabled { cursor: wait; opacity: .55; }
.preload-note { margin: -2px 0 0; color: #aab4bb; font-size: 12px; }
.preload-error { margin: 0; color: #ff9d9d; font-size: 12px; }
</style>
