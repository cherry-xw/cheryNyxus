import { describe, expect, it } from 'vitest'
import { BackendCapabilities, methodCapability } from '../../src/service/capabilities.js'

describe('backend business preset', () => {
  it('keeps shared history and execution, refuses optional public entrypoints', () => {
    const basic = new BackendCapabilities('basic')
    expect(basic.snapshot().capabilities).toEqual(['chat.core', 'interaction.respond', 'timeline.read'])
    for (const method of ['chat.open', 'chat.input.submit', 'chat.tree', 'interaction.respond', 'chat.list']) expect(basic.allows(method)).toBe(true)
    for (const method of ['config.get', 'config.save', 'terminal.create', 'workspace.list', 'task.overview', 'chat.overview.subscribe', 'credentials.save', 'mcp.connect', 'skills.preImportUrl', 'skills.listSources', 'skills.checkSource', 'skills.resyncAllSources', 'utils.models', 'chat.taskUsage.detail', 'chat.contextContent']) expect(basic.allows(method)).toBe(false)
    expect(methodCapability('chat.tree')).toBeUndefined()
  })
  it('changes instance on restart and revision on actual capability loss', () => {
    const first = new BackendCapabilities('full'); const restarted = new BackendCapabilities('full')
    expect(first.snapshot().instanceId).not.toBe(restarted.snapshot().instanceId)
    const before = first.snapshot().revision; first.disable('terminal.session')
    expect(first.snapshot().revision).not.toBe(before)
    expect(first.allows('terminal.create')).toBe(false)
    expect(() => first.disable('chat.core')).toThrow()
  })
})
