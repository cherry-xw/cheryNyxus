<script setup lang="ts">
/**
 * ServerLoginDialog：后端服务对接弹窗（拟态玻璃浮动窗，非 Element Plus）。
 * 输入后端服务地址 + 用户名/密码。
 * 授权规则：本地 loopback 直连不鉴权（隐藏用户名/密码）；远端地址需登录（签发双 token）。
 * 安全：远端登录凭据经「挑战式 AES-256-GCM 加密」传输（先取 challenge，再加密信封）。
 * 存储：服务地址 + 用户名始终默认记住；「记住密码」默认关，勾选后密码 AES-GCM 加密存本地并预填。
 * 地址默认：web = 当前域名/IP+端口（window.location.origin）；Electron = 本地服务（http://localhost:<webPort>），均可改。
 *
 * 浮动窗形态（工作台弹窗一致）：无全屏遮罩、标题栏可拖动、✕/ESC 关闭、`data-desktop-hit`
 * 标记（Electron desktop 透明窗穿透命中测试）。
 */
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { useAuthStore, hostOf, isLoopbackHost, normalizeAddress, type AuthError } from '@/stores/auth'
import { isElectron } from '@/services/platform'
import { useConnectionStore } from '@/stores'
import { desktopBridge } from '@/features/desktop/desktopBridge'

const props = withDefaults(defineProps<{ visible: boolean; native?: boolean }>(), { native: false })
const emit = defineEmits<{ (e: 'update:visible', v: boolean): void }>()

const auth = useAuthStore()
const conn = useConnectionStore()

/** 平台默认地址：Electron 本地服务；web 当前 origin。无既存地址时作为占位。 */
const defaultAddress = computed(() => {
  if (isElectron && window.__BACKEND_HTTP_URL__) return window.__BACKEND_HTTP_URL__
  if (typeof window !== 'undefined' && window.location.origin) return window.location.origin
  return 'http://localhost:8183'
})

const address = ref(auth.serverAddress || defaultAddress.value)
const username = ref('')
const password = ref('')
const rememberPw = ref(auth.rememberPassword)
const busy = ref(false)
const error = ref<AuthError | null>(null)
const showRaw = ref(false)
const toast = ref('')

/** 浮动窗位置（拖动偏移）；每次打开复位到视口中心。 */
const offset = reactive({ x: 0, y: 0 })
const dragging = ref(false)
let dragCleanup: (() => void) | undefined

/** 远端已登录 → 显示用户信息 + 登出；否则显示表单。 */
const loggedIn = computed(() => auth.isRemote && auth.loggedIn)
/** 本地 loopback 已连接成功 → 显示「已连接」态（地址 + 状态 + 断开连接），不再可重新连接。 */
const localConnected = computed(() => !auth.isRemote && conn.status === 'connected')
/** 信息面板展示的服务地址（远端已登录 / 本地已连接共用）。 */
const displayServer = computed(() => auth.serverAddress || address.value || defaultAddress.value)

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

function close(): void {
  emit('update:visible', false)
}

/** 标题栏拖拽（与 SettingsDialog/WorkbenchDialog 一致的 offset 方案）。 */
function onTitlePointerDown(e: PointerEvent): void {
  if (props.native) return
  if (e.button !== 0) return
  if ((e.target as Element | null)?.closest('button')) return
  e.preventDefault()
  const startPointer = { x: e.clientX, y: e.clientY }
  const startOffset = { x: offset.x, y: offset.y }
  dragging.value = true
  document.body.style.userSelect = 'none'
  const move = (ev: PointerEvent) => {
    offset.x = startOffset.x + ev.clientX - startPointer.x
    offset.y = startOffset.y + ev.clientY - startPointer.y
  }
  const end = () => {
    dragging.value = false
    document.body.style.userSelect = ''
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', end)
    window.removeEventListener('pointercancel', end)
    dragCleanup = undefined
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', end)
  window.addEventListener('pointercancel', end)
  dragCleanup = end
}

onBeforeUnmount(() => dragCleanup?.())

// ESC 关闭（打开时挂载）
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault()
    close()
  }
}
watch(
  () => props.visible,
  (open) => {
    if (open) window.addEventListener('keydown', onKeydown)
    else window.removeEventListener('keydown', onKeydown)
  },
)
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

watch(
  () => props.visible,
  async (open) => {
    if (!open) return
    address.value = auth.serverAddress || defaultAddress.value
    username.value = auth.savedUsername
    password.value = await auth.savedPasswordPlain()
    rememberPw.value = auth.rememberPassword
    error.value = null
    showRaw.value = false
    toast.value = ''
    offset.x = 0
    offset.y = 0
  },
)

