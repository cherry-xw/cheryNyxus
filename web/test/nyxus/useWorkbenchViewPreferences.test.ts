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

describe('useWorkbenchViewPreferences unified canvas migration', () => {
  it('defaults to participant folding', () => {
    const prefs = useWorkbenchViewPreferences('preset-a')
    expect(prefs.foldMode.value).toBe('participant')
  })

  it('keeps folding while ignoring obsolete panel and layout preferences', () => {
    storageValues.set(
      STORAGE_KEY,
      JSON.stringify({
        layout: 'topology',
        foldMode: 'none',
        paperMode: true,
        presentationMode: 'vertical-classic',
      }),
    )
    const prefs = useWorkbenchViewPreferences('preset-a')
    expect(prefs.foldMode.value).toBe('none')
  })

  it('persists only the fold owner', async () => {
    const prefs = useWorkbenchViewPreferences('preset-a')
    prefs.foldMode.value = 'partial'
    await nextTick()
    const saved = JSON.parse(storageValues.get(STORAGE_KEY) ?? '{}') as Record<string, unknown>
    expect(saved).toEqual({ foldMode: 'partial' })
    expect(saved).not.toHaveProperty('layout')
    expect(saved).not.toHaveProperty('paperMode')
    expect(saved).not.toHaveProperty('presentationMode')
  })
})
