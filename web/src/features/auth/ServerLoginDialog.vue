<script setup lang="ts">
/**
 * ServerLoginDialog：后端服务对接窗（登录窗 2026-09 重置 v5：「暗房 + 灯」CyberWindow 一致壳）。
 * 视觉规格见 docs/frontend/auth-login.md；浮动形态窗口 chrome 与 desktop/CyberWindow 完全一致
 * （AUTH channel 徽记 + signal + 文字三键 + 角括号装饰层）+ LampPasswordField（原生密码框）
 * + rift-light（面板级手电光束覆盖层，光源 = 手电 icon 灯头口）。
 * 三键（弹窗自包含）：最小化 = 卷帘收缩（标题栏恢复）；最大化 = 铺满视口；关闭 = close()。
 * 输入后端服务地址 + 用户名/密码。
 * 授权规则：本地 loopback 直连不鉴权（隐藏用户名/密码）；远端地址需登录（签发双 token）。
 * 安全：远端登录凭据经「挑战式 AES-256-GCM 加密」传输（先取 challenge，再加密信封）。
 * 存储：服务地址 + 用户名始终默认记住；「记住密码」默认关，勾选后密码 AES-GCM 加密存本地并预填。
 * 地址默认：web = 当前域名/IP+端口（window.location.origin）；Electron = 本地服务（http://localhost:<webPort>），均可改。
 *
 * 浮动窗形态（工作台弹窗一致）：无全屏遮罩、标题区可拖动、ESC 关闭、`data-desktop-hit`
 * 标记（Electron desktop 透明窗穿透命中测试）。native 形态由 WindowFrame 承担窗口控制
 * （WindowFrame 标题栏已同步 CyberWindow 视觉，native 面不再渲染内部标题栏）。
 */
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import {
  hostOf,
  isLoopbackHost,
  normalizeAddress,
  useAuthStore,
  useConnectionStore,
  type AuthError,
} from '@/application/auth/public'
import { useThemeStore } from '@/application/public'
import { isElectron } from '@/application/platform/public'
import { desktopBridge } from '@/features/desktop/desktopBridge'
import LampPasswordField from './LampPasswordField.vue'

const props = withDefaults(defineProps<{ visible: boolean; native?: boolean }>(), { native: false })
const emit = defineEmits<{ (e: 'update:visible', v: boolean): void }>()

const auth = useAuthStore()
const conn = useConnectionStore()
const themeStore = useThemeStore()

/** 浅色模式标记：驱动黑光切换（纯 scoped class，替代不可靠的 html 级 :global 选择器）。 */
const isLight = computed(() => themeStore.theme === 'light')

/** 弹窗自包含三键状态：最小化 = 卷帘收缩；最大化 = 铺满视口。每次打开复位。 */
const minimized = ref(false)
const maximized = ref(false)

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

/** 手电开关状态：面板级光束（rift-light）由此驱动。 */
const lampLit = ref(false)

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

// 密码字段离开界面时恢复安全默认值，避免再次切回远端地址后仍以明文类型挂载。
watch(isLocal, (local) => {
  if (!local) return
  lampLit.value = false
  password.value = ''
})

/** 先选后测（渲染期前置禁用）：地址必填；远端还需用户名/密码。点击校验保留作纵深防御。 */
const canSubmit = computed(
  () =>
    normalizeAddress(address.value) !== '' &&
    (isLocal.value || (username.value !== '' && password.value !== '')),
)
const submitHint = computed(() => {
  if (!normalizeAddress(address.value)) return '请先填写后端服务地址'
  if (!isLocal.value && !username.value) return '请先填写用户名'
  if (!isLocal.value && !password.value) return '请先填写密码'
  return ''
})

/** 错误图标（按 kind 映射） */
const errorIcon = computed(() => {
  switch (error.value?.kind) {
    case 'network':
      return 'LINK'
    case 'cors':
      return 'CORS'
    case 'timeout':
      return 'TIME'
    case 'credential':
      return 'AUTH'
    case 'http':
      return 'HTTP'
    default:
      return 'ERR'
  }
})

function close(): void {
  emit('update:visible', false)
}

/** 标题区拖拽（与 SettingsDialog/WorkbenchDialog 一致的 offset 方案）。 */
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
    if (!open) {
      lampLit.value = false
      password.value = ''
      stopLight()
      return
    }
    address.value = auth.serverAddress || defaultAddress.value
    username.value = auth.savedUsername
    password.value = isLocal.value ? '' : await auth.savedPasswordPlain()
    rememberPw.value = auth.rememberPassword
    error.value = null
    showRaw.value = false
    toast.value = ''
    offset.x = 0
    offset.y = 0
    minimized.value = false
    maximized.value = false
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

