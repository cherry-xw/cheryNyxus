import { describe, it, expect, vi } from 'vitest'
import { QQPlugin } from '../src/index.js'

function fixture(privateAllowed: boolean) {
  const claim = vi.fn(async () => [{ id: '649207438:demo:1:T_1H', userId: '649207438', appId: 'demo', text: '应用 demo 即将到期。', creatorChannel: { selfId: '123456', userId: '649207438', conversationType: 'group', groupId: '987654' } }])
  const report = vi.fn(async () => {})
  const plugin = Object.create(QQPlugin.prototype) as any
  plugin.context = { appNotifications: { claim, report } }
  plugin.state = { identityBinding: { selfId: '123456' }, jobs: [{ requestId: 'original', target: privateAllowed ? 'private:user:649207438' : 'group:987654', input: { selfId: '123456', senderId: '649207438' } }], outbox: [] }
  plugin.snapshot = { config: { users: privateAllowed ? ['649207438'] : [], groups: ['987654'], bindings: { 'private:user:649207438': 'preset', 'group:987654': 'preset' } } }
  plugin.output = vi.fn(); plugin.persist = vi.fn()
  return { plugin, claim, report }
}
describe('QQ app lifecycle notification transport', () => {
  it('uses an existing allowed private target without sending native messages in test', async () => {
    const { plugin } = fixture(true)
    await plugin.enqueueAppNotifications()
    expect(plugin.state.jobs.at(-1).target).toBe('private:user:649207438')
    expect(plugin.output).toHaveBeenCalledWith(expect.any(Object), 'qq.reply.part', expect.objectContaining({ text: '应用 demo 即将到期。' }))
  })
  it('falls back only to the recorded allowed group and never contains activation tokens', async () => {
    const { plugin } = fixture(false)
    await plugin.enqueueAppNotifications()
    expect(plugin.state.jobs.at(-1).target).toBe('group:987654')
    expect(JSON.stringify(plugin.output.mock.calls)).not.toContain('activate_token')
  })
  it('does not guess a target or expand allowlists', async () => {
    const { plugin, report } = fixture(false)
    plugin.snapshot.config.groups = []
    await plugin.enqueueAppNotifications()
    expect(plugin.output).not.toHaveBeenCalled()
    expect(report).toHaveBeenCalledWith('123456', '649207438:demo:1:T_1H', 'failed')
  })
  it('does not enqueue a claimed notification twice', async () => {
    const { plugin, report } = fixture(true)
    await plugin.enqueueAppNotifications(); await plugin.enqueueAppNotifications()
    expect(plugin.output).toHaveBeenCalledTimes(1)
    expect(report).toHaveBeenCalledWith('123456', '649207438:demo:1:T_1H', 'unknown')
  })
})
