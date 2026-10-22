import { describe, expect, it } from 'vitest'
import { buildFileServiceToolName } from '@chery/protocol'
import {
  resolveFileCapability,
  resolveFileCapabilities,
  type FileCapabilityConfig,
  type ResolveFileCapabilityInput,
} from '@/service/fileServices/capabilityResolver.js'

const tool = buildFileServiceToolName('drawing', 'image.generate')
const inspect = buildFileServiceToolName('vision', 'image.inspect')

function fixture(): ResolveFileCapabilityInput {
  const config: FileCapabilityConfig = {
    llm: { brain: {
      text: { model: 'manual', provider: 'mock', capabilities: { toolCall: true } },
      visual: { model: 'manual-visual', provider: 'mock', capabilities: { toolCall: true, input: { image: 'supported' } } },
      plain: { model: 'plain', provider: 'mock', capabilities: { toolCall: false } },
    } },
    global: { supervision: 0 },
    roles: {
      planner: { id: 'role-planner_01', brain: 'text', senseGroup: 'coordination', permissions: { template: 'trusted' } },
      artist: { id: 'role-artist_001', brain: 'visual', senseGroup: 'drawing', permissions: { template: 'trusted' }, fileCapabilities: { 'image.generate': { mode: 'tool', targetId: tool } } },
    },
    presets: { studio: { id: 'preset-studio_001', leader: 'planner', roles: ['planner', 'artist'] } },
    sense_groups: { coordination: ['spawn_role'], drawing: [tool, inspect] },
    file_services: {
      drawing: { name: 'Drawing', adapter: 'minimax-images', connection: { baseUrl: 'https://example.com', model: 'image-01', authType: 'none' }, operations: ['image.generate'] },
      vision: { name: 'Vision', adapter: 'vision-brain', connection: { brainRef: 'visual' }, operations: ['image.inspect'] },
    },
  }
  return {
    config, configRevision: 'revision-42', roleName: 'planner', preset: 'studio', operation: 'image.generate',
    runtime: {
      brains: {
        text: { toolCall: true, nativeOperations: { 'image.generate': { availability: 'unavailable' }, 'image.inspect': { availability: 'unavailable' } } },
        visual: { toolCall: true, input: { image: 'supported' }, nativeOperations: { 'image.inspect': { availability: 'available', inputConstraints: { mimeTypes: ['image/png'], maxAssets: 2 } }, 'image.generate': { availability: 'unavailable' } } },
        plain: { toolCall: false, nativeOperations: { 'image.inspect': { availability: 'unavailable' } } },
      },
      services: {
        drawing: { 'image.generate': { availability: 'available', inputConstraints: { maxBytes: 1000 }, outputKinds: ['image'] } },
        vision: { 'image.inspect': { availability: 'available' } },
      },
    },
  }
}

