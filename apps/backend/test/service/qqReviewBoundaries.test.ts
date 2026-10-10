import fs from 'node:fs'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { IngressStore } from '@/service/ingress/store.js'
import { IngressHost } from '@/service/ingress/host.js'
import { createRouter } from '@/service/message/router.js'
import { logger } from '@/utils/logger/index.js'
import { QQDefaultConfig } from '../../../../packages/protocol/src/qq.js'
import { QQMemoryStore } from '../../../../plugins/qq/src/memory.js'

const roots: string[] = []
const hosts: IngressHost[] = []
const previous = process.env.CHERY_DIR
function temp() {
  const root = fs.mkdtempSync(path.join(process.env.CHERY_TEST_RUN_DIR!, 'qq-review-'))
  roots.push(root)
  return root
}
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  if (previous === undefined) delete process.env.CHERY_DIR
  else process.env.CHERY_DIR = previous
})
it('group memory operations preserve existing group entries and never copy member entries', async () => {
    const memory = new QQMemoryStore(temp())
    const identity = { selfId: '1', conversationType: 'group' as const, groupId: '123', userId: '456' }
    await memory.manage(identity, { scope: 'member', save: [{ name: 'member_only', content: 'member-only-marker' }] })
    await memory.manage(identity, { scope: 'group', save: [{ name: 'first', content: 'group-first-marker' }] })
    await memory.manage(identity, { scope: 'group', save: [{ name: 'second', content: 'group-second-marker' }] })
    const listed = JSON.stringify(JSON.parse(await memory.prepare(identity)).scopes.group)
    expect(listed).toContain('group-first-marker')
    expect(listed).toContain('group-second-marker')
    expect(listed).not.toContain('member-only-marker')
})
it('QQ disable removes business and retains management status', async () => {
  const store = new IngressStore(temp())
  store.install(path.resolve('plugins/qq/dist'), false, undefined, {
    grantedCapabilities: ['ingress', 'rpc.business', 'rpc.management', 'tools', 'hooks', 'channel.identity', 'manager.ui'],
    channelGrants: [{ channel: 'qq', credentialKind: 'qq' }],
  })
  store.setEnabled('cherynyxus-qq-module', true)
  store.saveConfig('cherynyxus-qq-module', QQDefaultConfig, 0)
  const router = createRouter()
  const host = new IngressHost({ store, router,
    core: { listPresets: () => [], resolvePreset: () => { throw new Error('not used') }, ensureConversation: async () => ({ chatId: 'synthetic' }), submit: async () => ({} as any), abort: async () => {}, onEvent: () => () => {} },
    connections: { credentialKind: () => undefined, isOpen: () => false, send: () => false, onClose: () => () => {} },
  })
  hosts.push(host)
  await host.start()
  expect(host.status()[0]?.state).toBe('active')
  await host.disable('cherynyxus-qq-module')
  store.setEnabled('cherynyxus-qq-module', false)
  expect(host.status()[0]).toMatchObject({ enabled: false, state: 'stopped' })
  const response: any = await router.handle({ kind: 'request', id: 'review-status', method: 'qq.status.get', params: {} } as any, { connectionId: 'control', credentialKind: 'control', log: logger })
  expect(response.success).toBe(true)
  expect(response.data.enabled).toBe(false)
})