function notify(msg: string): void {
  toast.value = msg
  window.setTimeout(() => {
    if (toast.value === msg) toast.value = ''
  }, 2200)
}

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
  if (!isLocal.value && (!username.value || !password.value)) {
    error.value = {
      kind: 'unknown',
      title: '请输入用户名与密码',
      detail: '远端地址需登录访问，用户名与密码均为必填。',
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
      await auth.login(base, username.value, password.value, rememberPw.value)
    }
    notify(isLocal.value ? '连接成功' : '登录成功')
    desktopBridge()?.emitAuthChanged({ serverAddress: base })
    emit('update:visible', false)
    // 应用内重建连接（替代 reload）：bootstrap 首次连 401 后 serverConfig 为空，
    // reconnect 会带新 token 重拉 /api/config + 重连 WS，App.vue 顶层 onStatus 自动恢复。
    void conn.reconnect()
  } catch (cause) {
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

/** 登出：清 token + 停 WS（远端无 token 再连必 401），视图切回登录表单。 */
function logout(): void {
  conn.disconnect()
  auth.logout()
  desktopBridge()?.emitAuthChanged({ loggedOut: true })
  notify('已登出')
}

/** 本地已连接 → 断开 WS 回表单（允许改地址 / 重新连接）。 */
function disconnectLocal(): void {
  conn.disconnect()
  notify('已断开连接')
}
</script>

<template>
  <Teleport to="body">
    <Transition name="glass-fade">
      <div
        v-if="visible"
        class="glass-float"
        :class="{ 'is-native': native }"
        data-desktop-hit
        role="dialog"
        aria-modal="true"
        aria-label="连接后端服务"
        :style="native ? undefined : { transform: `translate(${offset.x}px, ${offset.y}px)` }"
      >
        <div class="glass-card">
          <div class="glass-card-inner">
            <header class="glass-titlebar" @pointerdown="onTitlePointerDown">
              <div class="glass-head">
                <div class="glass-logo" aria-hidden="true">🐾</div>
                <h2 class="glass-title">{{ isLocal ? '连接本地服务' : '连接后端服务' }}</h2>
                <p class="glass-sub">{{ isLocal ? 'loopback 直连，无需登录' : '请完成远端服务登录' }}</p>
              </div>
              <button type="button" class="glass-close" aria-label="关闭" title="关闭" @click="close">
                ✕
              </button>
            </header>

            <!-- 已连接态：远端已登录 → 用户信息 + 登出；本地已连接 → 地址 + 状态 + 断开连接 -->
            <template v-if="loggedIn || localConnected">
              <div class="info-panel">
                <div class="info-row">
                  <span class="info-label">服务器</span>
                  <span class="info-value">{{ displayServer }}</span>
                </div>
                <div v-if="localConnected" class="info-row">
                  <span class="info-label">连接状态</span>
                  <span class="info-value info-ok">已连接</span>
                </div>
                <div v-else class="info-row">
                  <span class="info-label">登录用户</span>
                  <span class="info-value">{{ auth.username || '—' }}</span>
                </div>
              </div>
              <div class="actions">
                <button v-if="loggedIn" class="btn btn--danger" @click="logout">登出</button>
                <button v-else-if="localConnected" class="btn btn--ghost" @click="disconnectLocal">
                  断开连接
                </button>
              </div>
            </template>

            <!-- 登录表单 -->
            <form v-else class="glass-form" @submit.prevent="submit">
              <label class="field">
                <span class="field-label">后端服务地址</span>
                <input
                  v-model="address"
                  class="input"
                  placeholder="http://127.0.0.1:8183"
                  spellcheck="false"
                />
              </label>

              <template v-if="!isLocal">
                <label class="field">
                  <span class="field-label">用户名</span>
                  <input
                    v-model="username"
                    class="input"
                    autocomplete="username"
                    spellcheck="false"
                  />
                </label>
                <label class="field">
                  <span class="field-label">密码</span>
                  <input
                    v-model="password"
                    class="input"
                    type="password"
                    autocomplete="current-password"
                  />
                </label>

                <label class="remember">
                  <span class="switch" :class="{ 'switch--on': rememberPw }">
                    <span class="switch-knob" />
                  </span>
                  <input
                    v-model="rememberPw"
                    class="remember-input"
                    type="checkbox"
                    aria-hidden="true"
                  />
                  <span class="remember-label">记住密码（本地加密存储）</span>
                </label>
              </template>

              <div v-if="error" class="error-card">
                <div class="error-head">
                  <span class="error-icon">{{ errorIcon }}</span>
                  <strong class="error-title">{{ error.title }}</strong>
                </div>
                <p class="error-detail">{{ error.detail }}</p>
                <p v-if="error.backendMessage" class="error-backend">
                  <span class="error-label">后端：</span>{{ error.backendMessage }}
                </p>
                <p v-if="error.status" class="error-status">HTTP {{ error.status }}</p>
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

              <div class="actions">
                <button type="button" class="btn btn--ghost" @click="close">取消</button>
                <button type="submit" class="btn btn--primary" :class="{ 'btn--busy': busy }">
                  {{ busy ? (isLocal ? '连接中…' : '登录中…') : isLocal ? '连接' : '登录并连接' }}
                </button>
              </div>
            </form>
          </div>
        </div>

        <!-- 浮窗下方 toast -->
        <Transition name="toast-fade">
          <div v-if="toast" class="glass-toast">{{ toast }}</div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped lang="less">
/* 浮动窗（无全屏遮罩）：fixed 定位，初始位于视口偏上中心；拖动 offset 经内联 transform
   注入（translate(offset)），负 margin（-50% 卡宽 / -240px 约半卡高）保持初始中心点。 */
.glass-float {
  position: fixed;
  top: 50%;
  left: 50%;
  z-index: 3000;
  margin-left: -200px;
  margin-top: -240px;
}
.glass-float.is-native {
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  padding: 16px;
  display: grid;
  place-items: center;
  overflow: auto;
  background: var(--bg);

  .glass-titlebar { -webkit-app-region: drag; }
  .glass-titlebar button,
  .glass-titlebar input { -webkit-app-region: no-drag; }
}

.glass-fade-enter-active,
.glass-fade-leave-active {
  transition: opacity 0.26s ease;
}
.glass-fade-enter-from,
.glass-fade-leave-to {
  opacity: 0;
}
.glass-fade-enter-active .glass-card,
.glass-fade-leave-active .glass-card {
  transition: transform 0.34s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.26s ease;
}
.glass-fade-enter-from .glass-card,
.glass-fade-leave-to .glass-card {
  transform: translateY(16px) scale(0.96);
  opacity: 0;
}

/* —— 玻璃卡片 —— */
.glass-card {
  position: relative;
  width: 400px;
  max-width: calc(100vw - 32px);
  border-radius: 6px;
  padding: 1px;
  background: linear-gradient(
    150deg,
    rgba(255, 255, 255, 0.55),
    rgba(255, 255, 255, 0.12) 40%,
    rgba(255, 255, 255, 0.4)
  );
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.4);
}
:global(html.dark) .glass-card {
  background: linear-gradient(
    150deg,
    rgba(255, 255, 255, 0.22),
    rgba(255, 255, 255, 0.05) 40%,
    rgba(255, 255, 255, 0.16)
  );
}
.glass-card-inner {
  border-radius: 5px;
  padding: 0 28px 22px;
  background: rgba(236, 240, 255, 0.55);
  backdrop-filter: blur(24px) saturate(1.4);
  -webkit-backdrop-filter: blur(24px) saturate(1.4);
  color: #232a45;
}
:global(html.dark) .glass-card-inner {
  background: rgba(24, 28, 50, 0.55);
  color: #e8ecff;
}

