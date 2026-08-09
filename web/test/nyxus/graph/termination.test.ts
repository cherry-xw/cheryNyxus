import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { TerminationFact } from '../../../src/services/agentApi'
import { terminationDisplay } from '../../../src/features/pets/nyxus/graph/termination'

describe('termination presentation', () => {
  it('maps every durable code without exposing audit detail', async () => {
    const fixture = JSON.parse(
      await readFile(resolve('test/fixtures/cp8-real-termination.json'), 'utf8'),
    ) as { terminations: TerminationFact[]; expectedLabels: string[] }
    const displays = fixture.terminations.map(terminationDisplay)
    expect(displays.map((item) => item.label)).toEqual(fixture.expectedLabels)
    expect(displays.every((item) => !('detail' in item))).toBe(true)
  })
})
