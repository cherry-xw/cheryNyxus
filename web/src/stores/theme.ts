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
 */
export const useThemeStore = defineStore('theme', () => {
  const theme = ref<ThemeMode>(readStoredTheme())

  function apply(): void {
    const root = document.documentElement
    root.dataset.theme = theme.value
    root.classList.toggle('dark', theme.value === 'dark')
  }

  function toggle(): void {
    theme.value = theme.value === 'dark' ? 'light' : 'dark'
    try {
      if (typeof localStorage === 'undefined') return
      localStorage.setItem(THEME_KEY, theme.value === 'dark' ? 'dark' : 'light')
    } catch {
      // 持久化失败不阻断切换（隐私模式等）
    }
    apply()
  }

  apply()

  return { theme, apply, toggle }
})