/* —— 标题栏（拖动 + 关闭） —— */
.glass-titlebar {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 24px 0 0;
  cursor: grab;
  user-select: none;

  &:active {
    cursor: grabbing;
  }
}
.glass-head {
  flex: 1;
  text-align: center;
  margin-bottom: 18px;
}
.glass-logo {
  font-size: 26px;
  margin-bottom: 4px;
}
.glass-title {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  letter-spacing: 0.3px;
}
.glass-sub {
  margin: 4px 0 0;
  font-size: 12.5px;
  opacity: 0.55;
}
.glass-close {
  flex: none;
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 6px;
  color: inherit;
  opacity: 0.65;
  background: transparent;
  font-size: 13px;
  cursor: pointer;
  transition:
    opacity 120ms ease,
    background-color 120ms ease;

  &:hover {
    opacity: 1;
    background: rgba(120, 140, 255, 0.16);
  }
}

/* —— 表单 —— */
.glass-form {
  display: flex;
  flex-direction: column;
  gap: 13px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.field-label {
  font-size: 12px;
  font-weight: 600;
  opacity: 0.7;
}
.input {
  width: 100%;
  box-sizing: border-box;
  padding: 11px 13px;
  border-radius: 4px;
  border: 1px solid rgba(120, 140, 255, 0.28);
  background: rgba(255, 255, 255, 0.5);
  color: inherit;
  font-size: 14px;
  outline: none;
  transition: border-color 0.2s ease, box-shadow 0.2s ease, background 0.2s ease;
}
:global(html.dark) .input {
  background: rgba(255, 255, 255, 0.06);
  border-color: rgba(180, 196, 255, 0.24);
}
.input::placeholder {
  color: rgba(90, 100, 140, 0.5);
}
:global(html.dark) .input::placeholder {
  color: rgba(200, 210, 255, 0.4);
}
.input:focus {
  border-color: rgba(130, 150, 255, 0.7);
  background: rgba(255, 255, 255, 0.72);
  box-shadow: 0 0 0 3px rgba(130, 150, 255, 0.2);
}
:global(html.dark) .input:focus {
  background: rgba(255, 255, 255, 0.1);
}

/* —— 记住密码开关 —— */
.remember {
  display: flex;
  align-items: center;
  gap: 9px;
  cursor: pointer;
  user-select: none;
  font-size: 12.5px;
}
.remember-input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}
.switch {
  position: relative;
  width: 34px;
  height: 20px;
  flex: none;
  border-radius: 4px;
  background: rgba(120, 140, 255, 0.24);
  transition: background 0.22s ease;
}
.switch--on {
  background: linear-gradient(135deg, #6d8bff, #b06bff);
}
.switch-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
  transition: transform 0.22s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.switch--on .switch-knob {
  transform: translateX(14px);
}
.remember-label {
  opacity: 0.8;
}

/* —— 错误卡片 —— */
.error-card {
  padding: 11px 13px;
  border-radius: 4px;
  border: 1px solid rgba(224, 90, 110, 0.4);
  background: rgba(224, 90, 110, 0.1);
  animation: errorIn 0.3s ease;
}
.error-head {
  display: flex;
  align-items: center;
  gap: 7px;
}
.error-icon {
  font-size: 15px;
}
.error-title {
  font-size: 13px;
}
.error-detail {
  margin: 7px 0 0;
  font-size: 12px;
  line-height: 1.55;
  opacity: 0.85;
}
.error-backend,
.error-status {
  margin: 5px 0 0;
  font-size: 11.5px;
  opacity: 0.7;
}
.error-label {
  opacity: 0.7;
}
.error-toggle {
  margin-top: 6px;
  padding: 0;
  background: none;
  border: none;
  color: inherit;
  opacity: 0.8;
  cursor: pointer;
  font-size: 11.5px;
  text-decoration: underline;
}
.error-raw {
  margin: 6px 0 0;
  padding: 8px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.1);
  font-size: 11px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 120px;
  overflow: auto;
}
@keyframes errorIn {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* —— 已登录信息面板 —— */
.info-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.4);
  border: 1px solid rgba(120, 140, 255, 0.2);
}
:global(html.dark) .info-panel {
  background: rgba(255, 255, 255, 0.06);
}
.info-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.info-label {
  flex: none;
  width: 64px;
  opacity: 0.6;
  font-size: 12px;
}
.info-value {
  word-break: break-all;
  font-weight: 600;
}
.info-ok {
  color: #2f9e44;
}

