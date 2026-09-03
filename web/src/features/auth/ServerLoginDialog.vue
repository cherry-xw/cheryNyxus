<script setup lang="ts">
/**
 * ServerLoginDialog：后端服务对接窗（登录窗 2026-09 重置 v5：「暗房 + 灯」CyberWindow 一致壳）。
 * 视觉规格见 docs/web/auth-login.md；浮动形态窗口 chrome 与 desktop/CyberWindow 完全一致
 * （AUTH channel 徽记 + signal + 文字三键 + 角括号/扫描线装饰层）+ LampPasswordField（显字层）
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
      stopLight()
      return
    }
    address.value = auth.serverAddress || defaultAddress.value
    username.value = auth.savedUsername
    password.value = await auth.savedPasswordPlain()
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

/** 每帧更新光束几何：stage 局部坐标 + 光层偏移注入；显字坐标换算到输入框局部。
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
  const wellTopLocal = wellRect ? wellRect.top - stageRect.top : stageRect.height * 0.55

  // 发射点 = 手电 icon 灯头口（按钮内灯头朝左，x ≈ 按钮左缘 +14px）：锚定不随动画移动
  const sw = lampField.value?.switchElement ?? null
  const swRect = sw?.getBoundingClientRect() ?? null
  const srcX = swRect ? swRect.left - stageRect.left + 14 : stageRect.width
  const srcY = swRect ? swRect.top + swRect.height / 2 - stageRect.top : stageRect.height * 0.5
  // 上下角度摆动（唯一旋转动态）：绕灯头 rotate，灯与光同角度刚体旋转（icon 不放大，
  // 角度零偏差）——±1.5° 慢摆（≈31s）+ 高频角度微抖，幅度上限受显字带文字安全区约束
  // （井左缘位移 = 井距×tanθ < ±19px；reduced-motion 下静止）。CSS 正角 = 顺时针 = 远端（左）上抬
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
  // 显字带坐标：右缘（近灯头）中线 = 发射点高度；左缘（远端）随倾角
  // （光束中线在井左缘处 y = srcY - d·tanθ）换算到井局部
  const tiltRad = (tiltDeg * Math.PI) / 180
  const dLeft = swRect && wellRect ? swRect.left + 14 - wellRect.left : 0
  style.setProperty('--reveal-y-far', `${srcY + bobY - dLeft * Math.tan(tiltRad) - wellTopLocal}px`)
  style.setProperty('--reveal-y', `${srcY + bobY - wellTopLocal}px`)
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

<style scoped lang="less">
/* 浮动窗（无全屏遮罩）：fixed 定位，初始位于视口偏上中心；拖动 offset 经内联 transform
   注入（translate(offset)），负 margin（-50% 卡宽 / -240px 约半卡高）保持初始中心点。 */