describe('file capability resolution', () => {
  it('uses captured child runtime overrides and actual execution roster, not only configured membership', () => {
    const input = fixture()
    input.operation = 'image.inspect'
    input.explicit = { mode: 'role', targetId: 'artist' }
    input.runtime!.dispatchRoster = { planner: ['artist'], artist: [] }
    expect(resolveFileCapability(input)).toMatchObject({ mode: 'role', availability: 'available' })
    input.runtime!.roleSelections = { artist: { brain: 'plain', senseGroup: '' } }
    expect(resolveFileCapability(input).availability).toBe('unavailable')
    delete input.runtime!.roleSelections
    input.runtime!.dispatchRoster.planner = []
    expect(resolveFileCapability(input).reasonCode).toBe('capability.dispatch_not_allowed')
  })
  it('registered service absent from request execution table is not executable', () => {
    const input = fixture()
    input.roleName = 'artist'
    input.runtime!.executableTools = { artist: [] }
    expect(resolveFileCapability(input)).toMatchObject({ availability: 'unavailable', reasonCode: 'capability.tool_unavailable' })
  })
  it('resolves a stable role ID through the current preset and preserves revision and limits without mutation', () => {
    const input = fixture()
    input.roleId = 'role-planner_01'
    const before = JSON.stringify(input)
    expect(resolveFileCapability(input)).toMatchObject({
      availability: 'available', source: 'auto', mode: 'role', targetId: 'role-artist_001', configRevision: 'revision-42', inputConstraints: { maxBytes: 1000 }, outputKinds: ['image'],
    })
    expect(JSON.stringify(input)).toBe(before)
    expect(resolveFileCapabilities({ ...input, explicit: undefined })).toHaveLength(7)
  })

  it('uses explicit > preset override > role default > auto with no failure fallback', () => {
    const input = fixture()
    input.roleName = 'artist'
    input.config.presets!.studio!.roleOverrides = { artist: { fileCapabilities: { 'image.generate': { mode: 'native' } } } }
    expect(resolveFileCapability(input)).toMatchObject({ source: 'preset', mode: 'native', availability: 'unavailable' })
    input.explicit = { mode: 'tool', targetId: tool }
    expect(resolveFileCapability(input)).toMatchObject({ source: 'explicit', availability: 'available' })
    input.explicit = { mode: 'tool', targetId: 'missing' }
    expect(resolveFileCapability(input)).toMatchObject({ source: 'explicit', availability: 'unavailable', targetId: 'missing' })
    delete input.explicit
    delete input.config.presets!.studio!.roleOverrides
    expect(resolveFileCapability(input)).toMatchObject({ source: 'role', availability: 'available' })
  })

  it.each(['role', 'preset'] as const)('does not let explicit requests bypass a disabled %s policy', layer => {
    const input = fixture()
    input.explicit = { mode: 'role', targetId: 'role-artist_001' }
    if (layer === 'role') input.config.roles!.planner!.fileCapabilities = { 'image.generate': { mode: 'disabled' } }
    else input.config.presets!.studio!.roleOverrides = { planner: { fileCapabilities: { 'image.generate': { mode: 'disabled' } } } }
    expect(resolveFileCapability(input)).toMatchObject({ source: layer, availability: 'unavailable', reasonCode: 'capability.disabled' })
  })

  it('prefers confirmed native understanding but never derives generation from input.image', () => {
    const input = fixture()
    input.roleName = 'artist'
    input.operation = 'image.inspect'
    expect(resolveFileCapability(input)).toMatchObject({ mode: 'native', availability: 'available', inputConstraints: { mimeTypes: ['image/png'], maxAssets: 2 } })
    input.operation = 'image.generate'
    input.explicit = { mode: 'native' }
    expect(resolveFileCapability(input).availability).toBe('unavailable')
    delete input.runtime!.brains!.visual!.nativeOperations!['image.generate']
    expect(resolveFileCapability(input).availability).toBe('unknown')
  })

  it('requires an explicit understanding binding for a no-tool model, and never enables generation or delegation', () => {
    const input = fixture()
    input.roleName = 'artist'
    input.runtimeSelection = { brain: 'plain' }
    input.operation = 'image.inspect'
    expect(resolveFileCapability(input).availability).toBe('unavailable')
    input.explicit = { mode: 'tool', targetId: inspect }
    expect(resolveFileCapability(input)).toMatchObject({ availability: 'available', mode: 'tool' })
    input.runtimeSelection.senseGroup = 'coordination'
    expect(resolveFileCapability(input).reasonCode).toBe('capability.tool_not_assigned')
    input.runtimeSelection.senseGroup = 'drawing'
    input.operation = 'image.generate'
    input.explicit = { mode: 'tool', targetId: tool }
    expect(resolveFileCapability(input).reasonCode).toBe('capability.tool_call_required')
    input.explicit = { mode: 'native' }
    expect(resolveFileCapability(input).availability).toBe('unavailable')
    input.explicit = { mode: 'role', targetId: 'planner' }
    expect(resolveFileCapability(input).reasonCode).toBe('capability.tool_call_required')
  })

  it('checks current tool group membership even for an explicitly bound service', () => {
    const input = fixture()
    input.explicit = { mode: 'tool', targetId: tool }
    expect(resolveFileCapability(input).reasonCode).toBe('capability.tool_not_assigned')
    input.runtimeSelection = { senseGroup: 'drawing' }
    expect(resolveFileCapability(input).availability).toBe('available')
  })

  it('does not consider a configured service connected or implemented without captured runtime facts', () => {
    const input = fixture()
    input.roleName = 'artist'
    delete input.runtime!.services
    expect(resolveFileCapability(input)).toMatchObject({ availability: 'unknown', reasonCode: 'capability.runtime_unknown' })
  })

  it('blocks disabled services and unsupported adapter operations before runtime claims', () => {
    const input = fixture()
    input.roleName = 'artist'
    input.config.file_services!.drawing!.enabled = false
    expect(resolveFileCapability(input).reasonCode).toBe('capability.service_disabled')
    input.config.file_services!.drawing!.enabled = true
    input.config.file_services!.drawing!.adapter = 'vision-brain'
    expect(resolveFileCapability(input).reasonCode).toBe('capability.adapter_unsupported')
  })

  it('checks preset membership, reserved detail roles, and captured dispatch roster', () => {
    const input = fixture()
    input.explicit = { mode: 'role', targetId: 'artist' }
    input.config.presets!.studio!.roles = ['planner']
    expect(resolveFileCapability(input).reasonCode).toBe('capability.dispatch_not_allowed')
    input.config.presets!.studio!.roles = ['planner', 'artist']
    input.config.presets!.studio!.detailRole = 'artist'
    expect(resolveFileCapability(input).reasonCode).toBe('capability.dispatch_not_allowed')
    delete input.config.presets!.studio!.detailRole
    input.runtime!.dispatchRoster = { 'role-planner_01': [] }
    expect(resolveFileCapability(input).reasonCode).toBe('capability.dispatch_not_allowed')
  })

  it('enforces tool/spawn deny rules, allowed roles and approval requirements', () => {
    const input = fixture()
    input.explicit = { mode: 'role', targetId: 'artist' }
    input.config.roles!.planner!.permissions = { template: 'trusted', spawn: { allowedRoles: [] } }
    expect(resolveFileCapability(input).reasonCode).toBe('capability.permission_denied')
    input.config.roles!.planner!.permissions = { template: 'supervised' }
    expect(resolveFileCapability(input).availability).toBe('requires_approval')
    input.config.roles!.planner!.permissions = { template: 'trusted', tools: { spawn_role: 'deny' } }
    expect(resolveFileCapability(input).availability).toBe('unavailable')
    input.roleName = 'artist'
    input.explicit = { mode: 'tool', targetId: tool }
    input.config.roles!.artist!.permissions = { template: 'trusted', tools: { 'file_*': 'deny' } }
    expect(resolveFileCapability(input).reasonCode).toBe('capability.permission_denied')
    input.config.roles!.artist!.permissions = { template: 'trusted' }
    input.config.sense_groups!.drawing = [`${tool}:manual`]
    expect(resolveFileCapability(input).availability).toBe('requires_approval')
  })

  it('rejects same-operation delegation cycles, but permits different-operation cooperation', () => {
    const input = fixture()
    input.config.sense_groups!.drawing!.push('spawn_role')
    input.config.roles!.planner!.fileCapabilities = { 'image.generate': { mode: 'role', targetId: 'artist' } }
    input.config.roles!.artist!.fileCapabilities = { 'image.generate': { mode: 'role', targetId: 'planner' }, 'image.inspect': { mode: 'native' } }
    expect(resolveFileCapability(input).reasonCode).toBe('capability.delegation_cycle')
    input.config.roles!.artist!.fileCapabilities!['image.generate'] = { mode: 'tool', targetId: tool }
    input.config.roles!.artist!.fileCapabilities!['document.extract'] = { mode: 'role', targetId: 'planner' }
    expect(resolveFileCapability(input).availability).toBe('available')
    input.delegationPath = ['role-planner_01']
    expect(resolveFileCapability(input).reasonCode).toBe('capability.delegation_cycle')
    input.delegationPath = []
    input.maxDelegationDepth = 0
    expect(resolveFileCapability(input).reasonCode).toBe('capability.delegation_depth')
  })

  it('never selects a paid candidate by registration order', () => {
    const input = fixture()
    input.roleName = 'artist'
    delete input.config.roles!.artist!.fileCapabilities
    input.config.file_services!.second = { ...input.config.file_services!.drawing! }
    const second = buildFileServiceToolName('second', 'image.generate')
    input.config.sense_groups!.drawing!.push(second)
    input.runtime!.services!.second = { 'image.generate': { availability: 'available' } }
    const first = resolveFileCapability(input)
    expect(first).toMatchObject({ availability: 'selection_required', reasonCode: 'capability.selection_required' })
    input.config.file_services = Object.fromEntries(Object.entries(input.config.file_services!).reverse())
    expect(resolveFileCapability(input)).toEqual(first)
    input.explicit = { mode: 'tool', targetId: second }
    expect(resolveFileCapability(input).targetId).toBe(second)
  })

  it('requires structured operation mappings for custom tools and blocks unknown mappings', () => {
    const input = fixture()
    input.operation = 'document.extract'
    input.explicit = { mode: 'tool', targetId: 'extract_document' }
    input.config.sense_groups!.coordination!.push('extract_document')
    expect(resolveFileCapability(input).reasonCode).toBe('capability.tool_operation_missing')
    input.runtime!.tools = [{ name: 'extract_document', operations: { 'document.extract': { availability: 'unknown', reason: '传输方式未确认' } } }]
    expect(resolveFileCapability(input)).toMatchObject({ availability: 'unknown', reason: '传输方式未确认' })
    input.runtime!.tools[0]!.operations['document.extract'] = { availability: 'available', inputConstraints: { mimeTypes: ['application/pdf'], maxPages: 5 } }
    expect(resolveFileCapability(input)).toMatchObject({ availability: 'available', inputConstraints: { maxPages: 5 } })
  })

  it('fails closed on stable-tool-name collisions', () => {
    const input = fixture()
    input.roleName = 'artist'
    input.config.file_services!['same-id'] = { ...input.config.file_services!.drawing! }
    input.config.file_services!.same_id = { ...input.config.file_services!.drawing! }
    const collision = buildFileServiceToolName('same-id', 'image.generate')
    input.config.sense_groups!.drawing!.push(collision)
    input.explicit = { mode: 'tool', targetId: collision }
    expect(resolveFileCapability(input).reasonCode).toBe('capability.target_collision')
  })
})
