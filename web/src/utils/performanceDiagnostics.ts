import type { RenderQualityTier } from '@/composables/renderQuality'

export interface FrontendPerformanceSnapshot {
  qualityTier: RenderQualityTier
  frames: FrameIntervalSummary
  metrics: Readonly<Record<string, number>>
  counters: Readonly<Record<string, number>>
  longTasks: { count: number; longestMs: number }
  memory?: { usedJsHeapBytes: number; totalJsHeapBytes: number; heapLimitBytes: number }
}

export interface FrameIntervalSummary {
  sampleCount: number
  p95Ms: number
  maxMs: number
}

interface ChromePerformance extends Performance {
  memory?: {
    usedJSHeapSize: number
    totalJSHeapSize: number
    jsHeapSizeLimit: number
  }
}

const metrics = new Map<string, number>()
const counters = new Map<string, number>()
export const PERFORMANCE_FRAME_SAMPLE_LIMIT = 7_200
const frameIntervals = new Float64Array(PERFORMANCE_FRAME_SAMPLE_LIMIT)
let frameSampleCount = 0
let frameSampleCursor = 0
let longTaskCount = 0
let longestLongTaskMs = 0
let observer: PerformanceObserver | undefined

export function summarizeFrameIntervals(intervals: readonly number[]): FrameIntervalSummary {
  const values = intervals
    .filter((interval) => Number.isFinite(interval) && interval > 0)
    .sort((left, right) => left - right)
  if (!values.length) return { sampleCount: 0, p95Ms: 0, maxMs: 0 }
  const p95Index = Math.min(values.length - 1, Math.ceil(values.length * 0.95) - 1)
  return {
    sampleCount: values.length,
    p95Ms: values[p95Index]!,
    maxMs: values[values.length - 1]!,
  }
}

export function recordPerformanceFrame(intervalMs: number): void {
  if (!import.meta.env.DEV || !Number.isFinite(intervalMs) || intervalMs <= 0) return
  frameIntervals[frameSampleCursor] = Math.min(intervalMs, 250)
  frameSampleCursor = (frameSampleCursor + 1) % PERFORMANCE_FRAME_SAMPLE_LIMIT
  frameSampleCount = Math.min(frameSampleCount + 1, PERFORMANCE_FRAME_SAMPLE_LIMIT)
}

function frameIntervalSnapshot(): FrameIntervalSummary {
  const values = Array.from(
    { length: frameSampleCount },
    (_, index) => frameIntervals[index]!,
  )
  return summarizeFrameIntervals(values)
}

export function setPerformanceMetric(name: string, value: number): void {
  if (!import.meta.env.DEV || !Number.isFinite(value)) return
  metrics.set(name, value)
}

export function incrementPerformanceCounter(name: string, amount = 1): void {
  if (!import.meta.env.DEV) return
  counters.set(name, (counters.get(name) ?? 0) + amount)
}

function memorySnapshot(): FrontendPerformanceSnapshot['memory'] {
  const memory = (performance as ChromePerformance).memory
  if (!memory) return undefined
  return {
    usedJsHeapBytes: memory.usedJSHeapSize,
    totalJsHeapBytes: memory.totalJSHeapSize,
    heapLimitBytes: memory.jsHeapSizeLimit,
  }
}

export function installPerformanceDiagnostics(qualityTier: () => RenderQualityTier): () => void {
  if (!import.meta.env.DEV) return () => undefined
  if (typeof PerformanceObserver !== 'undefined') {
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longTaskCount += 1
          longestLongTaskMs = Math.max(longestLongTaskMs, entry.duration)
        }
      })
      observer.observe({ type: 'longtask', buffered: true })
    } catch {
      observer = undefined
    }
  }
  window.__CHERY_PERF__ = {
    snapshot: () => ({
      qualityTier: qualityTier(),
      frames: frameIntervalSnapshot(),
      metrics: Object.fromEntries(metrics),
      counters: Object.fromEntries(counters),
      longTasks: { count: longTaskCount, longestMs: longestLongTaskMs },
      ...(memorySnapshot() ? { memory: memorySnapshot() } : {}),
    }),
    reset: () => {
      frameSampleCount = 0
      frameSampleCursor = 0
      metrics.clear()
      counters.clear()
      longTaskCount = 0
      longestLongTaskMs = 0
    },
  }
  return () => {
    observer?.disconnect()
    observer = undefined
    delete window.__CHERY_PERF__
  }
}
