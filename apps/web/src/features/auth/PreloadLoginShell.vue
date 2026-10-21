<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useAuthStore, useConnectionStore, normalizeAddress, type AuthMode } from '@/application/auth/public'
const emit = defineEmits<{ ready: [] }>()
const props = defineProps<{ loadError?: string }>()
const auth = useAuthStore(); const connection = useConnectionStore()
const address = ref(auth.serverAddress); const mode = ref<AuthMode>('direct-password'); const backendId = ref('')
const username = ref(auth.savedUsername); const password = ref(''); const busy = ref(false); const error = ref<{ detail: string; title?: string } | null>(null)
const availableBackends = ref<Array<{ backendId: string; displayName: string; status: string }>>([])
const discovered = ref<{ password: boolean; oidc: boolean; service: string; trustedLocal?: boolean } | null>(null)
const localTarget = computed(() => mode.value === 'local' && discovered.value?.trustedLocal === true)
const needsPassword = computed(() => mode.value !== 'relay-oidc' && mode.value !== 'local' && !(auth.loggedIn && auth.session?.target))
const canSubmit = computed(() => Boolean(discovered.value && !busy.value && (auth.loggedIn && auth.session?.target ? true : mode.value === 'local' ? discovered.value.trustedLocal : mode.value === 'relay-oidc' ? discovered.value.oidc : discovered.value.password && username.value && password.value && (mode.value !== 'relay-password' || backendId.value))))
let generation = 0
async function discover(): Promise<void> {
  const current = ++generation; discovered.value = null; availableBackends.value = []; error.value = null
  try {
    auth.setServerAddress(normalizeAddress(address.value))
    const value = await auth.discover(); if (current !== generation) return
    discovered.value = value
    const oidcReturn = sessionStorage.getItem('chery.oidc.pending.v1') === auth.serverAddress
    if (oidcReturn) sessionStorage.removeItem('chery.oidc.pending.v1')
    await auth.restore(oidcReturn); if (current !== generation) return
    if (value.service === 'relay') {
      mode.value = value.oidc ? 'relay-oidc' : 'relay-password'
      const list = await auth.listBackends(); if (current !== generation) return
      availableBackends.value = list
    } else mode.value = value.trustedLocal && !value.password ? 'local' : 'direct-password'
  } catch (cause) { if (current === generation) error.value = { detail: cause instanceof Error ? cause.message : '服务发现失败，请重试' } }
}
onMounted(async () => { await discover(); if (auth.loggedIn && auth.session?.target) { try { await connection.reconnect({ waitUntilConnected: true }); emit('ready') } catch (cause) { error.value = { detail: String(cause) } } } })
watch(address, () => { generation++; discovered.value = null; availableBackends.value = []; connection.disconnect(); auth.clearSession() })
async function submit(): Promise<void> {
  if (!canSubmit.value) return
  busy.value = true; error.value = null; connection.disconnect()
  try {
    const target = normalizeAddress(address.value)
    if (auth.loggedIn && auth.session?.target && (mode.value !== 'relay-oidc' || auth.session.identity.provider === 'oidc' && (!backendId.value || backendId.value === auth.backendId))) {
      await connection.reconnect({ waitUntilConnected: true }); emit('ready'); return
    }
    if (mode.value === 'local') await auth.loginLocal()
    else if (mode.value === 'relay-oidc') {
      if (!auth.loggedIn || auth.session?.identity.provider !== 'oidc') { sessionStorage.setItem('chery.oidc.pending.v1', target); window.location.assign(`${target}/api/auth/oidc/start`); return }
      if (!backendId.value) throw new Error('请选择获准设备；没有设备时请在设备Manager申请绑定')
      await auth.chooseBackend(backendId.value)
    } else if (mode.value === 'relay-password') await auth.loginRelayPassword(target, username.value, password.value, backendId.value)
    else await auth.login(target, username.value, password.value)
    password.value = ''
    await connection.reconnect({ waitUntilConnected: true }); emit('ready')
  } catch (cause) { error.value = { detail: cause instanceof Error ? cause.message : '连接失败，请重试' }; connection.disconnect() } finally { busy.value = false }
}
</script>

