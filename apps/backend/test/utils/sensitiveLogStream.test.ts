import { describe, expect, it } from 'vitest'
import { SensitiveLogStream } from '@/utils/sensitiveLogStream.js'

const env = { API_KEY: 'secret-abcdefgh', PASSWORD: 'abc', NODE_ENV: 'production' }
function sanitize(parts: Buffer[]): Buffer {
  const stream = new SensitiveLogStream(env, 8)
  return Buffer.concat([...parts.map((part) => stream.write(part)), stream.end()])
}

describe('SensitiveLogStream', () => {
  it('redacts bare values and assignments at every possible chunk boundary', () => {
    const input = Buffer.from('before secret-abcdefgh after\nAPI_KEY = "other-value"\nPASSWORD=abc\r\nNODE_ENV=production\n中文')
    const expected = 'before [REDACTED] after\nAPI_KEY =[REDACTED]\nPASSWORD=[REDACTED]\r\nNODE_ENV=production\n中文'
    for (let boundary = 0; boundary <= input.length; boundary++) {
      expect(sanitize([input.subarray(0, boundary), input.subarray(boundary)]).toString()).toBe(expected)
    }
    expect(sanitize([...input].map((byte) => Buffer.from([byte]))).toString()).toBe(expected)
  })

  it('preserves original binary bytes and unterminated non-secret suffixes', () => {
    const input = Buffer.from([255, 254, 0, 65, 80, 73, 95, 75])
    expect(sanitize([...input].map((byte) => Buffer.from([byte])))).toEqual(input)
    expect(sanitize([Buffer.from('MY_API_KEY=short\nAPI_KEYS=kept\nabc')]).toString()).toBe('MY_API_KEY=short\nAPI_KEYS=kept\nabc')
  })

  it('does not retain or leak an arbitrarily long assignment value without newlines', () => {
    const stream = new SensitiveLogStream(env, 8)
    expect(stream.write(Buffer.from('API_KEY=')).toString()).toBe('API_KEY=[REDACTED]')
    for (let i = 0; i < 100; i++) expect(stream.write(Buffer.alloc(8192, 97)).length).toBe(0)
    expect(stream.write(Buffer.from('\nsafe')).toString()).toBe('\nsafe')
    expect(stream.end().length).toBe(0)
  })
})
