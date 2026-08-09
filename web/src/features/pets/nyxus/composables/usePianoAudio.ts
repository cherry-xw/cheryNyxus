import { ref } from 'vue'
import type { Ref } from 'vue'

/**
 * 钢琴音 Web Audio 引擎（懒单例）。
 * - AudioContext 在首次 play（用户手势）内懒建 + resume，满足浏览器 autoplay 策略。
 * - 三角波振荡器 + ADSR 拨弦包络，合成钢琴感音色（项目无任何预置音频设施）。
 * - muted 跨会话持久化到 localStorage；多组件共享同一静音态。
 */

const MUTE_KEY = 'nx-piano-muted'

let ctx: AudioContext | null = null
let lastPlayAt = 0

/** 全局共享静音态（模块级单例，多组件同一实例）。 */
const muted: Ref<boolean> = ref(
  typeof localStorage !== 'undefined' && localStorage.getItem(MUTE_KEY) === '1',
)

function persistMute(): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(MUTE_KEY, muted.value ? '1' : '0')
}

function ensureCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null
  if (!ctx) {
    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext
    if (!Ctor) return null
    ctx = new Ctor()
  }
  return ctx
}

/**
 * 播放一个音。须在用户手势（pointer/click）同步调用链内触发，以解锁 AudioContext。
 * @param freq 频率（Hz）
 */
async function play(freq: number): Promise<void> {
  if (muted.value) return
  // 极简并发节流：3ms 内的连击丢弃，避免拖拽/连点爆音。
  const now = performance.now()
  if (now - lastPlayAt < 3) return
  lastPlayAt = now
  const audio = ensureCtx()
  if (!audio) return
  if (audio.state === 'suspended') {
    try {
      await audio.resume()
    } catch {
      /* resume 失败则本次静音，不阻塞手势 */
      return
    }
  }
  const t0 = audio.currentTime
  const osc = audio.createOscillator()
  osc.type = 'triangle'
  osc.frequency.value = freq
  const gain = audio.createGain()
  osc.connect(gain)
  gain.connect(audio.destination)
  // ADSR：5ms 起音 → 0.12s 衰减至 sustain → 0.6s 释放（exponentialRamp 须正值）。
  gain.gain.setValueAtTime(0.0001, t0)
  gain.gain.exponentialRampToValueAtTime(0.3, t0 + 0.005)
  gain.gain.exponentialRampToValueAtTime(0.18, t0 + 0.12)
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.6)
  osc.start(t0)
  osc.stop(t0 + 0.62)
}

function toggleMute(): void {
  muted.value = !muted.value
  persistMute()
}

/** 共享单例 hook：任意组件取同一 play/muted/toggleMute。 */
export function usePianoAudio(): {
  play: (freq: number) => Promise<void>
  muted: Ref<boolean>
  toggleMute: () => void
} {
  return { play, muted, toggleMute }
}
