import { readComponentSource } from '../helpers/componentSource'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

async function standaloneNyxusMotionSource(): Promise<string> {
  return readComponentSource(
    resolve('web/src/features/pets/nyxus/composables/useStandaloneNyxusMotion.ts'),
    'utf8',
  )
}

async function nyxusCoreSource(): Promise<string> {
  return readComponentSource(
    resolve('web/src/features/pets/nyxus/components/NyxusCore.vue'),
    'utf8',
  )
}

describe('high-frequency DOM motion contract', () => {
  it('moves standalone Nyxus through compositor transforms instead of layout properties', async () => {
    const [motion, component] = await Promise.all([
      standaloneNyxusMotionSource(),
      nyxusCoreSource(),
    ])

    expect(motion).toContain("gsap.quickSetter(element, 'x', 'px')")
    expect(motion).toContain("gsap.quickSetter(element, 'y', 'px')")
    expect(motion).not.toContain("gsap.quickSetter(element, 'left'")
    expect(motion).not.toContain("gsap.quickSetter(element, 'top'")
    expect(component).toMatch(/\.nyxus-entry\s*\{[^}]*will-change:\s*transform;/s)
  })
})
