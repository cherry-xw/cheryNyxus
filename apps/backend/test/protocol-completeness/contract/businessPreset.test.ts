import { describe, expect, it } from 'vitest'
import { registerAllHandlers } from '@/service/index.js'
import { createRouter } from '@/service/message/router.js'
import { BackendCapabilities, methodCapability } from '@/service/capabilities.js'
import { PUBLIC_METHODS } from '@chery/protocol'
import { logger } from '@/utils/logger/index.js'

describe('business preset server rejection and method closure', () => {
  it('announces required services while rejecting every optional registered public method before payload dispatch', async () => {
    const basic = new BackendCapabilities('basic')
    const router = createRouter()
    registerAllHandlers(router, 'basic')
    router.setCapabilityGate((method) => basic.allows(method))
    for (const method of PUBLIC_METHODS) {
      if (!methodCapability(method)) continue
      const result = await router.handle({ kind: 'request', id: 'capability-test', method, params: {} } as any, { connectionId: 'business-test', log: logger })
      expect(result, method).toMatchObject({ success: false, error: { code: 'CAPABILITY_DISABLED' } })
    }
    expect(router.registeredMethods()).not.toContain('chat.overview.open')
    expect(router.registeredMethods()).toContain('chat.timeline.node.get')
    expect(router.registeredMethods()).toContain('interaction.approval.decide')
  })
  it('machine credential cannot invoke business methods or bypass extension authorization', async () => {
    const router = createRouter(); registerAllHandlers(router)
    router.registerExtension({ method: 'sample.business', request: (await import('zod')).z.object({}), response: (await import('zod')).z.object({}), authorize: () => true, handler: async () => ({}) })
    const extension = await router.handle({ kind: 'request', id: 'machine-extension', method: 'sample.business', params: {} } as any, { connectionId: 'machine-test', credentialKind: 'machine', log: logger })
    expect(extension).toMatchObject({ success: false, error: { code: 'FORBIDDEN' } })
    for (const method of ['chat.open', 'chat.input.submit', 'terminal.create', 'workspace.files.read'] as const) {
      const result = await router.handle({ kind: 'request', id: 'machine-boundary', method, params: {} } as any, { connectionId: 'machine-test', credentialKind: 'machine', log: logger })
      expect(result).toMatchObject({ success: false })
    }
  })
})
