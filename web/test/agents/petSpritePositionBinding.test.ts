import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('PetSprite position binding', () => {
  it('routes the world position ref to the draggable Pet body only', async () => {
    const source = await readFile(
      new URL('../../src/features/pets/components/PetSprite.vue', import.meta.url),
      'utf8',
    )
    const bubbles = source.match(/<PetBubbles[\s\S]*?<\/PetBubbles>/)?.[0] ?? ''
    const body = source.match(/<PetBody[\s\S]*?\/>/)?.[0] ?? ''

    expect(bubbles).not.toContain(':position-ref="positionRef"')
    expect(body).toContain(':position-ref="positionRef"')
  })
})
