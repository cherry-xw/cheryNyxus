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
  it('defaults to participant folding with the content reader closed', () => {
    const prefs = useWorkbenchViewPreferences('preset-a')
    expect(prefs.foldMode.value).toBe('participant')
    expect(prefs.readerOpen.value).toBe(false)
  })

  it('migrates legacy paper mode once and ignores obsolete layout directions', () => {
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
    expect(prefs.readerOpen.value).toBe(true)
  })

  it('persists only the fold and reader owners', async () => {
    const prefs = useWorkbenchViewPreferences('preset-a')
    prefs.foldMode.value = 'partial'
    prefs.readerOpen.value = true
    await nextTick()
    const saved = JSON.parse(storageValues.get(STORAGE_KEY) ?? '{}') as Record<string, unknown>
    expect(saved).toEqual({ foldMode: 'partial', readerOpen: true })
    expect(saved).not.toHaveProperty('layout')
    expect(saved).not.toHaveProperty('paperMode')
    expect(saved).not.toHaveProperty('presentationMode')
  })
})
