import { describe, expect, it } from 'vitest'
import { Method as ProtocolMethod, PUBLIC_METHODS, QQRequestSchemas, QQResponseSchemas, IngressRequestSchemas } from '@chery/protocol'
import { registerAllHandlers } from '@/service/index.js'
import { createRouter } from '@/service/message/router.js'
import { requestSchemas } from '@/service/message/schemas.js'
import { responseSchemas } from '@/service/message/responseSchemas.js'
import { Method as ServiceMethod } from '@/service/message/types.js'
import { IngressStore } from '@/service/ingress/store.js'
import { IngressHost } from '@/service/ingress/host.js'
import { registerIngressHandlers } from '@/service/ingress/handlers.js'

const dynamicMethods = Object.keys(QQRequestSchemas)
const coreMethods = PUBLIC_METHODS.filter(method => !dynamicMethods.includes(method))
const auxiliaryMethods = ['prompts.preset.get', 'prompts.preset.save', 'search.settings.get', 'search.settings.save', 'search.test']
const requestFor = (method: ProtocolMethod) => requestSchemas[method] ?? QQRequestSchemas[method as keyof typeof QQRequestSchemas]
const responseFor = (method: ProtocolMethod) => responseSchemas[method] ?? QQResponseSchemas[method as keyof typeof QQResponseSchemas]

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
  it('has one canonical set of unique current methods', () => {
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
    const requestMethods = PUBLIC_METHODS.filter((method) => requestFor(method))
    expect(sorted(requestMethods)).toEqual(sorted(PUBLIC_METHODS))
    expect(sorted(PUBLIC_METHODS.filter(method => responseFor(method)))).toEqual(sorted(PUBLIC_METHODS))
    for (const method of dynamicMethods) {
      expect(requestSchemas).not.toHaveProperty(method)
      expect(responseSchemas).not.toHaveProperty(method)
    }
  })

  it.each(PUBLIC_METHODS)('%s rejects a null params payload', (method) => {
    expect(requestFor(method).safeParse(null).success).toBe(false)
  })

  it('registers core and host methods without installing QQ business handlers', () => {
    const router = createRouter()
    registerAllHandlers(router)
    expect(router.registeredMethods()).toEqual(sorted([...coreMethods.filter(method => !(method in IngressRequestSchemas)), ...auxiliaryMethods]))
    const store = new IngressStore()
    const host = new IngressHost({ store, router, core: { listPresets: () => [], resolvePreset: () => { throw new Error('offline') }, ensureConversation: async () => { throw new Error('offline') }, submit: async () => { throw new Error('offline') }, abort: async () => {}, onEvent: () => () => {} }, connections: { credentialKind: () => undefined, isOpen: () => false, send: () => false, onClose: () => () => {} } })
    registerIngressHandlers(router, host, store)
    expect(router.registeredMethods()).toEqual(sorted([...coreMethods, ...auxiliaryMethods]))
  })
})
