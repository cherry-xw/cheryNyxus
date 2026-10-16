import { describe, expect, it } from 'vitest'
import { readQQFile, writeQQFile } from '../src/files.js'
const subject = { selfId: '123456789', userId: '649207438', conversationType: 'private' as const }
describe('managed application files boundary', () => {
  it('rejects read and write into apps before accessing disk', async () => {
    await expect(readQQFile('/nonexistent-test-root', subject, { path: 'apps/test-app/project/index.js' })).rejects.toThrow('managed_app')
    await expect(writeQQFile('/nonexistent-test-root', subject, { path: 'apps/test-app/project/index.js', content: 'test' })).rejects.toThrow('managed_app')
  })
})
