import { describe, expect, it } from 'vitest'
import { Method as ProtocolMethod, PUBLIC_METHODS } from '@chery/protocol'
import { registerAllHandlers } from '@/service/index.js'
import { createRouter } from '@/service/message/router.js'
import { requestSchemas } from '@/service/message/schemas.js'
import { responseSchemas } from '@/service/message/responseSchemas.js'
import { Method as ServiceMethod } from '@/service/message/types.js'

const retiredPublicEntries = [
  'chat.get',
  'chat.send',
  'chat.resume',
  'chat.sync',
  'chat.startSpawn',
  'chat.sendToChild',
  'chat.attach',
  'sense.approval',
  'sense.question.answer',
  'sense.question.batchAnswer',
] as const

function sorted(values: readonly string[]): string[] {
  return [...values].sort()
}

describe('public RPC catalog completeness', () => {
  it('has one canonical set of 78 unique current methods', () => {
    expect(PUBLIC_METHODS).toHaveLength(78)
    expect(new Set(PUBLIC_METHODS).size).toBe(PUBLIC_METHODS.length)
    expect(sorted(Object.values(ProtocolMethod))).toEqual(sorted(PUBLIC_METHODS))
    expect(sorted(Object.values(ServiceMethod))).toEqual(sorted(PUBLIC_METHODS))
  })

  it('keeps retired command/journal names outside every public boundary', () => {
    for (const method of retiredPublicEntries) {
      expect(PUBLIC_METHODS).not.toContain(method)
      expect(Object.values(ServiceMethod)).not.toContain(method)
    }
  })

  it('covers every public method with request and response schemas', () => {
    const requestMethods = PUBLIC_METHODS.filter((method) => method in requestSchemas)
    expect(sorted(requestMethods)).toEqual(sorted(PUBLIC_METHODS))
    expect(sorted(Object.keys(responseSchemas))).toEqual(sorted(PUBLIC_METHODS))
  })

  it.each(PUBLIC_METHODS)('%s rejects a null params payload', (method) => {
    expect(requestSchemas[method].safeParse(null).success).toBe(false)
  })

  it('registerAllHandlers registers exactly the public catalog', () => {
    const router = createRouter()
    registerAllHandlers(router)
    expect(router.registeredMethods()).toEqual(sorted(PUBLIC_METHODS))
  })
})