.rift-float {
  position: fixed;
  top: 50%;
  left: 50%;
  z-index: 3000;
  margin-left: -200px;
  margin-top: -240px;
}
.rift-float.is-native {
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  padding: 16px;
  display: grid;
  place-items: center;
  overflow: auto;
  background: var(--bg);
}
/* 卷帘最小化：窗体缩为只剩标题栏（38px），锚点同步上移保持居中观感 */
.rift-float.is-min {
  margin-top: -19px;
}
/* 最大化：铺满视口（内容区滚动） */
.rift-float.is-max {
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  padding: 16px;
  display: grid;
}
.rift-float.is-max .rift-stage {
  width: 100%;
  height: 100%;
  max-width: none;
  display: flex;
  flex-direction: column;
}
.rift-float.is-max .rift-panel {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.rift-float.is-max .rift-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.rift-stage {
  position: relative;
  width: 400px;
  max-width: calc(100vw - 32px);
  /* 暖黄光锚点：用户明确指定的"白偏黄"手电光色（本模块唯一硬编码色相，已获确认） */
  --lamp-warm: color-mix(in srgb, white 55%, #ffcf7a);
}

.rift-fade-enter-active,
.rift-fade-leave-active {
  transition: opacity 0.26s ease;
}
.rift-fade-enter-from,
.rift-fade-leave-to {
  opacity: 0;
}
.rift-fade-enter-active .rift-panel,
.rift-fade-leave-active .rift-panel {
  transition:
    transform 0.34s cubic-bezier(0.34, 1.56, 0.64, 1),
    opacity 0.26s ease;
}
.rift-fade-enter-from .rift-panel,
.rift-fade-leave-to .rift-panel {
  transform: translateY(16px) scale(0.96);
  opacity: 0;
}

/* —— 面板级手电光束覆盖层（fixed + viewport 坐标变量，pointer-events none） —— */
.rift-light {
  position: fixed;
  inset: 0;
  z-index: 3001;
  pointer-events: none;
}
.rift-light > div {
  position: absolute;
  opacity: 0;
  transition: opacity 0.3s ease;
}
.rift-light.is-on > div {
  opacity: 1;
}
/* 手电光束：独立光束盒（长度 = 面板宽 ×1.5，右端锚在 icon 灯头口），细长锥形实体光柱。
   不透明段拉过面板左缘（72% 起）——窗口内全程实亮不虚化，大胆直接超出去，远端才衰减 */
.light-cone {
  top: calc(var(--beam-src-y, -200px) - var(--beam-half-far, 34px));
  left: calc(var(--beam-src-x, -200px) - var(--beam-len, 600px));
  width: var(--beam-len, 600px);
  height: calc(var(--beam-half-far, 34px) * 2);
  background: linear-gradient(to left, var(--lamp-warm) 72%, transparent 98%);
  clip-path: polygon(
    100% calc(50% - var(--beam-half-near, 4px)),
    0 calc(50% - var(--beam-half-far, 34px)),
    0 calc(50% + var(--beam-half-far, 34px)),
    100% calc(50% + var(--beam-half-near, 4px))
  );
  /* 上下角度摆动（唯一动态）：绕灯头口（光束盒右端中点 = srcX/srcY）rotate，
     发射点锚定、只有尾部动；半高/长度由 JS 从按钮/井 rect 实测注入（v11） */
  transform: rotate(var(--beam-tilt, 0deg));
  transform-origin: 100% 50%;
  filter: blur(3px);
  mix-blend-mode: normal;
}
/* 浅色模式：黑光——光束本体近黑（ink 派生）、高不透明压住背景，光斑内文字反白
   （is-light 由 theme store 驱动，纯 scoped 规则，替代不可靠的 html 级 :global 选择器） */
.is-light .light-cone {
  background: linear-gradient(to left, var(--ink) 72%, transparent 98%);
  mix-blend-mode: normal;
}

/* —— CyberWindow 一致壳：--cyber-line 描边 + 辉光 + 角括号 + 扫描线 —— */
.rift-panel {
  position: relative;
  /* 显式文字色（v10）：Teleport 到 body 后无 body 级继承来源，深色模式下
     标题/label/记住密码/错误卡片/信息面板会继承浏览器默认黑而不可读 */
  color: var(--ink);
  background:
    radial-gradient(120% 60% at 50% 0%, var(--accent-glow), transparent 62%), var(--panel);
  border: 1px solid color-mix(in srgb, var(--cyber-line) 76%, transparent);
  border-radius: 0;
  box-shadow:
    0 24px 64px rgba(0, 0, 0, 0.34),
    0 0 28px var(--accent-glow);
}
.rift-panel.is-error {
  border-color: color-mix(in srgb, var(--el-color-danger) 70%, transparent);
}

/* 角括号标记（CyberWindow 同语法，四角对称） */
.cyber-corners {
  position: absolute;
  inset: 5px;
  z-index: 3;
  pointer-events: none;
  background:
    linear-gradient(var(--accent), var(--accent)) left top / 18px 1px no-repeat,
    linear-gradient(var(--accent), var(--accent)) left top / 1px 18px no-repeat,
    linear-gradient(var(--accent), var(--accent)) right top / 18px 1px no-repeat,
    linear-gradient(var(--accent), var(--accent)) right top / 1px 18px no-repeat,
    linear-gradient(var(--accent), var(--accent)) left bottom / 18px 1px no-repeat,
    linear-gradient(var(--accent), var(--accent)) left bottom / 1px 18px no-repeat,
    linear-gradient(var(--accent), var(--accent)) right bottom / 18px 1px no-repeat,
    linear-gradient(var(--accent), var(--accent)) right bottom / 1px 18px no-repeat;
  opacity: 0.62;
}

/* —— CyberWindow 同款标题栏（channel + 标题 + signal + 文字三键） —— */
.rift-head {
  position: relative;
  /* 高于光柱（rift-light z 3001）：光柱任意扫过都不吞标题栏文字 */
  z-index: 3004;
  height: 38px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding-left: 10px;
  border-bottom: 1px solid color-mix(in srgb, var(--cyber-line) 64%, transparent);
  background:
    linear-gradient(90deg, color-mix(in srgb, var(--accent) 15%, transparent), transparent 42%),
    var(--cyber-title-bg);
  cursor: grab;
  user-select: none;

  &:active {
    cursor: grabbing;
  }
}
.rift-channel,
.rift-signal {
  flex: none;
  color: var(--accent);
  font-family: var(--font-mono, monospace);
  font-size: 9px;
  letter-spacing: 0.12em;
}
.rift-channel {
  padding: 2px 5px;
  border: 1px solid color-mix(in srgb, var(--accent) 46%, transparent);
}
.rift-signal {
  margin-left: auto;
  opacity: 0.64;
}
.rift-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
}
.rift-actions {
  align-self: stretch;
  display: flex;
}
.rift-actions button {
  width: 38px;
  padding: 0;
  border: 0;
  border-left: 1px solid color-mix(in srgb, var(--cyber-line) 44%, transparent);
  border-radius: 0;
  background: transparent;
  color: var(--ink);
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  font-weight: 400;
  line-height: 1;
  cursor: pointer;
  transition:
    color 0.15s ease,
    background-color 0.15s ease;
}
.rift-actions button:hover {
  background: var(--accent-soft);
  color: var(--accent);
}
.rift-actions button:last-child:hover {
  background: color-mix(in srgb, var(--danger) 76%, transparent);
  color: white;
}
.rift-body {
  position: relative;
  /* 不设 z-index（避免创建 stacking context 困住内部显字层）：
     光柱（z 3001）压住 body 常规内容（光不被输入框遮挡），
     仅显字层 / caret / label / 标题栏（z 3003+/3004）浮出光上 */
  padding: 14px 16px 16px;
  display: flex;
  flex-direction: column;
}

/* 开灯时（v10 对称显字）：光柱只作背景光层——所有会阅读的内容（字段 label /
   普通输入框 / 记住密码行 / 按钮 / 错误卡片）整体浮出光柱之上（z 3003，同显字层
   待遇），任意区域可读；井底 / 面板底仍被光压住（光不被框体遮挡） */
.is-lit .rift-form .field-label,
.is-lit .rift-form .rift-input,
.is-lit .rift-form .remember,
.is-lit .rift-form .actions,
.is-lit .rift-form .rift-error {
  position: relative;
  z-index: 3003;
}

/* —— 表单 —— */
.rift-form {
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
/* 输入井（非密码字段）：聚焦点亮 */
.rift-input {
  width: 100%;
  box-sizing: border-box;
  padding: 10px 12px;
  border-radius: 0;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--ink);
  font-size: 14px;
  font-weight: 400;
  outline: none;
  transition:
    border-color 0.2s ease,
    box-shadow 0.2s ease;
}
.rift-input::placeholder {
  color: color-mix(in srgb, var(--ink) 38%, transparent);
}
.rift-input:focus {
  border-color: var(--accent);
  box-shadow: inset 0 0 12px var(--accent-glow);
}
/* 深色模式框体描边提档（v10）：深底上 --border（α0.14）过淡，框体不可辨 */
.rift-float:not(.is-light) .rift-input {
  border-color: var(--border-strong);
}

/* —— 记住密码开关（直角滑块，开 = accent 底亮灯方块） —— */
.remember {
  display: flex;
  align-items: center;
  gap: 9px;
  cursor: pointer;
  user-select: none;
  font-size: 12.5px;
  font-weight: 400;
}
.remember-input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}
.switch {
  position: relative;
  width: 34px;
  height: 18px;
  flex: none;
  border-radius: 0;
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--ink) 8%, transparent);
  transition:
    background 0.22s ease,
    border-color 0.22s ease;
}
.switch--on {
  background: var(--accent);
  border-color: var(--accent);
}
.switch-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 12px;
  height: 12px;
  border-radius: 0;
  background: color-mix(in srgb, var(--ink) 55%, transparent);
  transition:
    transform 0.22s cubic-bezier(0.34, 1.56, 0.64, 1),
    background 0.22s ease;
}
.switch--on .switch-knob {
  transform: translateX(16px);
  background: var(--bg);
  box-shadow: 0 0 6px var(--accent-glow);
}
.remember-label {
  opacity: 0.8;
}

