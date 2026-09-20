import { readonly, ref } from 'vue'

/**
 * 鼠标点击特效（ba-click-fx）的启用偏好。
 *
 * 与 useMotionPreference 同模式：localStorage 持久化 + storage event /
 * BroadcastChannel 跨窗口同步，选择立即生效，无需进入配置保存流程。
 * 打开设置窗时选择「开启 / 关闭」即写入，所有同源窗口（浏览器单页、
 * Electron 各原生窗）实时一致。
 */
const STORAGE_KEY = 'chery-click-fx'
const CHANNEL_NAME = 'chery-click-fx'

function readEnabled(): boolean {
  if (typeof localStorage === 'undefined') return true
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return value !== 'false' && value !== '0'
  } catch {
    return true
  }
}

const enabled = ref<boolean>(readEnabled())
let installed = false
let channel: BroadcastChannel | undefined

function applyExternal(value: unknown): void {
  enabled.value = value !== false && value !== 'false' && value !== '0'
}

function install(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY) applyExternal(event.newValue ?? 'true')
  })
  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(CHANNEL_NAME)
    channel.addEventListener('message', (event) => applyExternal(event.data))
  }
}

install()

export function setClickFxEnabled(value: boolean): void {
  enabled.value = value
  try {
    localStorage.setItem(STORAGE_KEY, value ? 'true' : 'false')
  } catch {
    // 隐私模式/受限存储不阻断当前窗口切换。
  }
  channel?.postMessage(value)
}

export function useClickFxPreference() {
  return {
    enabled: readonly(enabled),
    setClickFxEnabled,
  }
}
