import { computed, readonly, ref, watchEffect } from 'vue'

export type MotionPreference = 'system' | 'full' | 'reduced'
export type EffectiveMotionMode = 'full' | 'reduced'

const STORAGE_KEY = 'chery-motion'
const CHANNEL_NAME = 'chery-ui-preferences'

function readPreference(): MotionPreference {
  if (typeof localStorage === 'undefined') return 'system'
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return value === 'full' || value === 'reduced' ? value : 'system'
  } catch {
    return 'system'
  }
}

const preference = ref<MotionPreference>(readPreference())
const systemReduced = ref(false)
let installed = false
let channel: BroadcastChannel | undefined

function applyExternal(value: unknown): void {
  if (value === 'system' || value === 'full' || value === 'reduced') preference.value = value
}

function install(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  const media = window.matchMedia('(prefers-reduced-motion: reduce)')
  const syncMedia = () => {
    systemReduced.value = media.matches
  }
  syncMedia()
  media.addEventListener('change', syncMedia)
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY) applyExternal(event.newValue ?? 'system')
  })
  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(CHANNEL_NAME)
    channel.addEventListener('message', (event) => applyExternal(event.data))
  }
}

install()

export function resolveMotionMode(
  selected: MotionPreference,
  prefersReduced: boolean,
): EffectiveMotionMode {
  if (selected === 'reduced') return 'reduced'
  if (selected === 'full') return 'full'
  return prefersReduced ? 'reduced' : 'full'
}

const effectiveMode = computed<EffectiveMotionMode>(() =>
  resolveMotionMode(preference.value, systemReduced.value),
)

watchEffect(() => {
  if (typeof document !== 'undefined') document.documentElement.dataset.motion = effectiveMode.value
})

export function setMotionPreference(value: MotionPreference): void {
  preference.value = value
  try {
    localStorage.setItem(STORAGE_KEY, value)
  } catch {
    // 隐私模式/受限存储不阻断当前窗口切换。
  }
  channel?.postMessage(value)
}

export function useMotionPreference() {
  return {
    preference: readonly(preference),
    effectiveMode: readonly(effectiveMode),
    setMotionPreference,
  }
}