/* —— 错误卡片（赛博告警报告） —— */
.rift-error {
  padding: 11px 13px;
  border-radius: 0;
  border: 1px solid color-mix(in srgb, var(--el-color-danger) 45%, transparent);
  border-left-width: 3px;
  background: color-mix(in srgb, var(--el-color-danger) 10%, transparent);
  animation: errorIn 0.3s ease;
}
.error-head {
  display: flex;
  align-items: center;
  gap: 7px;
}
.error-icon {
  font-size: 12px;
  font-family: var(--font-mono, monospace);
  color: var(--el-color-danger);
}
.error-title {
  font-size: 13px;
  font-weight: 600;
}
.error-detail {
  margin: 7px 0 0;
  font-size: 12px;
  font-weight: 400;
  line-height: 1.55;
  opacity: 0.85;
}
.error-backend,
.error-status {
  margin: 5px 0 0;
  font-size: 12px;
  font-weight: 400;
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
  border-radius: 0;
  color: inherit;
  opacity: 0.8;
  cursor: pointer;
  font-size: 12px;
  font-weight: 400;
  text-decoration: underline;
}
.error-raw {
  margin: 6px 0 0;
  padding: 8px;
  border-radius: 0;
  background: color-mix(in srgb, var(--ink) 8%, transparent);
  font-size: 12px;
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
  border-radius: 0;
  background: color-mix(in srgb, var(--accent) 6%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent) 22%, transparent);
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
  font-size: 13px;
}
.info-ok {
  color: var(--el-color-success);
}