/* —— 面板级手电光束：rAF 驱动光源/光斑/抖动 CSS 变量（光层局部坐标，fixed 覆盖层消费） —— */
const stageRef = ref<HTMLElement | null>(null)
const lightRef = ref<HTMLElement | null>(null)
const lampField = ref<InstanceType<typeof LampPasswordField> | null>(null)
let lightRaf = 0
const prefersReducedMotion =
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

function stopLight(): void {
  if (lightRaf) {
    cancelAnimationFrame(lightRaf)
    lightRaf = 0
  }
}

/** 每帧更新光束几何：stage 局部坐标 + 光层偏移注入。
 *  v11 运动学：发射点（灯头口）完全锚定——唯一运动自由度为绕灯头的角度摆动，
 *  只有尾部上下动，无整体平移；粗细/长度从控件实测派生（近端=灯头口、
 *  远端=井高×0.8、长度=灯头至面板左缘+0.75×井宽），浮动/最大化两形态自适应。 */
function updateLight(now: number): void {
  const stage = stageRef.value
  const light = lightRef.value
  if (!stage || !light) return
  // 拖动时浮窗 transform 会接管 fixed 覆盖层的包含块，故每帧测相对偏移而非假定 viewport
  const stageRect = stage.getBoundingClientRect()
  const lightRect = light.getBoundingClientRect()
  const ox = stageRect.left - lightRect.left
  const oy = stageRect.top - lightRect.top
  const well = lampField.value?.wellElement ?? null
  const wellRect = well?.getBoundingClientRect() ?? null
  const style = stage.style
  // 发射点 = 手电 icon 灯头口（按钮内灯头朝左，x ≈ 按钮左缘 +14px）：锚定不随动画移动
  const sw = lampField.value?.switchElement ?? null
  const swRect = sw?.getBoundingClientRect() ?? null
  const srcX = swRect ? swRect.left - stageRect.left + 14 : stageRect.width
  const srcY = swRect ? swRect.top + swRect.height / 2 - stageRect.top : stageRect.height * 0.5
  // 上下角度摆动（唯一旋转动态）：绕灯头 rotate，灯与光同角度刚体旋转（icon 不放大，
  // 角度零偏差）——±1.5° 慢摆（≈31s）+ 高频角度微抖；reduced-motion 下静止。
  // CSS 正角 = 顺时针 = 远端（左）上抬
  const tiltDeg = prefersReducedMotion
    ? 0
    : 1.5 * Math.sin(now * 0.0002) + 0.4 * Math.sin(now * 0.005) + 0.3 * Math.sin(now * 0.0013)
  style.setProperty('--beam-tilt', `${tiltDeg.toFixed(2)}deg`)
  // 手持整体浮动：icon 与光束发射点同步 bob（±2px，与主摆同相）——16px 小图标上
  // 纯旋转不可见，可见晃动感由此提供；灯与光刚体一致，角度不产生偏差
  const bobY = prefersReducedMotion ? 0 : 2 * Math.sin(now * 0.00017)
  style.setProperty('--lamp-bob', `${bobY.toFixed(2)}px`)
  style.setProperty('--beam-src-x', `${srcX + ox}px`)
  style.setProperty('--beam-src-y', `${srcY + bobY + oy}px`)
  // 粗细派生：近端半高 = 灯头口（按钮高 ×0.1），远端半高 = 井高 ×0.8
  const halfNear = swRect ? Math.max(2, swRect.height * 0.1) : 4
  const halfFar = wellRect ? Math.max(12, wellRect.height * 0.8) : 34
  style.setProperty('--beam-half-near', `${halfNear.toFixed(1)}px`)
  style.setProperty('--beam-half-far', `${halfFar.toFixed(1)}px`)
  // 长度派生：从灯头延伸至面板左缘外 0.75×井宽——可见光贯穿窗口并溢出
  const spill = wellRect ? wellRect.width * 0.75 : stageRect.width * 0.6
  style.setProperty('--beam-len', `${Math.round(srcX + spill)}px`)
}

function startLight(): void {
  stopLight()
  updateLight(performance.now())
  if (prefersReducedMotion) return
  const tick = (now: number): void => {
    updateLight(now)
    lightRaf = requestAnimationFrame(tick)
  }
  lightRaf = requestAnimationFrame(tick)
}