/* —— 按钮 —— */
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 9px;
  margin-top: 16px;
}
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 10px 17px;
  border-radius: 4px;
  border: none;
  font-size: 13.5px;
  font-weight: 600;
  cursor: pointer;
  transition: transform 0.15s ease, box-shadow 0.2s ease, opacity 0.2s ease, filter 0.2s ease;
}
.btn:active {
  transform: translateY(1px) scale(0.98);
}
.btn--ghost {
  background: rgba(120, 140, 255, 0.12);
  color: inherit;
}
.btn--ghost:hover {
  background: rgba(120, 140, 255, 0.2);
}
.btn--primary {
  background: linear-gradient(135deg, #6d8bff, #b06bff);
  color: #fff;
  box-shadow: 0 8px 20px rgba(120, 140, 255, 0.4);
}
.btn--primary:hover {
  transform: translateY(-1px);
  filter: brightness(1.05);
  box-shadow: 0 12px 26px rgba(130, 150, 255, 0.5);
}
.btn--busy {
  opacity: 0.75;
  cursor: wait;
  transform: none !important;
}
.btn--danger {
  background: rgba(224, 90, 110, 0.16);
  color: #e05a6a;
}
.btn--danger:hover {
  background: rgba(224, 90, 110, 0.26);
}

/* —— toast —— */
.glass-toast {
  position: absolute;
  top: -44px;
  left: 50%;
  transform: translateX(-50%);
  padding: 9px 18px;
  border-radius: 4px;
  background: rgba(30, 34, 60, 0.72);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
  border: 1px solid rgba(255, 255, 255, 0.14);
  white-space: nowrap;
}
.toast-fade-enter-active,
.toast-fade-leave-active {
  transition: opacity 0.25s ease, transform 0.25s ease;
}
.toast-fade-enter-from,
.toast-fade-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(-8px);
}
</style>
