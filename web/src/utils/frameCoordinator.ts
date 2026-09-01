import { gsap } from 'gsap'
import { reportDisplayFrame } from '../composables/renderQuality'
import { recordPerformanceFrame } from './performanceDiagnostics'

export interface DisplayFrame {
  now: number
  deltaMs: number
  deltaSeconds: number
}

export type DisplayFrameSubscriber = (frame: DisplayFrame) => void

const subscribers = new Set<DisplayFrameSubscriber>()
let active = false
let lastNow = 0

function onVisibilityChange(): void {
  lastNow = document.hidden ? 0 : performance.now()
}

function tick(): void {
  if (typeof document !== 'undefined' && document.hidden) {
    lastNow = 0
    return
  }
  const now = performance.now()
  const deltaMs = lastNow > 0 ? Math.min(250, Math.max(0, now - lastNow)) : 0
  lastNow = now
  if (deltaMs <= 0) return
  reportDisplayFrame(deltaMs, now)
  recordPerformanceFrame(deltaMs)
  const frame = { now, deltaMs, deltaSeconds: Math.min(0.04, deltaMs / 1000) }
  for (const subscriber of subscribers) subscriber(frame)
}

function start(): void {
  if (active) return
  active = true
  lastNow = performance.now()
  gsap.ticker.add(tick)
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibilityChange)
}

function stop(): void {
  if (!active) return
  active = false
  gsap.ticker.remove(tick)
  if (typeof document !== 'undefined')
    document.removeEventListener('visibilitychange', onVisibilityChange)
  lastNow = 0
}

/**
 * 所有 DOM 物理/高频写入共享的按需显示帧时钟。
 * 首个订阅者启动、最后一个订阅者离开即停；每个真实显示帧只采样一次。
 */
export const frameCoordinator = {
  subscribe(subscriber: DisplayFrameSubscriber): () => void {
    subscribers.add(subscriber)
    start()
    return () => {
      subscribers.delete(subscriber)
      if (!subscribers.size) stop()
    }
  },
  get subscriberCount(): number {
    return subscribers.size
  },
}