/* —— 按钮（全直角；hover 光扫高光） —— */
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 9px;
  margin-top: 16px;
}
.btn {
  position: relative;
  overflow: hidden;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 10px 17px;
  border-radius: 0;
  border: none;
  font-size: 13.5px;
  font-weight: 400;
  cursor: pointer;
  transition:
    transform 0.15s ease,
    box-shadow 0.2s ease,
    opacity 0.2s ease,
    filter 0.2s ease,
    border-color 0.2s ease,
    background-color 0.2s ease;
}
/* 光扫：一道高光从左到右掠过（呼应灯主题） */
.btn::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(
    105deg,
    transparent 42%,
    color-mix(in srgb, white 26%, transparent) 50%,
    transparent 58%
  );
  transform: translateX(-130%);
  pointer-events: none;
}
.btn:hover::after {
  transform: translateX(130%);
  transition: transform 0.45s ease;
}
.btn:active {
  transform: translateY(1px) scale(0.98);
}
.btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.btn--ghost {
  border: 1px solid var(--border);
  background: transparent;
  color: var(--ink);
}
.btn--ghost:hover {
  border-color: var(--accent);
  color: var(--accent);
  box-shadow: 0 0 10px var(--accent-glow);
}
.btn--primary {
  background: var(--accent);
  color: var(--surface);
}
:global(html.dark) .btn--primary {
  color: var(--bg);
}
.btn--primary:hover:not(:disabled) {
  filter: brightness(1.08);
  box-shadow: 0 0 16px var(--accent-glow);
}
.btn--primary:disabled {
  filter: none;
}
.btn--busy {
  opacity: 0.75;
  cursor: wait;
  transform: none !important;
}
.btn--danger {
  border: 1px solid color-mix(in srgb, var(--el-color-danger) 45%, transparent);
  background: color-mix(in srgb, var(--el-color-danger) 12%, transparent);
  color: var(--el-color-danger);
}
.btn--danger:hover {
  background: color-mix(in srgb, var(--el-color-danger) 22%, transparent);
}

/* —— toast —— */
.rift-toast {
  position: absolute;
  top: -44px;
  left: 50%;
  transform: translateX(-50%);
  padding: 9px 18px;
  border-radius: 0;
  background: color-mix(in srgb, var(--panel) 88%, transparent);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  color: var(--ink);
  font-size: 13px;
  font-weight: 400;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
  border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
  white-space: nowrap;
}
.toast-fade-enter-active,
.toast-fade-leave-active {
  transition:
    opacity 0.25s ease,
    transform 0.25s ease;
}
.toast-fade-enter-from,
.toast-fade-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(-8px);
}

@media (prefers-reduced-motion: reduce) {
  .btn::after {
    display: none;
  }
  .rift-fade-enter-active .rift-panel,
  .rift-fade-leave-active .rift-panel {
    transition: opacity 0.26s ease;
  }
  .rift-fade-enter-from .rift-panel,
  .rift-fade-leave-to .rift-panel {
    transform: none;
  }
  .rift-light > div {
    transition: none;
  }
}
</style>