<template>
  <main class="preload-shell" aria-labelledby="preload-title">
    <form class="preload-form" @submit.prevent="submit">
      <p class="preload-kicker">cheryNyxus / AUTH</p>
      <h1 id="preload-title">连接后端</h1>
      <label>
        <span>登录方式</span>
        <select v-model="mode" name="mode">
          <option v-if="!discovered || (discovered.service === 'backend' && discovered.password)" value="direct-password">直接连接后端</option>
          <option v-if="!discovered || (discovered.service === 'relay' && discovered.password)" value="relay-password">中转 + 后端用户名密码</option>
          <option v-if="!discovered || discovered.oidc" value="relay-oidc">中转 + Pocket ID</option>
          <option v-if="discovered?.trustedLocal" value="local">本机信任连接</option>
        </select>
      </label>
      <label v-if="mode === 'relay-password' || (mode === 'relay-oidc' && auth.loggedIn)">
        <span>Backend ID</span>
        <select v-if="mode === 'relay-oidc' && availableBackends.length" v-model="backendId" name="backendId" required>
          <option value="" disabled>选择已授权后端</option>
          <option v-for="item in availableBackends" :key="item.backendId" :value="item.backendId">{{ item.displayName }} ({{ item.backendId }}) · {{ item.status === 'online' ? '在线' : '离线' }}</option>
        </select>
        <input v-else-if="mode === 'relay-password'" v-model="backendId" name="backendId" autocomplete="off" required />
        <p v-else role="status">尚无获准设备；请在设备Manager发起绑定，再刷新列表。</p>
      </label>
      <label>
        <span>{{ mode.startsWith('relay') ? '中转服务地址' : '后端工作台地址' }}</span>
        <input v-model="address" name="address" autocomplete="url" inputmode="url" required />
      </label>
      <button type="button" :disabled="busy" @click="discover">检查服务 / 刷新设备</button>
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
      <p v-if="props.loadError" class="preload-error" role="alert">{{ props.loadError }}；可重新连接并加载工作台。</p>
      <p v-if="error" class="preload-error" role="alert">{{ error.detail || error.title || '连接失败，请重试。' }}</p>
      <button type="submit" :disabled="!canSubmit || busy">
        {{ busy ? '正在连接…' : auth.loggedIn && auth.session?.target ? '恢复连接' : mode === 'relay-oidc' ? (auth.loggedIn ? '连接所选设备' : '登录Pocket ID') : mode === 'local' ? '确认本机连接' : '登录后端' }}
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
  background: var(--bg);
  color: var(--ink);
  font: 14px/1.5 Inter, ui-sans-serif, system-ui, sans-serif;
}
.preload-form {
  width: min(100%, 360px);
  display: grid;
  gap: 14px;
}
.preload-kicker {
  margin: 0;
  color: var(--ink);
  font: 11px/1.2 ui-monospace, SFMono-Regular, monospace;
  letter-spacing: .08em;
}
h1 { margin: 0 0 8px; font-size: 24px; font-weight: 600; }
label { display: grid; gap: 6px; }
label span { color: var(--ink); font-size: 12px; }
input, button {
  min-height: 40px;
  border: 1px solid var(--border-strong);
  border-radius: 0;
  background: var(--surface);
  color: inherit;
  font: inherit;
  padding: 9px 10px;
}
select {
  min-height: 40px;
  border: 1px solid var(--border-strong);
  border-radius: 0;
  background: var(--surface);
  color: inherit;
  font: inherit;
  padding: 9px 10px;
}
input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
button { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); cursor: pointer; }
button:disabled { cursor: wait; opacity: .55; }
.preload-note { margin: -2px 0 0; color: var(--ink); font-size: 12px; }
.preload-error { margin: 0; color: var(--danger); font-size: 12px; }
</style>
