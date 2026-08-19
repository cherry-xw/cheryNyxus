import { defineStore } from 'pinia'
import { ref } from 'vue'

export type ThemeMode = 'light' | 'dark'

/** localStorage 持久化 key（与 usePianoAudio 等既有 ad-hoc 持久化模式一致）。 */
const THEME_KEY = 'chery-theme'

function readStoredTheme(): ThemeMode {
  try {
    if (typeof localStorage === 'undefined') return 'light'
    return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

/**
 * 主题 store：管理全局深浅色。
 * apply() 把 theme 落到 documentElement 的 data-theme 属性 + Element Plus 的 html.dark class。
 * store 定义即 apply（首渲前应用，避免浅色一闪）。
 *
 * 跨窗主题同步（Electron 原生窗）：
 * - toggle()（本地主动切换）→ notifyChanged() → App.vue 桥接层经 IPC 广播其它窗；
 * - applyFrom()（接收 main 广播的其它窗主题）→ 只应用、**不 notify**——避免回环
 *   （广播终点再广播会形成 toggle→emit→applyFrom→emit 死循环）。
 * - onChanged() 订阅本地主题变化（UI 依赖 + 广播 + backgroundColor 回写共用）。
 */
export const useThemeStore = defineStore('theme', () => {
  const theme = ref<ThemeMode>(readStoredTheme())
  const listeners = new Set<(t: ThemeMode) => void>()

  function apply(): void {
    const root = document.documentElement
    root.dataset.theme = theme.value
    root.classList.toggle('dark', theme.value === 'dark')
  }

  function persist(): void {
    try {
      if (typeof localStorage === 'undefined') return
      localStorage.setItem(THEME_KEY, theme.value === 'dark' ? 'dark' : 'light')
    } catch {
      // 持久化失败不阻断切换（隐私模式等）
    }
  }

  function notifyChanged(): void {
    for (const listener of listeners) listener(theme.value)
  }

  function toggle(): void {
    theme.value = theme.value === 'dark' ? 'light' : 'dark'
    persist()
    apply()
    notifyChanged()
  }

  /** 接收跨窗广播：应用外部主题（不 notify，防广播回环）。 */
  function applyFrom(next: ThemeMode): void {
    theme.value = next
    persist()
    apply()
  }

  /** 订阅本地主题变化（toggle / 初始化）。返回退订函数。 */
  function onChanged(listener: (t: ThemeMode) => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  apply()

  return { theme, apply, applyFrom, toggle, onChanged }
})