watch(lampLit, (on) => {
  if (on) startLight()
  else stopLight()
})
// 卷帘收缩时输入井不可见：光束暂停，恢复时若灯仍亮则重启
watch(minimized, (min) => {
  if (min) stopLight()
  else if (lampLit.value) startLight()
})
onBeforeUnmount(stopLight)
</script>

<template>
  <Teleport to="body">
    <Transition name="rift-fade">
      <div
        v-if="visible"
        class="rift-float"
        :class="{
          'is-native': native,
          'is-light': isLight,
          'is-lit': lampLit,
          'is-min': minimized,
          'is-max': maximized,
        }"
        data-desktop-hit
        role="dialog"
        aria-modal="true"
        aria-label="连接后端服务"
        :style="native ? undefined : { transform: `translate(${offset.x}px, ${offset.y}px)` }"
      >
        <div ref="stageRef" class="rift-stage">
          <div class="rift-panel" :class="{ 'is-error': !!error }">
            <span class="cyber-corners" aria-hidden="true" />
            <!-- 标题栏（CyberWindow 同款：channel + 标题 + signal + 三键；native 由 WindowFrame 承担） -->
            <header
              v-if="!native"
              class="rift-head"
              @pointerdown="onTitlePointerDown"
              @dblclick="maximized = !maximized"
            >
              <span class="rift-channel">AUTH</span>
              <strong class="rift-title">{{ isLocal ? '连接本地服务' : '连接后端服务' }}</strong>
              <span class="rift-signal" aria-hidden="true">01 ▰▰▰</span>
              <div class="rift-actions">
                <button
                  type="button"
                  aria-label="最小化"
                  title="最小化"
                  @click="minimized = !minimized"
                >
                  _
                </button>
                <button
                  type="button"
                  :aria-label="maximized ? '还原窗口' : '最大化窗口'"
                  :title="maximized ? '还原' : '最大化'"
                  @click="maximized = !maximized"
                >
                  {{ maximized ? '❐' : '□' }}
                </button>
                <button type="button" aria-label="关闭" title="关闭（ESC）" @click="close">
                  ×
                </button>
              </div>
            </header>

            <div v-show="!minimized" class="rift-body">
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
                  <button v-if="loggedIn" type="button" class="btn btn--danger" @click="logout">
                    登出
                  </button>
                  <button
                    v-else-if="localConnected"
                    type="button"
                    class="btn btn--ghost"
                    @click="disconnectLocal"
                  >
                    断开连接
                  </button>
                </div>
              </template>

              <!-- 登录表单 -->
              <form v-else class="rift-form" @submit.prevent="submit">
                <label class="field">
                  <span class="field-label">后端服务地址</span>
                  <input
                    v-model="address"
                    class="rift-input"
                    placeholder="http://127.0.0.1:8183"
                    spellcheck="false"
                  />
                </label>

                <template v-if="!isLocal">
                  <label class="field">
                    <span class="field-label">用户名</span>
                    <input
                      v-model="username"
                      class="rift-input"
                      autocomplete="username"
                      spellcheck="false"
                    />
                  </label>
                  <LampPasswordField
                    ref="lampField"
                    v-model="password"
                    v-model:lit="lampLit"
                    :theme="themeStore.theme"
                    autocomplete="current-password"
                  />

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

                <div v-if="error" class="rift-error">
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
                    error.raw instanceof Error
                      ? `${error.raw.name}: ${error.raw.message}`
                      : error.raw
                  }}</pre>
                </div>

                <div class="actions">
                  <button v-if="!native" type="button" class="btn btn--ghost" @click="close">
                    取消
                  </button>
                  <button
                    type="submit"
                    class="btn btn--primary"
                    :class="{ 'btn--busy': busy }"
                    :disabled="!canSubmit || busy"
                    :title="submitHint || undefined"
                  >
                    {{ busy ? (isLocal ? '连接中…' : '登录中…') : isLocal ? '连接' : '登录并连接' }}
                  </button>
                </div>
              </form>
            </div>
          </div>

          <!-- 面板级手电光束覆盖层：光层局部坐标 fixed 定位，可溢出面板且不产生滚动条 -->
          <div ref="lightRef" class="rift-light" :class="{ 'is-on': lampLit }" aria-hidden="true">
            <div class="light-cone" />
          </div>

          <!-- 浮窗下方 toast -->
          <Transition name="toast-fade">
            <div v-if="toast" class="rift-toast">{{ toast }}</div>
          </Transition>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped lang="less" src="./ServerLoginDialog.styles.less"></style>
