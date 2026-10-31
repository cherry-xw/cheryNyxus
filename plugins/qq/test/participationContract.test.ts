import { describe, expect, it } from 'vitest'
import { participationSchema } from '../src/participation.js'
describe('participation anchor contract', () => {
  it('requires an anchor only when replying', () => {
    const input = { batchId: 'batch', action: 'reply', reason: '回应实际成员' }
    expect(participationSchema.safeParse(input).success).toBe(false)
    expect(participationSchema.safeParse({ ...input, anchorRecord: { recordId: 'record', revision: 1 } }).success).toBe(true)
    expect(participationSchema.safeParse({ ...input, action: 'wait' }).success).toBe(true)
    expect(participationSchema.safeParse({ ...input, action: 'end', anchorRecord: { recordId: 'record', revision: 1 } }).success).toBe(false)
  })
})
