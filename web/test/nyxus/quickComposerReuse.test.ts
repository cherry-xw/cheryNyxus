import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openQuickComposerWindow } from '../../src/features/desktop/desktopBridge'

describe('Pet and Cherry Nyxus quick composer reuse', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('opens the shared native composer with the requested conversation identity', () => {
    const openWindow = vi.fn()
    vi.stubGlobal('window', { __DESKTOP_BRIDGE__: { openWindow } })

    expect(openQuickComposerWindow('nyxus-chat', 'nyxus')).toBe(true)
    expect(openWindow).toHaveBeenCalledWith({
      kind: 'composer',
      chatId: 'nyxus-chat',
      source: 'nyxus',
      view: 'composer',
    })
  })

  it('leaves browser callers on their in-page fallback', () => {
    vi.stubGlobal('window', {})

    expect(openQuickComposerWindow('browser-chat', 'pet')).toBe(false)
  })

  it('routes both desktop entries through the shared native composer helper', async () => {
    const petStage = await readFile(
      resolve(import.meta.dirname, '../../src/features/pets/PetStage.vue'),
      'utf8',
    )
    const nyxusCore = await readFile(
      resolve(import.meta.dirname, '../../src/features/pets/nyxus/components/NyxusCore.vue'),
      'utf8',
    )

    expect(petStage).toContain("openQuickComposerWindow(activeRoot(pet), 'pet')")
    expect(nyxusCore).toContain("openQuickComposerWindow(chatId, 'nyxus')")
  })

  it('uses the compact shared composer dimensions and migrates the previous default', async () => {
    const main = await readFile(resolve(import.meta.dirname, '../../electron/main.ts'), 'utf8')

    expect(main).toContain(
      "composer: { defaultSize: { width: 420, height: 640 }, minSize: { width: 380, height: 520 } }",
    )
    expect(main).toContain(
      "opts.kind === 'composer' && storedBounds.width === 440 && storedBounds.height === 720",
    )
  })
})
