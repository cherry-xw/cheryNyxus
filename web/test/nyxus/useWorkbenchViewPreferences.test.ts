import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorkbenchViewPreferences } from '@/features/agent/workbench/useWorkbenchViewPreferences'

const storageValues = new Map<string, string>()
const STORAGE_KEY = 'nx-workbench-view:preset-a'

beforeEach(() => {
  storageValues.clear()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storageValues.get(key) ?? null,
    setItem: (key: string, value: string) => storageValues.set(key, value),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useWorkbenchViewPreferences 卡牌/方向联动（2026-09-02 返工）', () => {
  it('默认横向 Signal，关闭卡牌保持 horizontal-signal', () => {
    const prefs = useWorkbenchViewPreferences('preset-a')
    expect(prefs.paperMode.value).toBe(false)
    expect(prefs.presentationMode.value).toBe('horizontal-signal')
  })

  it('卡牌开 → 纵向 Classic，关回 → 横向 Signal（双向联动）', async () => {
    const prefs = useWorkbenchViewPreferences('preset-a')
    prefs.paperMode.value = true
    await nextTick()
    expect(prefs.presentationMode.value).toBe('vertical-classic')
    prefs.paperMode.value = false
    await nextTick()
    expect(prefs.presentationMode.value).toBe('horizontal-signal')
  })

  it('迁移：忽略存量持久化的 presentationMode 字段，按 paperMode 重新派生', async () => {
    storageValues.set(
      STORAGE_KEY,
      JSON.stringify({
        layout: 'timeline',
        foldMode: 'none',
        paperMode: false,
        presentationMode: 'vertical-classic',
      }),
    )
    const prefs = useWorkbenchViewPreferences('preset-a')
    expect(prefs.presentationMode.value).toBe('horizontal-signal')

    prefs.foldMode.value = 'partial'
    await nextTick()
    const saved = JSON.parse(storageValues.get(STORAGE_KEY) ?? '{}') as Record<string, unknown>
    expect(saved.paperMode).toBe(false)
    expect(saved.presentationMode).toBeUndefined()
  })

  it('持久化不写 presentationMode：切换卡牌后落盘仅含三项字段', async () => {
    const prefs = useWorkbenchViewPreferences('preset-a')
    prefs.paperMode.value = true
    await nextTick()
    const saved = JSON.parse(storageValues.get(STORAGE_KEY) ?? '{}') as Record<string, unknown>
    expect(saved).toEqual({ layout: 'timeline', foldMode: 'participant', paperMode: true })
  })

  it('fallback 豁免：直接写 presentationMode（fallbackToClassic 路径）不被 paperMode watch 翻转', () => {
    const prefs = useWorkbenchViewPreferences('preset-a')
    prefs.presentationMode.value = 'vertical-classic'
    expect(prefs.paperMode.value).toBe(false)
    expect(prefs.presentationMode.value).toBe('vertical-classic')
  })
})
