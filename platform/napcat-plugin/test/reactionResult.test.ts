import { describe, expect, it } from 'vitest'
import { reactionResult } from '../src/reactionResult.js'

describe('native reaction result', () => {
  it.each([{ result: 65002 }, { status: 'ok', retcode: 0, data: { result: 65002, errMsg: '不读取错误正文' } }])
    ('recognizes already-set without changing the existing reaction', value => {
      expect(reactionResult(value)).toEqual({ alreadySet: true })
    })
  it.each([{ result: 0 }, { result: true }, { status: 'ok', retcode: 0, data: { result: true } }])
    ('keeps actual new settings separate', value => expect(reactionResult(value)).toEqual({ alreadySet: false }))
  it.each([{ result: 1 }, { result: false }, { result: 65003 }, { status: 'failed', retcode: 1400, data: { result: 65002 } }])
    ('does not hide other native failures', value => {
      expect(() => reactionResult(value)).toThrow(expect.objectContaining({ definitelyFailed: true }))
      try { reactionResult(value) } catch (error) { expect(JSON.stringify(error)).not.toContain('errMsg') }
    })
})
